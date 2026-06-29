"""M1 读取链路单测：入库 upsert、三视图分页、详情、搜索。

重点回归：同会话多条不能因 client_id 碰撞而互相覆盖（曾经的 bug）。
"""
import sys
import os
import sqlite3

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.db import SessionLocal, DB_PATH
from app import repo
from app.routers.entries import DEMO_USER_ID
from ailog_core.schema import Entry


def _seed(entries):
    """建演示用户 + 灌入若干 entry。"""
    db = SessionLocal()
    try:
        db.execute(__import__("sqlalchemy").text(
            "INSERT OR IGNORE INTO users (id, email, password_hash, handle, is_admin, created_at) "
            "VALUES (:id,'demo@x','!','demo',1,datetime('now'))"), {"id": DEMO_USER_ID})
        for e in entries:
            repo.upsert_entry(db, DEMO_USER_ID, Entry(**e))
        db.commit()
    finally:
        db.close()


def _mk(seq, code, day="2026-06-29", title="", summary="", **kw):
    return dict(seq=seq, id=code, name=code.split("-")[0], emoji="🦊",
                datetime=f"{day} 10:{seq:02d}:00", title=title, summary=summary, **kw)


@pytest.fixture(autouse=True)
def _clean():
    # 每个测试前清空 entries/users，保证独立
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    db.execute("DELETE FROM entries"); db.execute("DELETE FROM users")
    db.commit(); db.close()
    yield


def test_same_session_no_collision():
    # 回归：同会话 5 条（同 session_code，不同 seq）都应保留，不互相覆盖
    _seed([_mk(i, "Fox-1111", title=f"t{i}") for i in range(1, 6)])
    with TestClient(app) as c:
        r = c.get("/api/entries?view=all&limit=50").json()
        assert len(r["items"]) == 5
        assert {x["session_code"] for x in r["items"]} == {"Fox-1111"}


def test_upsert_idempotent():
    # 同一 (day, seq) 重复入库应更新而非新增
    _seed([_mk(1, "Fox-1111", title="旧")])
    _seed([_mk(1, "Fox-1111", title="新")])
    with TestClient(app) as c:
        r = c.get("/api/entries?view=all").json()
        assert len(r["items"]) == 1
        assert r["items"][0]["title"] == "新"


def test_cursor_pagination_no_overlap():
    _seed([_mk(i, "Fox-1111", title=f"t{i}") for i in range(1, 26)])  # 25 条
    with TestClient(app) as c:
        p1 = c.get("/api/entries?view=all&limit=10").json()
        assert len(p1["items"]) == 10 and p1["next_cursor"]
        p2 = c.get(f"/api/entries?view=all&limit=10&cursor={p1['next_cursor']}").json()
        ids1 = {x["id"] for x in p1["items"]}; ids2 = {x["id"] for x in p2["items"]}
        assert ids1.isdisjoint(ids2)  # 不重叠


def test_session_view():
    _seed([_mk(1, "Fox-1111"), _mk(2, "Fox-1111"), _mk(1, "Wolf-2222", day="2026-06-28")])
    with TestClient(app) as c:
        sess = c.get("/api/sessions").json()
        codes = {s["session_code"]: s["cnt"] for s in sess["items"]}
        assert codes == {"Fox-1111": 2, "Wolf-2222": 1}
        # 某会话内只取该会话条目
        r = c.get("/api/entries?view=session&session_code=Fox-1111").json()
        assert len(r["items"]) == 2 and all(x["session_code"] == "Fox-1111" for x in r["items"])


def test_detail_and_idor():
    _seed([_mk(1, "Fox-1111", title="详情")])
    with TestClient(app) as c:
        lst = c.get("/api/entries?view=all").json()
        eid = lst["items"][0]["id"]
        assert c.get(f"/api/entries/{eid}").json()["title"] == "详情"
        assert c.get("/api/entries/999999").status_code == 404


def test_search_fts():
    _seed([_mk(1, "Fox-1111", title="关于 mermaid 流程图", summary="画了 mermaid"),
           _mk(2, "Fox-1111", title="普通日志", summary="无关内容")])
    with TestClient(app) as c:
        r = c.get("/api/search?q=mermaid").json()
        assert len(r["items"]) == 1 and "mermaid" in r["items"][0]["title"]
