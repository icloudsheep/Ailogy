"""鉴权依赖：会话 cookie → 用户、管理员校验、API Key → 用户。

三种入口对应计划里的 👤会话 / 🛡管理员 / 🔑API Key。
M2 接 auth/applications/keys；ingest 与读写鉴权在 M3/M4 接入。
"""
from datetime import datetime

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from . import models
from .security import hash_api_key

SESSION_COOKIE = "ailogy_session"


def current_user(request: Request, db: Session = Depends(get_db)) -> models.User:
    """从会话 cookie 解析当前登录用户；无效/过期则 401。"""
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        raise HTTPException(401, "未登录")
    sess = db.get(models.Session, sid)
    if not sess or sess.expires_at < datetime.utcnow():
        raise HTTPException(401, "会话无效或已过期")
    user = db.get(models.User, sess.user_id)
    if not user:
        raise HTTPException(401, "用户不存在")
    return user


def require_admin(user: models.User = Depends(current_user)) -> models.User:
    """要求当前用户是管理员，否则 403。"""
    if not user.is_admin:
        raise HTTPException(403, "需要管理员权限")
    return user


def api_key_user(request: Request, db: Session = Depends(get_db)) -> models.User:
    """从 Authorization: Bearer <key> 解析用户（CLI 上报用）；无效则 401。"""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "缺少 API Key")
    plain = auth[7:].strip()
    key_hash = hash_api_key(plain)
    row = db.query(models.ApiKey).filter(
        models.ApiKey.key_hash == key_hash, models.ApiKey.revoked == False  # noqa: E712
    ).first()
    if not row:
        raise HTTPException(401, "API Key 无效或已吊销")
    row.last_used_at = datetime.utcnow()
    db.commit()
    user = db.get(models.User, row.user_id)
    if not user:
        raise HTTPException(401, "用户不存在")
    return user
