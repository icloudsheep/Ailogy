"""index.html / data.js 渲染、资产软链、会话别名 aliases.js（CLI 本地离线模式）。

资产真源（template.html / mermaid.min.js / katex / version.js）都在仓库根的 vendor/ 下。
本模块位于 packages/ailog_cli/，故 _REPO_ROOT 向上跨两级、再进 vendor/。

数据走外部 JS 资产而非内联：file:// 下 <script src> 经典脚本不受 CORS 限制，
页面运行时自行读取 window.AILOG_DATA / AILOG_ALIASES，改别名只重写 aliases.js 即全局生效。
"""
import json
import os

# 本模块在 packages/ailog_cli/ 下，资产真源在仓库根的 vendor/
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_VENDOR = os.path.join(_REPO_ROOT, "vendor")

# 模板与资产随仓库分发，本地离线渲染时复用
TEMPLATE = os.path.join(_VENDOR, "template.html")
# mermaid 库本地副本：渲染时在 root 根建软链 ../mermaid.min.js 指向它，离线可用；缺失时模板回退 CDN。
MERMAID_SRC = os.path.join(_VENDOR, "mermaid.min.js")
# KaTeX 公式库本地副本目录（katex.min.js / katex.min.css / fonts/*.woff2）：同样软链，离线可用。
KATEX_SRC = os.path.join(_VENDOR, "katex")
# 版本信息文件 version.js（window.AILOG_VERSION=...）：版本真源，root 根建软链指向它。
VERSION_SRC = os.path.join(_VENDOR, "version.js")
# 各 JS 资产的全局变量名
DATA_JS_GLOBAL = "window.AILOG_DATA"
ALIASES_JS_GLOBAL = "window.AILOG_ALIASES"
VERSION_JS_GLOBAL = "window.AILOG_VERSION"


# ── 会话别名（aliases.json 真源 + aliases.js 资产，root 根跨所有日期共享） ──

def aliases_path(root):
    """会话别名底稿（数据真源，人读/可编辑）：root 下跨所有日期共享的 aliases.json。"""
    return os.path.join(root, "aliases.json")


def aliases_js_path(root):
    """别名的 JS 资产：root 下 aliases.js，被所有日期页面以 ../aliases.js 引用。"""
    return os.path.join(root, "aliases.js")


def load_aliases(root):
    """读 root 下的 aliases.json（{会话id: 自定义名}）；不存在/损坏返回空字典。"""
    p = aliases_path(root)
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def write_aliases_js(root):
    """据 aliases.json 写出 aliases.js（window.AILOG_ALIASES=...）。

    所有日期页面共享引用 ../aliases.js，故改别名只重写此一个文件即全局生效，
    无需重渲染任何 index.html。
    """
    al = load_aliases(root)
    payload = json.dumps(al, ensure_ascii=False)
    with open(aliases_js_path(root), "w", encoding="utf-8") as f:
        f.write(f"{ALIASES_JS_GLOBAL} = {payload};\n")


def save_alias(root, codename_id, alias):
    """把单个会话别名写入/删除 aliases.json 并同步刷新 aliases.js（alias 空则删除该项）。"""
    al = load_aliases(root)
    if alias:
        al[codename_id] = alias
    else:
        al.pop(codename_id, None)
    with open(aliases_path(root), "w", encoding="utf-8") as f:
        json.dump(al, f, ensure_ascii=False, indent=2)
    write_aliases_js(root)


# ── HTML / data.js 渲染与资产软链 ──

def render_html(day, html_path, root=None):
    """生成当天 index.html（纯静态模板）+ 同目录 data.js（当天数据），并刷新 root/aliases.js。

    数据走外部 JS 资产而非内联注入：file:// 下 <script src> 经典脚本不受 CORS 限制，
    页面运行时自行读取 window.AILOG_DATA / AILOG_ALIASES。改别名只需重写 aliases.js，
    所有日期页面刷新即生效，无需重渲染 HTML。模板缺失则跳过（仅留 data.json）。
    """
    if not os.path.exists(TEMPLATE):
        return False
    # 1) 当天数据资产 data.js（与 index.html 同目录）
    day_dir = os.path.dirname(html_path)
    payload = json.dumps(day, ensure_ascii=False)
    with open(os.path.join(day_dir, "data.js"), "w", encoding="utf-8") as f:
        f.write(f"{DATA_JS_GLOBAL} = {payload};\n")
    # 2) 静态模板原样写出（数据/别名由页面内 <script src> 自行加载）
    with open(TEMPLATE, "r", encoding="utf-8") as f:
        tpl = f.read()
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(tpl)
    # 3) 全局别名资产 aliases.js（root 根，所有日期共享 ../aliases.js）
    if root is not None:
        write_aliases_js(root)
        link_skill_assets(root)
    return True


def _symlink_force(src, dst):
    """在 dst 建/更新指向 src 的软链；src 不存在则跳过。已是正确软链则不动。"""
    if not os.path.exists(src):
        return
    try:
        if os.path.islink(dst):
            if os.path.realpath(dst) == os.path.realpath(src):
                return  # 已正确指向，无需重建
            os.unlink(dst)
        elif os.path.exists(dst):
            os.remove(dst)  # 旧的实体文件（历史拷贝），替换为软链
        os.symlink(src, dst)
    except OSError:
        # 软链失败（如不支持的文件系统）兜底为拷贝
        try:
            import shutil
            shutil.copyfile(src, dst)
        except OSError:
            pass


def link_skill_assets(root):
    """把 skill 中 git 受控的 version.js / mermaid.min.js / katex 在 root 根建软链。

    这样 git pull 更新 skill 后，软链目标内容随之更新，所有日期页面刷新即生效，
    无需重跑脚本或重渲染（版本号、mermaid 库、katex 库都跟着 git 走）。
    """
    _symlink_force(VERSION_SRC, os.path.join(root, "version.js"))
    _symlink_force(MERMAID_SRC, os.path.join(root, "mermaid.min.js"))
    _symlink_force(KATEX_SRC, os.path.join(root, "katex"))


def load_version():
    """读 skill 的 version.js，解析出 window.AILOG_VERSION 的 JSON 部分（供脚本回显）。"""
    fallback = {"version": "unknown", "repo": "", "check_url": ""}
    if not os.path.exists(VERSION_SRC):
        return fallback
    try:
        with open(VERSION_SRC, "r", encoding="utf-8") as f:
            txt = f.read()
        # 取首个 { 到末个 } 之间的 JSON 对象
        a, b = txt.find("{"), txt.rfind("}")
        if a >= 0 and b > a:
            data = json.loads(txt[a:b + 1])
            return data if isinstance(data, dict) else fallback
    except (json.JSONDecodeError, OSError):
        return fallback
    return fallback


def rerender_all_days(root):
    """重写 root 下所有日期目录的 data.js 与 index.html（模板升级时用）。

    日常改别名无需调用此函数（save_alias 已自动刷新 aliases.js 即全局生效）；
    仅当模板本身变化、需要把新模板铺到历史页面时才全量重渲染。
    """
    import re
    if not os.path.isdir(root):
        return 0
    n = 0
    for name in sorted(os.listdir(root)):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", name):
            continue
        data_path = os.path.join(root, name, "data.json")
        if not os.path.exists(data_path):
            continue
        try:
            with open(data_path, "r", encoding="utf-8") as f:
                day = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if render_html(day, os.path.join(root, name, "index.html"), root):
            n += 1
    return n
