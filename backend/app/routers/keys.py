"""API 密钥管理：列出（只显前缀）/ 自助新建（明文仅一次）/ 吊销。

用户登录后可直接自建密钥（与「审批发放」并存）；列表只暴露 prefix，绝不回显明文。
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from .. import models
from ..security import new_api_key
from ..deps import current_user

router = APIRouter(prefix="/api/keys", tags=["keys"])


class CreateKeyReq(BaseModel):
    label: str = ""


def _key_dict(k: models.ApiKey):
    return {"id": k.id, "prefix": k.prefix, "label": k.label, "revoked": k.revoked,
            "created_at": k.created_at.isoformat() if k.created_at else None,
            "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None}


@router.get("")
def list_keys(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(models.ApiKey).filter(models.ApiKey.user_id == user.id).order_by(
        models.ApiKey.created_at.desc()).all()
    return [_key_dict(k) for k in rows]


@router.post("")
def create_key(req: CreateKeyReq, user: models.User = Depends(current_user),
               db: Session = Depends(get_db)):
    """自助新建密钥，返回明文（仅此一次）。"""
    plain, prefix, key_hash = new_api_key()
    k = models.ApiKey(user_id=user.id, prefix=prefix, key_hash=key_hash, label=req.label or "自助创建")
    db.add(k); db.commit(); db.refresh(k)
    return {"key": _key_dict(k), "api_key": plain}


@router.delete("/{key_id}")
def revoke_key(key_id: int, user: models.User = Depends(current_user),
               db: Session = Depends(get_db)):
    """吊销密钥（归属校验：只能吊销自己的）。"""
    k = db.get(models.ApiKey, key_id)
    if not k or k.user_id != user.id:
        raise HTTPException(404, "密钥不存在")
    k.revoked = True
    db.commit()
    return {"ok": True, "id": key_id}
