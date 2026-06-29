"""CLI 上报入口：带 API Key 的日志写入 / 编辑 / 删除。

鉴权走 api_key_user（Bearer）；按 (user_id, client_id=day#seq) 幂等 upsert，
重复上报覆盖而非重复插入。体积上限在路由层挡（防把库撑爆）。
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..db import get_db
from .. import models, repo
from ..deps import api_key_user
from ..cursor import decode_cursor  # noqa: F401  (预留)
from ailog_core.schema import Entry

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

MAX_SUMMARY = 256 * 1024     # 单条正文上限 256KB
MAX_BATCH = 200              # 单次批量条数上限


def _check_size(e: Entry):
    if e.summary and len(e.summary.encode("utf-8")) > MAX_SUMMARY:
        raise HTTPException(413, "summary 过大（上限 256KB）")


@router.post("/entries")
async def ingest_entries(request: Request, user: models.User = Depends(api_key_user),
                         db: Session = Depends(get_db)):
    """接收单条或批量 entry，幂等 upsert 到该用户名下。

    请求体可为单个 entry 对象或 entry 数组。返回写入条数。
    """
    payload = await request.json()
    items = payload if isinstance(payload, list) else [payload]
    if len(items) > MAX_BATCH:
        raise HTTPException(413, f"单次最多上报 {MAX_BATCH} 条")
    n = 0
    for raw in items:
        try:
            e = Entry(**raw)
        except Exception as ex:
            raise HTTPException(422, f"条目格式错误：{ex}")
        _check_size(e)
        repo.upsert_entry(db, user.id, e)
        n += 1
    db.commit()
    return {"ok": True, "count": n}


@router.delete("/entries/{day}/{seq}")
def ingest_delete(day: str, seq: int, user: models.User = Depends(api_key_user),
                  db: Session = Depends(get_db)):
    """按 day#seq 删除该用户的一条（与本地 --delete 对齐）。"""
    from sqlalchemy import text
    client_id = f"{day}#{seq}"
    r = db.execute(text(
        "DELETE FROM entries WHERE user_id = :uid AND client_id = :cid"
    ), {"uid": user.id, "cid": client_id})
    db.commit()
    return {"ok": True, "deleted": r.rowcount}
