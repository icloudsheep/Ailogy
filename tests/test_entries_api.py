"""M1 读取链路单测：入库 upsert、三视图分页、详情、搜索。

读端点需登录会话（M4 起）；这里注册用户拿 cookie 后再读，user_id 即该用户。
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
from ailog_core.schema import Entry


def _login_client():
    """注册并登录一个用户，返回 (带 cookie 的 client, user_id)。"""
    c = TestClient(app)
    c.__enter__()
    r = c.post("/api/auth/register", json={"email": "a@example.com", "password": "password1"})
    return c, r.json()["id"]


def _seed(uid, entries):
    """把若干 entry 灌入指定用户名下。"""
    db = SessionLocal()
    try:
        for e in entries:
            repo.upsert_entry(db, uid, Entry(**e))
        db.commit()
    finally:
        db.close()


def _mk(seq, code, day="2026-06-29", title="", summary="", **kw):
    return dict(seq=seq, id=code, name=code.split("-")[0], emoji="🦊",
                datetime=f"{day} 10:{seq:02d}:00", title=title, summary=summary, **kw)


@pytest.fixture(autouse=True)
def _clean():
    # 每个测试前清空，保证独立
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    for t in ("entries", "users", "sessions", "api_keys", "key_applications"):
        db.execute(f"DELETE FROM {t}")
    db.commit(); db.close()
    yield


def test_same_session_no_collision():
    # 回归：同会话 5 条（同 session_code，不同 seq）都应保留，不互相覆盖
    c, uid = _login_client()
    _seed(uid, [_mk(i, "Fox-1111", title=f"t{i}") for i in range(1, 6)])
    r = c.get("/api/entries?view=all&limit=50").json()
    assert len(r["items"]) == 5
    assert {x["session_code"] for x in r["items"]} == {"Fox-1111"}


def test_upsert_idempotent():
    c, uid = _login_client()
    _seed(uid, [_mk(1, "Fox-1111", title="旧")])
    _seed(uid, [_mk(1, "Fox-1111", title="新")])
    r = c.get("/api/entries?view=all").json()
    assert len(r["items"]) == 1
    assert r["items"][0]["title"] == "新"


def test_cursor_pagination_no_overlap():
    c, uid = _login_client()
    _seed(uid, [_mk(i, "Fox-1111", title=f"t{i}") for i in range(1, 26)])  # 25 条
    p1 = c.get("/api/entries?view=all&limit=10").json()
    assert len(p1["items"]) == 10 and p1["next_cursor"]
    p2 = c.get(f"/api/entries?view=all&limit=10&cursor={p1['next_cursor']}").json()
    ids1 = {x["id"] for x in p1["items"]}; ids2 = {x["id"] for x in p2["items"]}
    assert ids1.isdisjoint(ids2)  # 不重叠


def test_session_view():
    c, uid = _login_client()
    _seed(uid, [_mk(1, "Fox-1111"), _mk(2, "Fox-1111"), _mk(1, "Wolf-2222", day="2026-06-28")])
    sess = c.get("/api/sessions").json()
    codes = {s["session_code"]: s["cnt"] for s in sess["items"]}
    assert codes == {"Fox-1111": 2, "Wolf-2222": 1}
    r = c.get("/api/entries?view=session&session_code=Fox-1111").json()
    assert len(r["items"]) == 2 and all(x["session_code"] == "Fox-1111" for x in r["items"])


def test_detail_and_idor():
    c, uid = _login_client()
    _seed(uid, [_mk(1, "Fox-1111", title="详情")])
    lst = c.get("/api/entries?view=all").json()
    eid = lst["items"][0]["id"]
    assert c.get(f"/api/entries/{eid}").json()["title"] == "详情"
    assert c.get("/api/entries/999999").status_code == 404


def test_search_fts():
    c, uid = _login_client()
    _seed(uid, [_mk(1, "Fox-1111", title="关于 mermaid 流程图", summary="画了 mermaid"),
                _mk(2, "Fox-1111", title="普通日志", summary="无关内容")])
    r = c.get("/api/search?q=mermaid").json()
    assert len(r["items"]) == 1 and "mermaid" in r["items"][0]["title"]


def test_read_requires_login():
    # 未登录读端点应 401
    with TestClient(app) as c:
        assert c.get("/api/entries?view=all").status_code == 401
