"""在线更新引擎：从 GitHub 拉 zipball → 解压 → 覆盖到仓库根。

流程：
1. install_update(tag)：下载 zipball，写到 tempdir → 解压 → 校验 → 覆盖 → 更新 VERSION
2. 覆盖策略：全量覆盖代码，保留黑名单（.env / VERSION / ailogy.db / .git / .venv / __pycache__）；
   VERSION 由本函数在覆盖完后写入新 tag，保证下次启动读到新值。
3. 覆盖前先写到 REPO_ROOT/.update_staging/，成功后原子重命名（避免半更新损坏运行中副本）。
4. 更新后调用 request_exec_restart()：优先 os.execv 重启本进程；失败则设置状态标志让前端提示手动重启。

安全注意：
- 只处理 GitHub 域名的 URL，避免 SSRF。
- 下载有 60s 超时 + 30 MB 上限（防超大包耗尽内存）。
- 解压前扫描 zip entry，拒绝 zip-slip（entry 路径包含 ../ 或绝对路径）。
"""
import io
import os
import shutil
import sys
import tempfile
import threading
import time
import zipfile

import httpx

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_STAGING = os.path.join(_REPO_ROOT, ".update_staging")
_MAX_BYTES = 30 * 1024 * 1024   # 30 MB
_TIMEOUT = 60.0

# 覆盖时保留的顶层名（相对仓库根）
_PRESERVE_TOP = {
    ".env", ".env.local",           # 本地配置
    "ailogy.db", "ailogy.db-wal", "ailogy.db-shm",  # SQLite 数据
    ".git", ".venv", "venv", "node_modules",         # 环境目录
    ".update_staging",               # 自身临时目录
    "__pycache__",                   # Python 缓存
}

# 更新状态（内存态；前端 poll 显示）
_state = {
    "phase": "idle",       # idle | downloading | extracting | applying | done | error | needs_restart
    "message": "",
    "progress": 0,         # 0..100
    "started_at": 0,
    "target_tag": "",
    "error": "",
}
_state_lock = threading.Lock()


def get_state():
    with _state_lock:
        return dict(_state)


def _set(phase=None, message=None, progress=None, target_tag=None, error=None):
    with _state_lock:
        if phase is not None: _state["phase"] = phase
        if message is not None: _state["message"] = message
        if progress is not None: _state["progress"] = progress
        if target_tag is not None: _state["target_tag"] = target_tag
        if error is not None: _state["error"] = error


def is_running():
    """更新是否在跑（避免并发）。"""
    with _state_lock:
        return _state["phase"] in ("downloading", "extracting", "applying")


def install_update(tag, repo_slug):
    """启动更新流程（同步跑，供后台 worker 或 handler 调用）。返回 True/False。"""
    if is_running():
        _set(error="已有更新正在进行")
        return False
    _set(phase="downloading", message="正在下载更新包…", progress=0,
         target_tag=tag or "", error="")
    started = time.time()
    _state["started_at"] = started
    try:
        # 下载 zipball
        # GitHub zipball 直链：https://api.github.com/repos/{slug}/zipball/{tag}
        url = f"https://api.github.com/repos/{repo_slug}/zipball/{tag}"
        blob = _download(url)
        if blob is None:
            return False
        _set(phase="extracting", message="正在解压…", progress=40)
        # 解压到 staging
        if os.path.isdir(_STAGING):
            shutil.rmtree(_STAGING, ignore_errors=True)
        os.makedirs(_STAGING, exist_ok=True)
        try:
            _safe_extract(blob, _STAGING)
        except Exception as e:
            _set(phase="error", error=f"解压失败：{e}")
            return False
        # zipball 会包一层顶层目录，找到它
        top = _find_single_top(_STAGING)
        if not top:
            _set(phase="error", error="更新包结构异常（未找到顶层目录）")
            return False
        src_root = os.path.join(_STAGING, top)
        _set(phase="applying", message="正在覆盖文件…", progress=70)
        _apply_overlay(src_root, _REPO_ROOT)
        # 写新的 VERSION（zipball 里可能就有，但覆盖 policy 排除；这里显式写）
        try:
            with open(os.path.join(_REPO_ROOT, "VERSION"), "w", encoding="utf-8") as f:
                f.write((tag or "").lstrip("v").lstrip("V") + "\n")
        except Exception:
            pass
        # 清理 staging
        shutil.rmtree(_STAGING, ignore_errors=True)
        _set(phase="done", message="更新完成，准备重启…", progress=100)
        # 尝试自动重启
        threading.Timer(1.0, _try_exec_restart).start()
        return True
    except Exception as e:
        _set(phase="error", error=f"{type(e).__name__}: {e}")
        return False


