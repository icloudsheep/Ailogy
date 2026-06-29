"""账号路由：注册 / 登录 / 登出 / me。

会话用服务端 sessions 表 + httponly cookie（可撤销、可过期）。
首个注册用户自动成为管理员（本地自托管的最简初始化方案）。
"""
import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, Request
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy.orm import Session

from ..db import get_db
from .. import models
from ..security import hash_password, verify_password, new_token
from ..deps import current_user, SESSION_COOKIE

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_DAYS = 30


class RegisterReq(BaseModel):
    email: EmailStr
    password: str
    handle: str = ""

    @field_validator("password")
    @classmethod
    def _pw_len(cls, v):
        if len(v) < 8:
            raise ValueError("密码至少 8 位")
        return v


class LoginReq(BaseModel):
    email: EmailStr
    password: str


def _derive_handle(email: str, given: str) -> str:
    """handle 用于 /u/{handle} 路由：优先用户指定，否则取邮箱本地段，清洗为 [a-z0-9_-]。"""
    base = (given or email.split("@")[0]).lower()
    base = re.sub(r"[^a-z0-9_-]", "", base) or "user"
    return base[:64]


def _issue_session(db: Session, user: models.User, resp: Response):
    """建会话行 + 下发 httponly cookie。"""
    sid = new_token()
    sess = models.Session(id=sid, user_id=user.id,
                          expires_at=datetime.utcnow() + timedelta(days=SESSION_DAYS))
    db.add(sess); db.commit()
    resp.set_cookie(SESSION_COOKIE, sid, httponly=True, samesite="lax",
                    max_age=SESSION_DAYS * 86400)  # 本地 http：secure=False；上线 https 置 True


@router.post("/register")
def register(req: RegisterReq, resp: Response, db: Session = Depends(get_db)):
    if db.query(models.User).filter(models.User.email == req.email).first():
        raise HTTPException(409, "该邮箱已注册")
    handle = _derive_handle(req.email, req.handle)
    if db.query(models.User).filter(models.User.handle == handle).first():
        raise HTTPException(409, f"用户名 {handle} 已被占用，请改用其他 handle")
    is_admin = db.query(models.User).count() == 0  # 首个用户为管理员
    user = models.User(email=req.email, password_hash=hash_password(req.password),
                       handle=handle, is_admin=is_admin)
    db.add(user); db.commit(); db.refresh(user)
    _issue_session(db, user, resp)
    return {"id": user.id, "email": user.email, "handle": user.handle, "is_admin": user.is_admin}


@router.post("/login")
def login(req: LoginReq, resp: Response, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == req.email).first()
    if not user or not verify_password(user.password_hash, req.password):
        raise HTTPException(401, "邮箱或密码错误")  # 不区分二者，防账号枚举
    _issue_session(db, user, resp)
    return {"id": user.id, "email": user.email, "handle": user.handle, "is_admin": user.is_admin}


@router.post("/logout")
def logout(request: Request, resp: Response, db: Session = Depends(get_db)):
    """撤销当前会话：删服务端 session 行 + 清 cookie（幂等，未登录也返回 ok）。"""
    sid = request.cookies.get(SESSION_COOKIE)
    if sid:
        sess = db.get(models.Session, sid)
        if sess:
            db.delete(sess); db.commit()
    resp.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@router.get("/me")
def me(user: models.User = Depends(current_user)):
    return {"id": user.id, "email": user.email, "handle": user.handle, "is_admin": user.is_admin}
