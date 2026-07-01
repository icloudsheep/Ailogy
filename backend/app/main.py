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
    yield


app = FastAPI(title="Ailogy", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    from .db import DB_PATH
    return {"status": "ok", "db": DB_PATH}


from .routers import entries, ingest  # noqa: E402
app.include_router(entries.router)
app.include_router(ingest.router)


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


@app.get("/api/version")
def version():
    from .settings import VERSION, REPO  # noqa: E402
    return {"version": VERSION, "repo": REPO}


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
