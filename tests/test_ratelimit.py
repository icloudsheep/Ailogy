"""M5 安全加固单测：限流（登录防爆破）。"""
import sys
import os
import sqlite3

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.db import DB_PATH
from app import ratelimit


@pytest.fixture(autouse=True)
def _clean():
    ratelimit._hits.clear()  # 清限流计数，避免跨测试干扰
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    for t in ("entries", "users", "sessions", "api_keys", "key_applications", "page_visibility"):
        db.execute(f"DELETE FROM {t}")
    db.commit(); db.close()
    yield


def test_login_rate_limit():
    with TestClient(app) as c:
        c.post("/api/auth/register", json={"email": "a@example.com", "password": "password1"})
        # 连续错误登录：第 6 次（同 IP/分钟，limit=5）应 429
        codes = []
        for _ in range(6):
            r = c.post("/api/auth/login", json={"email": "a@example.com", "password": "wrong"})
            codes.append(r.status_code)
        assert codes[:5] == [401] * 5  # 前 5 次正常返回 401（密码错）
        assert codes[5] == 429          # 第 6 次被限流
        # 429 响应带 Retry-After 头（HTTP 头名大小写不敏感）
        r = c.post("/api/auth/login", json={"email": "a@example.com", "password": "wrong"})
        assert r.status_code == 429 and "retry-after" in {k.lower() for k in r.headers}


def test_register_rate_limit():
    with TestClient(app) as c:
        codes = []
        for i in range(6):
            r = c.post("/api/auth/register", json={"email": f"u{i}@example.com", "password": "password1"})
            codes.append(r.status_code)
        # 前 5 次成功(200)，第 6 次被限流
        assert codes[5] == 429
