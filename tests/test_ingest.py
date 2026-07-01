"""Ingest 单测：幂等 upsert、批量、体积/数量限制、删除。"""
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
    db.execute("DELETE FROM entries")
    db.commit(); db.close()
    yield


def _entry(seq=1, code="Fox-1111", day="2026-06-29", **kw):
    base = dict(seq=seq, id=code, name="Fox", emoji="🦊",
                datetime=f"{day} 10:{seq:02d}:00", title=f"t{seq}", summary="正文")
    base.update(kw)
    return base


def test_ingest_single_and_idempotent():
    with TestClient(app) as c:
        assert c.post("/api/ingest/entries", json=_entry(1, title="旧")).json()["count"] == 1
        c.post("/api/ingest/entries", json=_entry(1, title="新"))
        items = c.get("/api/entries?view=all").json()["items"]
        assert len(items) == 1 and items[0]["title"] == "新"


def test_ingest_batch():
    with TestClient(app) as c:
        batch = [_entry(i) for i in range(1, 6)]
        assert c.post("/api/ingest/entries", json=batch).json()["count"] == 5
        assert len(c.get("/api/entries?view=all").json()["items"]) == 5


def test_ingest_oversize_summary():
    with TestClient(app) as c:
        big = _entry(1, summary="x" * (256 * 1024 + 1))
        assert c.post("/api/ingest/entries", json=big).status_code == 413


def test_ingest_delete():
    with TestClient(app) as c:
        c.post("/api/ingest/entries", json=_entry(3, day="2026-06-29"))
        r = c.request("DELETE", "/api/ingest/entries/2026-06-29/3")
        assert r.status_code == 200 and r.json()["deleted"] == 1
        assert len(c.get("/api/entries?view=all").json()["items"]) == 0