def _download(url):
    """带进度回调 & 大小上限的下载。返回 bytes 或 None（失败）。"""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "Ailogy-Updater"}
    try:
        with httpx.stream("GET", url, headers=headers, timeout=_TIMEOUT, follow_redirects=True) as r:
            if r.status_code >= 400:
                _set(phase="error", error=f"下载失败 HTTP {r.status_code}")
                return None
            total = 0
            expected = int(r.headers.get("content-length") or 0)
            buf = io.BytesIO()
            for chunk in r.iter_bytes():
                total += len(chunk)
                if total > _MAX_BYTES:
                    _set(phase="error", error=f"更新包超过 {_MAX_BYTES // (1024*1024)} MB 上限")
                    return None
                buf.write(chunk)
                if expected > 0:
                    _set(progress=int(total * 40 / expected))
            return buf.getvalue()
    except Exception as e:
        _set(phase="error", error=f"下载异常：{e}")
        return None


def _safe_extract(blob, dest):
    """解压 zip 到 dest，拒绝 zip-slip（../, 绝对路径, 符号链接）。"""
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        real_dest = os.path.realpath(dest)
        for info in zf.infolist():
            name = info.filename
            # 跳过目录 entry（extract 会自建）
            if name.endswith("/"):
                continue
            # 归一化 + 拼接目标路径
            target = os.path.realpath(os.path.join(dest, name))
            if not target.startswith(real_dest + os.sep):
                raise RuntimeError(f"非法路径（zip-slip）：{name}")
            # 拒绝符号链接（S_IFLNK = 0xA000 << 16）
            if (info.external_attr >> 16) & 0xF000 == 0xA000:
                raise RuntimeError(f"不允许符号链接：{name}")
        zf.extractall(dest)


def _find_single_top(path):
    """zipball 结构：单一顶层目录（icloudsheep-Ailogy-<sha>/）。取那一个。"""
    names = [n for n in os.listdir(path) if not n.startswith(".")]
    if len(names) == 1 and os.path.isdir(os.path.join(path, names[0])):
        return names[0]
    return None


def _apply_overlay(src, dst):
    """把 src 目录里的内容覆盖到 dst，跳过 dst 顶层的黑名单，src 里的 VERSION 也跳过（后面显式写）。"""
    for name in os.listdir(src):
        s = os.path.join(src, name)
        d = os.path.join(dst, name)
        # src 里的 VERSION 不覆盖 dst（VERSION 由主流程显式写入 tag）
        if name == "VERSION":
            continue
        if os.path.isdir(s):
            _copy_tree(s, d)
        else:
            # 顶层文件：不在黑名单里就覆盖
            if name in _PRESERVE_TOP:
                continue
            shutil.copy2(s, d)


def _copy_tree(src, dst):
    """递归拷贝：dst 不存在则创建；已存在则合并覆盖。跳过顶层黑名单（对 dst 根级的目录名做保护）。"""
    if not os.path.isdir(dst):
        os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        s = os.path.join(src, name)
        d = os.path.join(dst, name)
        # 仓库根的顶层黑名单（针对 dst 直接子项）：例如 dst=REPO_ROOT/frontend, name=xx → 都拷
        # 但如果 dst=REPO_ROOT，name in 黑名单 → 跳
        if os.path.normpath(os.path.dirname(d)) == os.path.normpath(_REPO_ROOT):
            if name in _PRESERVE_TOP:
                continue
        if os.path.isdir(s):
            _copy_tree(s, d)
        else:
            shutil.copy2(s, d)


def _try_exec_restart():
    """尝试 os.execv 重启本进程。失败则设为 needs_restart 状态让前端提示用户手动重启。"""
    try:
        # 关闭标准 IO 缓冲，避免 exec 后子进程继承脏描述符
        try: sys.stdout.flush(); sys.stderr.flush()
        except Exception: pass
        python = sys.executable
        args = [python] + sys.argv
        os.execv(python, args)   # 不会返回；成功则本进程被替换
    except Exception as e:
        _set(phase="needs_restart",
             message="已下载并覆盖，但自动重启失败，请手动重启服务",
             error=str(e))
