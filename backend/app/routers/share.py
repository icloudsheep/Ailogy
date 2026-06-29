"""可见性与公开分享：用户逐 scope 设公开/私有并生成分享 token；公开端点只读匿名访问。

scope ∈ {'all', 'day:YYYY-MM-DD', 'session:<code>'}。缺记录视为私有；公开是显式动作。
公开端点按 share_token 反查 (user_id, scope)，只返回该 scope 内的条目，匿名只读。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from .. import models, repo
from ..security import new_token

router = APIRouter(prefix="/api", tags=["share"])

_SCOPE_OK = ("all",)  # 加前缀的 day:/session: 单独校验


class VisibilityReq(BaseModel):
    scope: str
    is_public: bool

    @field_validator("scope")
    @classmethod
    def _scope_valid(cls, v):
        if v == "all" or v.startswith("day:") or v.startswith("session:"):
            return v
        raise ValueError("scope 须为 all / day:YYYY-MM-DD / session:<code>")


@router.put("/visibility")
def set_visibility(req: VisibilityReq, user: models.User = Depends(current_user),
                   db: Session = Depends(get_db)):
    """设置某 scope 公开/私有。公开时生成（或复用）分享 token，私有时清除 token。"""
    pv = db.query(models.PageVisibility).filter(
        models.PageVisibility.user_id == user.id,
        models.PageVisibility.scope == req.scope).first()
    if not pv:
        pv = models.PageVisibility(user_id=user.id, scope=req.scope)
        db.add(pv)
    pv.is_public = req.is_public
    if req.is_public:
        pv.share_token = pv.share_token or new_token(24)
    else:
        pv.share_token = None  # 转私有立即吊销旧链接
    db.commit()
    return {"scope": pv.scope, "is_public": pv.is_public, "share_token": pv.share_token}


@router.get("/visibility")
def list_visibility(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(models.PageVisibility).filter(
        models.PageVisibility.user_id == user.id).all()
    return [{"scope": r.scope, "is_public": r.is_public, "share_token": r.share_token} for r in rows]


def _resolve_share(db, token):
    """按分享 token 反查公开的 (user_id, scope)；无效/已转私 → None。"""
    pv = db.query(models.PageVisibility).filter(
        models.PageVisibility.share_token == token,
        models.PageVisibility.is_public == True).first()  # noqa: E712
    return pv


@router.get("/public/{token}/entries")
def public_entries(token: str, cursor: str = Query(None), limit: int = Query(50, ge=1, le=100),
                   db: Session = Depends(get_db)):
    """公开只读：按分享 token 取对应 scope 的条目（匿名）。

    scope=all → 该用户全部；day:X → 仅当天；session:C → 仅该会话。
    """
    pv = _resolve_share(db, token)
    if not pv:
        raise HTTPException(404, "分享链接无效或已关闭")
    if pv.scope == "all":
        items, nxt = repo.list_entries(db, pv.user_id, cursor, limit)
    elif pv.scope.startswith("session:"):
        items, nxt = repo.list_session_entries(db, pv.user_id, pv.scope[8:], cursor, limit)
    elif pv.scope.startswith("day:"):
        # 按日期：复用全量流，前端只展示该天；这里直接过滤到该 day（小范围）
        items, nxt = repo.list_entries(db, pv.user_id, cursor, limit)
        day = pv.scope[4:]
        items = [e for e in items if e.get("day") == day]
    else:
        raise HTTPException(400, "不支持的 scope")
    return {"items": items, "next_cursor": nxt, "scope": pv.scope}
