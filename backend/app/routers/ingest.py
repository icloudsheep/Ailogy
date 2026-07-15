"""CLI 上报入口：日志写入 / 编辑 / 删除。

无鉴权——本地单用户部署，直接访问。
按 client_id=day#seq 幂等 upsert，重复上报覆盖而非重复插入。
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..db import get_db
from .. import repo
from ailog_core.schema import Entry

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

MAX_SUMMARY = 256 * 1024
MAX_BATCH = 200


def _check_size(e: Entry):
    if e.summary and len(e.summary.encode("utf-8")) > MAX_SUMMARY:
        raise HTTPException(413, "summary 过大（上限 256KB）")


@router.post("/entries")
async def ingest_entries(request: Request, db: Session = Depends(get_db)):
    """接收单条或批量 entry，幂等 upsert。"""
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
        repo.upsert_entry(db, e)
        n += 1
    db.commit()
    _nudge_ai()   # 触发器已把变更入队，催 AI worker 尽快跑一轮（近实时）
    return {"ok": True, "count": n}


@router.delete("/entries/{day}/{seq}")
def ingest_delete(day: str, seq: int, db: Session = Depends(get_db)):
    """按 day#seq 删除一条（与本地 --delete 对齐）。"""
    from sqlalchemy import text
    client_id = f"{day}#{seq}"
    r = db.execute(text(
        "DELETE FROM entries WHERE client_id = :cid"
    ), {"cid": client_id})
    db.commit()
    _nudge_ai()   # 删除触发器已入队 op=delete，催 worker 清理其 insight/embedding
    return {"ok": True, "deleted": r.rowcount}


def _nudge_ai():
    """催促 AI worker 尽快跑一轮（尽力而为，失败不影响上报）。"""
    try:
        from .. import ai_worker
        ai_worker.nudge()
    except Exception:
        pass
