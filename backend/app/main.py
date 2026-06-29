"""Ailogy FastAPI 应用入口。

M0 阶段只提供 /health 与建库；后续里程碑在 routers/ 下挂载各路由。
静态资产（vendor 下的 mermaid/katex/version + 前端页面）由静态路由提供。
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .db import init_db

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_VENDOR = os.path.join(_REPO_ROOT, "vendor")
_FRONTEND = os.path.join(_REPO_ROOT, "frontend")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()  # 启动时建表 + FTS（幂等）
    yield


app = FastAPI(title="Ailogy", version="0.1.0", lifespan=lifespan)

# CORS：来源白名单来自 .env（带 cookie 不能用 *）
from .settings import CORS_ORIGINS, VERSION, REPO  # noqa: E402
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    """健康检查：探活 + 确认 DB 路径。"""
    from .db import DB_PATH
    return {"status": "ok", "db": DB_PATH}


# 路由挂载
from .routers import entries, auth, applications, keys, ingest, share  # noqa: E402
app.include_router(entries.router)
app.include_router(auth.router)
app.include_router(applications.router)
app.include_router(keys.router)
app.include_router(ingest.router)
app.include_router(share.router)


# 用户瀑布流页面（M1：暂直接服务 viewer 壳；M4 起按 /u/{handle} 注入用户标识）
from fastapi.responses import FileResponse  # noqa: E402


@app.get("/")
def viewer_index():
    """根路径返回瀑布流页面壳。"""
    return FileResponse(os.path.join(_FRONTEND, "viewer", "index.html"))


@app.get("/account")
def account_index():
    """账户页面（注册 / 登录 / 退出 / 个人信息）——与密钥分离。"""
    return FileResponse(os.path.join(_FRONTEND, "account", "index.html"))


@app.get("/platform")
def platform_index():
    """密钥页面（密钥管理 / 申请 / 审批）——需登录，未登录跳账户页。"""
    return FileResponse(os.path.join(_FRONTEND, "platform", "index.html"))


@app.get("/u/{handle}")
def user_viewer(handle: str):
    """用户瀑布流入口 /u/{handle}：返回同一 viewer 壳。

    实际展示的数据由登录会话决定（看自己）；handle 目前用于可读的入口地址，
    公开分享走 /?share=token。后续可扩展为按 handle 直接公开他人页面。
    """
    return FileResponse(os.path.join(_FRONTEND, "viewer", "index.html"))


@app.get("/settings")
def settings_index():
    """设置页面（主题等偏好，纯前端 localStorage）。"""
    return FileResponse(os.path.join(_FRONTEND, "settings", "index.html"))


@app.get("/about")
def about_index():
    """关于页面（版本 / GitHub / 更新检查）。"""
    return FileResponse(os.path.join(_FRONTEND, "about", "index.html"))


@app.get("/api/version")
def version():
    """版本信息（供关于页与更新检查）。"""
    return {"version": VERSION, "repo": REPO}


# viewer 的 css/js 相对路径（./css ./js）需能解析：把 viewer 目录挂在根静态
if os.path.isdir(os.path.join(_FRONTEND, "viewer")):
    app.mount("/css", StaticFiles(directory=os.path.join(_FRONTEND, "viewer", "css")), name="viewer-css")
    app.mount("/js", StaticFiles(directory=os.path.join(_FRONTEND, "viewer", "js")), name="viewer-js")
# 平台静态资源
if os.path.isdir(os.path.join(_FRONTEND, "platform")):
    app.mount("/platform-assets", StaticFiles(directory=os.path.join(_FRONTEND, "platform")), name="platform-assets")
# 账户页静态资源
if os.path.isdir(os.path.join(_FRONTEND, "account")):
    app.mount("/account-assets", StaticFiles(directory=os.path.join(_FRONTEND, "account")), name="account-assets")
# 设置 / 关于页静态资源
if os.path.isdir(os.path.join(_FRONTEND, "settings")):
    app.mount("/settings-assets", StaticFiles(directory=os.path.join(_FRONTEND, "settings")), name="settings-assets")
if os.path.isdir(os.path.join(_FRONTEND, "about")):
    app.mount("/about-assets", StaticFiles(directory=os.path.join(_FRONTEND, "about")), name="about-assets")


# 静态资产：vendor 下的 mermaid/katex/version 等（前端页面引用）
if os.path.isdir(_VENDOR):
    app.mount("/static/vendor", StaticFiles(directory=_VENDOR), name="vendor")
# 前端页面（viewer / platform / shared）——M1 起逐步填充
if os.path.isdir(_FRONTEND):
    app.mount("/static/frontend", StaticFiles(directory=_FRONTEND), name="frontend")
