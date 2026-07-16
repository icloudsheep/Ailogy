"""Ailogy FastAPI 应用入口。

本地单用户部署：静态页面 + entries 读/写 API，无鉴权。
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .db import init_db

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_VENDOR = os.path.join(_REPO_ROOT, "vendor")
_FRONTEND = os.path.join(_REPO_ROOT, "frontend")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    from . import ai_worker
    ai_worker.start(_app)     # 启动 AI 后台 worker（消费 ai_queue）
    # 自动更新后台任务：每 6 小时检查一次 GitHub releases，若 has_update 且开关开启则安装
    _stop_auto = _start_auto_updater()
    try:
        yield
    finally:
        _stop_auto()
        await ai_worker.stop()


def _start_auto_updater():
    """独立线程 + Event 做可停止的 6h 定时任务。返回 stop 函数供 lifespan finally 调用。"""
    import threading as _th
    stop_ev = _th.Event()

    def loop():
        # 启动后 60s 首次检查，之后每 6h 一次
        first = True
        while not stop_ev.is_set():
            stop_ev.wait(60 if first else 6 * 3600)
            first = False
            if stop_ev.is_set(): break
            try:
                _auto_check_and_install()
            except Exception:
                pass

    t = _th.Thread(target=loop, daemon=True); t.start()
    return lambda: stop_ev.set()


def _auto_check_and_install():
    """开关开启且 has_update 时触发一次安装。updater 内部有 is_running 防并发。"""
    if not _autoupdate_enabled():
        return
    data = updates()
    if not data.get("has_update"):
        return
    tag = (data.get("latest") or {}).get("tag")
    if not tag:
        return
    from . import updater
    from .settings import REPO  # noqa: E402
    if updater.is_running():
        return
    repo_slug = REPO.rstrip("/").replace("https://github.com/", "").replace("http://github.com/", "")
    updater.install_update(tag, repo_slug)


app = FastAPI(title="Ailogy", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    from .db import DB_PATH
    return {"status": "ok", "db": DB_PATH}


from .routers import entries, ingest, ai  # noqa: E402
app.include_router(entries.router)
app.include_router(ingest.router)
app.include_router(ai.router)


from fastapi.responses import FileResponse  # noqa: E402


@app.get("/")
def viewer_index():
    return FileResponse(os.path.join(_FRONTEND, "viewer", "index.html"))


@app.get("/settings")
def settings_index():
    return FileResponse(os.path.join(_FRONTEND, "settings", "index.html"))


@app.get("/about")
def about_index():
    return FileResponse(os.path.join(_FRONTEND, "about", "index.html"))


@app.get("/ai")
def ai_index():
    return FileResponse(os.path.join(_FRONTEND, "ai", "index.html"))


@app.get("/api/version")
def version():
    from .settings import VERSION, REPO  # noqa: E402
    return {"version": VERSION, "repo": REPO}


# GitHub releases 代理：避开浏览器 CORS + 复用后端 IP 的 60 次/小时无鉴权额度。
# 简单内存缓存 15 分钟，减少 API 调用；离线/失败时返回 stale=True 供前端友好展示。
# Release 列表缓存：15 分钟太长——刚发布新 release 想立即在服务器看到需要等，
# 60 秒足以扛住前端反复轮询（updates.js 每次 renderHeader 都会 fetch 一次），
# 又不至于让 GitHub API 感受到压力（authenticated=5000 req/h、匿名=60 req/h，
# 每分钟 1 次远低于阈值）。
_RELEASE_CACHE = {"ts": 0, "data": None, "err": None}
_RELEASE_TTL_S = 60


# 自动更新偏好键 & 默认值
_AUTOUPDATE_PREF_KEY = "ailogy:auto_update"


def _autoupdate_enabled():
    """读 prefs.ailogy:auto_update，缺省=开启（用户要求默认开）。"""
    try:
        from .db import SessionLocal
        from . import repo as _repo
        db = SessionLocal()
        try:
            v = _repo.get_pref(db, _AUTOUPDATE_PREF_KEY)
            if v is None or v == "":
                return True
            return v.strip().lower() not in ("0", "false", "off", "no")
        finally:
            db.close()
    except Exception:
        return True


@app.get("/api/updates")
def updates():
    """返回本地版本 + latest release + 是否有新版可用。
    响应：{ current, latest, has_update, releases: [ {tag, name, body, url, published_at, prerelease, draft} ] }
    - 无 release / 网络失败：latest=None, has_update=False, error 字段说明
    - has_update 判据：本地版本字符串是否等于 latest.tag（去 v 前缀比对）
    """
    import time as _t
    from . import net as _net
    from .settings import VERSION, REPO  # noqa: E402

    now = _t.time()
    if _RELEASE_CACHE["data"] is not None and (now - _RELEASE_CACHE["ts"]) < _RELEASE_TTL_S:
        cached = _RELEASE_CACHE["data"]
    else:
        # 解析 REPO → owner/repo
        repo_slug = REPO.rstrip("/").replace("https://github.com/", "").replace("http://github.com/", "")
        url = f"https://api.github.com/repos/{repo_slug}/releases?per_page=10"
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "Ailogy"}
        try:
            r = _net.get(url, purpose="github", headers=headers, timeout=6.0, follow_redirects=True)
            if r.status_code == 200:
                releases = []
                for it in (r.json() or []):
                    releases.append({
                        "tag": it.get("tag_name") or "",
                        "name": it.get("name") or "",
                        "body": it.get("body") or "",
                        "url": it.get("html_url") or "",
                        "published_at": it.get("published_at") or "",
                        "prerelease": bool(it.get("prerelease")),
                        "draft": bool(it.get("draft")),
                    })
                cached = {"releases": releases, "err": None}
            else:
                cached = {"releases": [], "err": f"GitHub HTTP {r.status_code}"}
        except Exception as e:
            cached = {"releases": [], "err": f"{type(e).__name__}: {e}"}
        _RELEASE_CACHE["ts"] = now
        _RELEASE_CACHE["data"] = cached

    releases = cached.get("releases") or []
    # 挑最新一个 non-draft 作为 latest（首选非 prerelease；全都是 prerelease 时取最新）
    stable = [r for r in releases if not r["draft"] and not r["prerelease"]]
    latest = (stable[0] if stable else (releases[0] if releases else None))

    def _normalize(v):
        if not v: return ""
        return v.lstrip("v").lstrip("V").strip()

    cur = _normalize(VERSION)
    lat = _normalize(latest["tag"]) if latest else ""
    has_update = bool(lat) and lat != cur
    return {
        "current": VERSION,
        "latest": latest,
        "has_update": has_update,
        "releases": releases,
        "error": cached.get("err"),
        "auto_update": _autoupdate_enabled(),
    }


# ═════════ 自动更新：开关 GET/PUT + 触发安装 POST + 状态 GET ═════════
from fastapi import Body  # noqa: E402


@app.get("/api/updates/settings")
def updates_settings_get():
    return {"auto_update": _autoupdate_enabled()}


@app.put("/api/updates/settings")
def updates_settings_put(body: dict = Body(...)):
    from .db import SessionLocal
    from . import repo as _repo
    val = "1" if body.get("auto_update") else "0"
    db = SessionLocal()
    try:
        _repo.set_pref(db, _AUTOUPDATE_PREF_KEY, val)
        db.commit()
    finally:
        db.close()
    return {"ok": True, "auto_update": val == "1"}


@app.post("/api/updates/install")
def updates_install(body: dict = Body(default={})):
    """触发一次更新安装。body: {tag?}（省略=用 latest）。"""
    from . import updater
    from .settings import REPO  # noqa: E402
    if updater.is_running():
        return {"ok": False, "error": "已有更新在进行"}
    # 拉一次最新信息（缓存 15 分钟）取 tag
    data = updates()
    if not data.get("has_update"):
        return {"ok": False, "error": "当前已是最新版本"}
    tag = body.get("tag") or (data["latest"] or {}).get("tag")
    if not tag:
        return {"ok": False, "error": "未找到目标版本"}
    repo_slug = REPO.rstrip("/").replace("https://github.com/", "").replace("http://github.com/", "")
    # 后台跑，不阻塞 HTTP
    import threading as _th
    _th.Thread(target=updater.install_update, args=(tag, repo_slug), daemon=True).start()
    return {"ok": True, "target": tag}


@app.get("/api/updates/status")
def updates_status():
    from . import updater
    return updater.get_state()


# ═════════ 代理配置：读/写 + 联通性测试 ═════════
# 两通道独立配置：model（LLM 出站）/ github（Release 检查 & 下载）。
# 未配置时保持 trust_env=True 的老行为，兼容既有 systemd 环境变量部署。

@app.get("/api/proxy/config")
def proxy_config_get():
    from . import net
    from .db import SessionLocal
    db = SessionLocal()
    try:
        return net.get_config_masked(db)
    finally:
        db.close()


@app.put("/api/proxy/config")
def proxy_config_put(body: dict = Body(...)):
    from . import net
    from .db import SessionLocal
    db = SessionLocal()
    try:
        return net.save_config(db, body or {})
    finally:
        db.close()


@app.post("/api/proxy/test")
def proxy_test(body: dict = Body(default={})):
    """探测 generate_204。body: {purpose: "model" | "github"}（默认两个都跑）。
    返回 {model: {...}, github: {...}}。"""
    from . import net
    from .db import SessionLocal
    purpose = (body.get("purpose") or "").strip()
    which = [purpose] if purpose in ("model", "github") else ["model", "github"]
    db = SessionLocal()
    try:
        return {p: net.probe(db, p) for p in which}
    finally:
        db.close()


# viewer 的 css/js 相对路径
if os.path.isdir(os.path.join(_FRONTEND, "viewer")):
    app.mount("/css", StaticFiles(directory=os.path.join(_FRONTEND, "viewer", "css")), name="viewer-css")
    app.mount("/js", StaticFiles(directory=os.path.join(_FRONTEND, "viewer", "js")), name="viewer-js")
if os.path.isdir(os.path.join(_FRONTEND, "settings")):
    app.mount("/settings-assets", StaticFiles(directory=os.path.join(_FRONTEND, "settings")), name="settings-assets")
if os.path.isdir(os.path.join(_FRONTEND, "about")):
    app.mount("/about-assets", StaticFiles(directory=os.path.join(_FRONTEND, "about")), name="about-assets")
if os.path.isdir(_VENDOR):
    app.mount("/static/vendor", StaticFiles(directory=_VENDOR), name="vendor")
if os.path.isdir(_FRONTEND):
    app.mount("/static/frontend", StaticFiles(directory=_FRONTEND), name="frontend")
