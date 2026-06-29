"""密钥申请与审批：用户提交申请，管理员批准（发密钥）/ 拒绝。

状态机：pending →approve→ approved / →reject→ rejected（rejected 可重新申请）。
一个用户同时只允许一条 pending。approve 在事务内改状态 + 建密钥 + 返回明文（仅一次）。
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from .. import models
from ..security import new_api_key
from ..deps import current_user, require_admin

router = APIRouter(prefix="/api", tags=["applications"])


class ApplyReq(BaseModel):
    reason: str = ""


class ReviewReq(BaseModel):
    note: str = ""


def _app_dict(a: models.KeyApplication):
    return {"id": a.id, "user_id": a.user_id, "status": a.status, "reason": a.reason,
            "review_note": a.review_note,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "reviewed_at": a.reviewed_at.isoformat() if a.reviewed_at else None}


@router.post("/applications")
def apply(req: ApplyReq, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    """提交密钥申请。已有 pending 时拒绝重复提交。"""
    exists = db.query(models.KeyApplication).filter(
        models.KeyApplication.user_id == user.id,
        models.KeyApplication.status == "pending").first()
    if exists:
        raise HTTPException(409, "你已有一条待审批的申请")
    a = models.KeyApplication(user_id=user.id, status="pending", reason=req.reason)
    db.add(a); db.commit(); db.refresh(a)
    return _app_dict(a)


@router.get("/applications/mine")
def my_applications(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(models.KeyApplication).filter(
        models.KeyApplication.user_id == user.id).order_by(
        models.KeyApplication.created_at.desc()).all()
    return [_app_dict(a) for a in rows]


@router.get("/admin/applications")
def list_applications(status: str = "pending", _admin=Depends(require_admin),
                      db: Session = Depends(get_db)):
    rows = db.query(models.KeyApplication).filter(
        models.KeyApplication.status == status).order_by(
        models.KeyApplication.created_at.asc()).all()
    return [_app_dict(a) for a in rows]


@router.post("/admin/applications/{app_id}/approve")
def approve(app_id: int, req: ReviewReq, admin=Depends(require_admin),
            db: Session = Depends(get_db)):
    """批准：事务内改状态 + 建密钥，返回明文密钥（仅此一次）。"""
    a = db.get(models.KeyApplication, app_id)
    if not a:
        raise HTTPException(404, "申请不存在")
    if a.status != "pending":
        raise HTTPException(409, f"申请已是 {a.status} 状态")
    plain, prefix, key_hash = new_api_key()
    a.status = "approved"; a.reviewed_by = admin.id; a.review_note = req.note
    a.reviewed_at = datetime.utcnow()
    key = models.ApiKey(user_id=a.user_id, prefix=prefix, key_hash=key_hash,
                        secret=plain, label="审批发放")
    db.add(key); db.commit()
    # 明文仅返回一次，库里只存哈希
    return {"application": _app_dict(a), "api_key": plain, "prefix": prefix}


@router.post("/admin/applications/{app_id}/reject")
def reject(app_id: int, req: ReviewReq, admin=Depends(require_admin),
           db: Session = Depends(get_db)):
    a = db.get(models.KeyApplication, app_id)
    if not a:
        raise HTTPException(404, "申请不存在")
    if a.status != "pending":
        raise HTTPException(409, f"申请已是 {a.status} 状态")
    if not req.note.strip():
        raise HTTPException(400, "拒绝必须填写理由")
    a.status = "rejected"; a.reviewed_by = admin.id; a.review_note = req.note
    a.reviewed_at = datetime.utcnow()
    db.commit()
    return _app_dict(a)
