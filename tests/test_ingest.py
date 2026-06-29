"""M3 ingest 单测：API Key 鉴权、幂等 upsert、批量、体积/数量限制、删除。"""
import sys
import os
import sqlite3

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.db import DB_PATH


@pytest.fixture(autouse=True)
def _clean():
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    for t in ("entries", "users", "sessions", "api_keys", "key_applications"):
        db.execute(f"DELETE FROM {t}")
    db.commit(); db.close()
    yield


def _key(c):
    """注册用户 + 自助建密钥，返回明文 key。"""
    c.post("/api/auth/register", json={"email": "u@example.com", "password": "password123"})
    return c.post("/api/keys", json={"label": "t"}).json()["api_key"]


def _entry(seq=1, code="Fox-1111", day="2026-06-29", **kw):
    base = dict(seq=seq, id=code, name="Fox", emoji="🦊",
                datetime=f"{day} 10:{seq:02d}:00", title=f"t{seq}", summary="正文")
    base.update(kw)  # kw 覆盖默认（如 title/summary），避免重复关键字
    return base


def test_ingest_requires_key():
    with TestClient(app) as c:
        # 无 Authorization → 401
        r = c.post("/api/ingest/entries", json=_entry())
        assert r.status_code == 401


def test_ingest_bad_key():
    with TestClient(app) as c:
        _key(c)
        r = c.post("/api/ingest/entries", json=_entry(),
                   headers={"Authorization": "Bearer ak_wrong"})
        assert r.status_code == 401


def test_ingest_single_and_idempotent():
    with TestClient(app) as c:
        key = _key(c)
        h = {"Authorization": f"Bearer {key}"}
        assert c.post("/api/ingest/entries", json=_entry(1, title="旧"), headers=h).json()["count"] == 1
        # 同 day#seq 重复上报 → 覆盖，不新增
        c.post("/api/ingest/entries", json=_entry(1, title="新"), headers=h)
        # 用读端点验证（DEMO_USER_ID 与上报 user 同为 1）
        items = c.get("/api/entries?view=all").json()["items"]
        assert len(items) == 1 and items[0]["title"] == "新"


def test_ingest_batch():
    with TestClient(app) as c:
        key = _key(c)
        h = {"Authorization": f"Bearer {key}"}
        batch = [_entry(i) for i in range(1, 6)]
        assert c.post("/api/ingest/entries", json=batch, headers=h).json()["count"] == 5
        assert len(c.get("/api/entries?view=all").json()["items"]) == 5


def test_ingest_oversize_summary():
    with TestClient(app) as c:
        key = _key(c)
        h = {"Authorization": f"Bearer {key}"}
        big = _entry(1, summary="x" * (256 * 1024 + 1))
        assert c.post("/api/ingest/entries", json=big, headers=h).status_code == 413


def test_ingest_delete():
    with TestClient(app) as c:
        key = _key(c)
        h = {"Authorization": f"Bearer {key}"}
        c.post("/api/ingest/entries", json=_entry(3, day="2026-06-29"), headers=h)
        r = c.request("DELETE", "/api/ingest/entries/2026-06-29/3", headers=h)
        assert r.status_code == 200 and r.json()["deleted"] == 1
        assert len(c.get("/api/entries?view=all").json()["items"]) == 0


def test_revoked_key_rejected():
    with TestClient(app) as c:
        key = _key(c)
        kid = c.get("/api/keys").json()[0]["id"]
        c.delete(f"/api/keys/{kid}")  # 吊销
        r = c.post("/api/ingest/entries", json=_entry(),
                   headers={"Authorization": f"Bearer {key}"})
        assert r.status_code == 401  # 吊销后不可用
