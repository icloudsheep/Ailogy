"""M4 多用户隔离与公开分享单测：IDOR 防护、跨用户不可见、可见性 + 公开只读。"""
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


@pytest.fixture(autouse=True)
def _clean():
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    for t in ("entries", "users", "sessions", "api_keys", "key_applications", "page_visibility"):
        db.execute(f"DELETE FROM {t}")
    db.commit(); db.close()
    yield


def _user(email):
    """注册一个用户，返回 (带 cookie 的 client, user_id)。"""
    c = TestClient(app); c.__enter__()
    uid = c.post("/api/auth/register", json={"email": email, "password": "password1"}).json()["id"]
    return c, uid


def _seed(uid, n, code="Fox-1111", day="2026-06-29"):
    db = SessionLocal()
    try:
        for i in range(1, n + 1):
            repo.upsert_entry(db, uid, Entry(seq=i, id=code, name="Fox",
                              datetime=f"{day} 10:{i:02d}:00", title=f"t{i}", summary="s"))
        db.commit()
    finally:
        db.close()


def test_cross_user_isolation():
    a, auid = _user("a@example.com")
    b, buid = _user("b@example.com")
    _seed(auid, 3); _seed(buid, 2, code="Wolf-2222")
    # A 只看到自己的 3 条
    assert len(a.get("/api/entries?view=all").json()["items"]) == 3
    # B 只看到自己的 2 条
    assert len(b.get("/api/entries?view=all").json()["items"]) == 2


def test_idor_detail_cross_user():
    a, auid = _user("a@example.com")
    b, buid = _user("b@example.com")
    _seed(auid, 1)
    eid = a.get("/api/entries?view=all").json()["items"][0]["id"]
    # B 用 A 的条目 id 取详情 → 404（IDOR 防护）
    assert b.get(f"/api/entries/{eid}").status_code == 404


def test_visibility_default_private():
    a, auid = _user("a@example.com")
    _seed(auid, 2)
    # 未设公开时无可见性记录
    assert a.get("/api/visibility").json() == []


def test_public_share_flow():
    a, auid = _user("a@example.com")
    _seed(auid, 3)
    # 设 all 公开 → 拿 token
    r = a.put("/api/visibility", json={"scope": "all", "is_public": True}).json()
    token = r["share_token"]
    assert token
    # 匿名（无 cookie）用公开端点能读到 3 条
    anon = TestClient(app)
    with anon:
        pub = anon.get(f"/api/public/{token}/entries").json()
        assert len(pub["items"]) == 3
    # 转私有 → token 失效，旧链接 404
    a.put("/api/visibility", json={"scope": "all", "is_public": False})
    anon2 = TestClient(app)
    with anon2:
        assert anon2.get(f"/api/public/{token}/entries").status_code == 404


def test_public_session_scope():
    a, auid = _user("a@example.com")
    _seed(auid, 2, code="Fox-1111")
    _seed(auid, 1, code="Wolf-2222", day="2026-06-28")
    r = a.put("/api/visibility", json={"scope": "session:Fox-1111", "is_public": True}).json()
    anon = TestClient(app)
    with anon:
        pub = anon.get(f"/api/public/{r['share_token']}/entries").json()
        # 只暴露该会话的 2 条，不含 Wolf
        assert len(pub["items"]) == 2
        assert all(x["session_code"] == "Fox-1111" for x in pub["items"])


def test_invalid_share_token():
    anon = TestClient(app)
    with anon:
        assert anon.get("/api/public/nonexistent/entries").status_code == 404


def test_visibility_bad_scope():
    a, _ = _user("a@example.com")
    assert a.put("/api/visibility", json={"scope": "bogus", "is_public": True}).status_code == 422
