"""API 密钥管理：列出（含明文，随时可复制）/ 自助新建 / 吊销。

安全取舍：个人自托管，明文存库（secret 列）并在列表返回，以便页面随时复制。
"""
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


def _key_dict(k: models.ApiKey, with_secret=True):
    d = {"id": k.id, "prefix": k.prefix, "label": k.label, "revoked": k.revoked,
         "created_at": k.created_at.isoformat() if k.created_at else None,
         "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None}
    if with_secret:
        d["secret"] = k.secret  # 明文，供页面随时复制（个人自托管的有意取舍）
    return d


@router.get("")
def list_keys(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    """列出自己的密钥，含明文 secret（随时可复制）。"""
    rows = db.query(models.ApiKey).filter(models.ApiKey.user_id == user.id).order_by(
        models.ApiKey.created_at.desc()).all()
    return [_key_dict(k) for k in rows]


@router.post("")
def create_key(req: CreateKeyReq, user: models.User = Depends(current_user),
               db: Session = Depends(get_db)):
    """自助新建密钥，明文入库（secret）并返回。"""
    plain, prefix, key_hash = new_api_key()
    k = models.ApiKey(user_id=user.id, prefix=prefix, key_hash=key_hash,
                      secret=plain, label=req.label or "自助创建")
    db.add(k); db.commit(); db.refresh(k)
    return {"key": _key_dict(k), "api_key": plain}


@router.delete("/{key_id}")
def revoke_key(key_id: int, user: models.User = Depends(current_user),
               db: Session = Depends(get_db)):
    """删除密钥（不可逆，归属校验：只能删自己的）。"""
    k = db.get(models.ApiKey, key_id)
    if not k or k.user_id != user.id:
        raise HTTPException(404, "密钥不存在")
    db.delete(k)  # 直接删除，不可逆
    db.commit()
    return {"ok": True, "id": key_id}
