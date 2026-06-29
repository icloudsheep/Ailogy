"""日志读取路由：三视图分页瀑布流 + session 列表 + 详情 + 搜索。

读端点要求登录会话，只返回**当前用户自己**的数据（user_id = current_user.id），
天然多用户隔离 + IDOR 防护。公开分享走独立的 /api/public/{token}（见 share.py）。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from .. import repo, models

router = APIRouter(prefix="/api", tags=["entries"])


@router.get("/entries")
def get_entries(
    view: str = Query("all", pattern="^(all|day|session)$"),
    session_code: str = Query(None),
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """瀑布流读取。view=all/day 共用时间倒序流；view=session 需配 session_code 取该会话条目。"""
    uid = user.id
    if view == "session":
        if not session_code:
            raise HTTPException(400, "view=session 需要 session_code 参数")
        items, nxt = repo.list_session_entries(db, uid, session_code, cursor, limit)
    else:
        items, nxt = repo.list_entries(db, uid, cursor, limit)
    return {"items": items, "next_cursor": nxt}


@router.get("/sessions")
def get_sessions(
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """按 session 视图的第一层：会话列表（按最近活动倒序）。"""
    items, nxt = repo.list_sessions(db, user.id, cursor, limit)
    return {"items": items, "next_cursor": nxt}


@router.get("/entries/{entry_id}")
def get_entry_detail(entry_id: int, user: models.User = Depends(current_user),
                     db: Session = Depends(get_db)):
    """单条详情（repo.get_entry 内含 user_id 归属校验，防 IDOR）。"""
    e = repo.get_entry(db, user.id, entry_id)
    if not e:
        raise HTTPException(404, "条目不存在")
    return e


@router.get("/search")
def search(
    q: str = Query(..., min_length=1),
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """FTS 全文搜索，cursor 分页（仅搜自己的）。"""
    items, nxt = repo.search_entries(db, user.id, q, cursor, limit)
    return {"items": items, "next_cursor": nxt, "query": q}


@router.get("/timeline")
def timeline(
    month: str = Query(None, pattern=r"^\d{4}-\d{2}$"),
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """泳道时间线：返回某月（默认当月）该用户全部条目，前端按天→会话分组。"""
    import datetime as _dt
    m = month or _dt.date.today().strftime("%Y-%m")
    return {"month": m, "items": repo.list_month(db, user.id, m)}


@router.get("/months")
def months(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    """该用户有数据的月份列表（倒序），供月份二级页选择。"""
    return {"months": repo.list_months(db, user.id)}
