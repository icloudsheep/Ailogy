"""后端骨架冒烟测试：/health + 建表 + FTS。"""
import sys
import os
import sqlite3

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from fastapi.testclient import TestClient
from app.main import app
from app.db import DB_PATH


def test_health_ok():
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


def test_tables_created():
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    tabs = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    db.close()
    for t in ("entries", "entries_fts"):
        assert t in tabs, f"缺表 {t}"


def test_indexes_created():
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    idx = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    db.close()
    assert "ix_entries_dt" in idx
    assert "ix_entries_session_dt" in idx
