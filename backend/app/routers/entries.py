"""日志读取路由：三视图分页瀑布流 + session 列表 + 详情 + 搜索。

M1 阶段用固定 user_id（DEMO_USER_ID），鉴权在 M2/M4 接入后改为从会话/分享 token 解析。
所有查询经 repo 层强制带 user_id，多用户隔离的统一入口。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_db
from .. import repo

router = APIRouter(prefix="/api", tags=["entries"])

# M1 临时：固定演示用户。M2 起由鉴权依赖注入真实 user_id。
DEMO_USER_ID = 1


@router.get("/entries")
def get_entries(
    view: str = Query("all", pattern="^(all|day|session)$"),
    session_code: str = Query(None),
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """瀑布流读取。view=all/day 共用时间倒序流；view=session 需配 session_code 取该会话条目。"""
    uid = DEMO_USER_ID
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
    db: Session = Depends(get_db),
):
    """按 session 视图的第一层：会话列表（按最近活动倒序）。"""
    items, nxt = repo.list_sessions(db, DEMO_USER_ID, cursor, limit)
    return {"items": items, "next_cursor": nxt}


@router.get("/entries/{entry_id}")
def get_entry_detail(entry_id: int, db: Session = Depends(get_db)):
    """单条详情（含 user_id 归属校验）。"""
    e = repo.get_entry(db, DEMO_USER_ID, entry_id)
    if not e:
        raise HTTPException(404, "条目不存在")
    return e


@router.get("/search")
def search(
    q: str = Query(..., min_length=1),
    cursor: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """FTS 全文搜索，cursor 分页。"""
    items, nxt = repo.search_entries(db, DEMO_USER_ID, q, cursor, limit)
    return {"items": items, "next_cursor": nxt, "query": q}
