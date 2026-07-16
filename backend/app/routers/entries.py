"""日志读取路由：三视图分页瀑布流 + session 列表 + 详情 + 搜索 + 编辑/删除/改色 + 设备 + 偏好。

无鉴权——本地单用户部署，所有端点直接访问。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from .. import repo

router = APIRouter(prefix="/api", tags=["entries"])


@router.get("/entries")
def get_entries(
    view: str = Query("all", pattern="^(all|day|session)$"),
    session_code: str = Query(None),
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    if view == "session":
        if not session_code:
            raise HTTPException(400, "view=session 需要 session_code 参数")
        items, nxt = repo.list_session_entries(db, session_code, cursor, limit)
    else:
        items, nxt = repo.list_entries(db, cursor, limit)
    return {"items": items, "next_cursor": nxt}


@router.get("/sessions")
def get_sessions(
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    items, nxt = repo.list_sessions(db, cursor, limit)
    return {"items": items, "next_cursor": nxt}


@router.get("/entries/{entry_id}")
def get_entry_detail(entry_id: int, db: Session = Depends(get_db)):
    e = repo.get_entry(db, entry_id)
    if not e:
        raise HTTPException(404, "条目不存在")
    return e


class EditReq(BaseModel):
    title: str = None
    summary: str = None


@router.patch("/entries/{entry_id}")
def edit_entry(entry_id: int, req: EditReq, db: Session = Depends(get_db)):
    """编辑标题/正文，固化到 DB。"""
    if not repo.edit_entry(db, entry_id, req.title, req.summary):
        raise HTTPException(404, "条目不存在或无改动")
    db.commit()
    return {"ok": True}


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: int, db: Session = Depends(get_db)):
    """删除某条，固化到 DB。"""
    if not repo.delete_entry(db, entry_id):
        raise HTTPException(404, "条目不存在")
    db.commit()
    return {"ok": True}


class ColorReq(BaseModel):
    color: str = ""


@router.put("/sessions/{session_code}/color")
def set_color(session_code: str, req: ColorReq, db: Session = Depends(get_db)):
    """给某会话固化主题色（空串=清除）。"""
    repo.set_session_color(db, session_code, req.color)
    db.commit()
    return {"ok": True, "color": req.color}


@router.get("/search")
def search(
    q: str = Query(..., min_length=1),
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    items, nxt = repo.search_entries(db, q, cursor, limit)
    return {"items": items, "next_cursor": nxt, "query": q}


@router.get("/timeline")
def timeline(
    month: str = Query(None, pattern=r"^\d{4}-\d{2}$"),
    recent: int = Query(None, ge=1, le=366, description="最近 N 天模式；给出则忽略 month"),
    devices: str = Query(None, description="逗号分隔的设备名；省略=全部"),
    db: Session = Depends(get_db),
):
    import datetime as _dt
    dev_list = None
    if devices is not None:
        dev_list = [d for d in devices.split(",")] if devices != "" else []
    if recent:
        return {"mode": "recent", "recent": recent, "items": repo.list_recent(db, recent, dev_list)}
    m = month or _dt.date.today().strftime("%Y-%m")
    return {"mode": "month", "month": m, "items": repo.list_month(db, m, dev_list)}


@router.get("/months")
def months(db: Session = Depends(get_db)):
    return {"months": repo.list_months(db)}


@router.get("/devices")
def devices(db: Session = Depends(get_db)):
    return {"devices": repo.list_devices(db)}


# ── 前端偏好固化（aliases / colors / selection / theme 等）──
class PrefReq(BaseModel):
    value: str = ""


@router.get("/prefs")
def get_prefs(db: Session = Depends(get_db)):
    return repo.all_prefs(db)


@router.get("/prefs/{key}")
def get_pref(key: str, db: Session = Depends(get_db)):
    """读单个 pref。缺失返回 value=""（不 404，简化前端）。"""
    v = repo.get_pref(db, key)
    return {"key": key, "value": v if v is not None else ""}


@router.put("/prefs/{key}")
def put_pref(key: str, req: PrefReq, db: Session = Depends(get_db)):
    repo.set_pref(db, key, req.value)
    db.commit()
    return {"ok": True}
