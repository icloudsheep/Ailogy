"""M2 账号与密钥平台单测：注册/登录/会话、申请→审批→发密钥、密钥管理、鉴权。"""
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


def _register(c, email="a@x.com", pw="password1", handle=""):
    return c.post("/api/auth/register", json={"email": email, "password": pw, "handle": handle})


def test_register_first_user_is_admin():
    with TestClient(app) as c:
        r = _register(c)
        assert r.status_code == 200 and r.json()["is_admin"] is True
        # 第二个用户非管理员
        r2 = _register(c, email="b@x.com")
        assert r2.json()["is_admin"] is False


def test_register_dup_email():
    with TestClient(app) as c:
        _register(c)
        assert _register(c).status_code == 409


def test_login_logout_me():
    with TestClient(app) as c:
        _register(c)
        c.cookies.clear()  # 模拟新会话
        assert c.get("/api/auth/me").status_code == 401  # 未登录
        r = c.post("/api/auth/login", json={"email": "a@x.com", "password": "password1"})
        assert r.status_code == 200
        assert c.get("/api/auth/me").json()["email"] == "a@x.com"
        c.post("/api/auth/logout")
        assert c.get("/api/auth/me").status_code == 401


def test_login_wrong_password():
    with TestClient(app) as c:
        _register(c)
        assert c.post("/api/auth/login", json={"email": "a@x.com", "password": "bad"}).status_code == 401


def test_application_approve_flow():
    with TestClient(app) as c:
        _register(c)  # admin
        # 申请
        a = c.post("/api/applications", json={"reason": "想用 CLI 上报"})
        assert a.status_code == 200 and a.json()["status"] == "pending"
        app_id = a.json()["id"]
        # 重复申请被拒
        assert c.post("/api/applications", json={"reason": "再来"}).status_code == 409
        # 管理员审批列表
        lst = c.get("/api/admin/applications?status=pending").json()
        assert len(lst) == 1
        # 批准 → 返回明文密钥
        ap = c.post(f"/api/admin/applications/{app_id}/approve", json={"note": "ok"})
        assert ap.status_code == 200
        key = ap.json()["api_key"]
        assert key.startswith("ak_")
        # 用该密钥能通过 API Key 鉴权（借 me 之外的 deps，直接验证 ingest 在 M3，这里验证密钥已入库）
        keys = c.get("/api/keys").json()
        assert len(keys) == 1 and keys[0]["prefix"] == key[:11]


def test_application_reject_requires_note():
    with TestClient(app) as c:
        _register(c)
        app_id = c.post("/api/applications", json={"reason": "x"}).json()["id"]
        assert c.post(f"/api/admin/applications/{app_id}/reject", json={"note": ""}).status_code == 400
        assert c.post(f"/api/admin/applications/{app_id}/reject", json={"note": "不合规"}).status_code == 200


def test_self_create_and_revoke_key():
    with TestClient(app) as c:
        _register(c)
        k = c.post("/api/keys", json={"label": "我的密钥"})
        assert k.json()["api_key"].startswith("ak_")
        kid = k.json()["key"]["id"]
        keys = c.get("/api/keys").json()
        assert len(keys) == 1
        assert keys[0]["secret"] == k.json()["api_key"]  # 明文随时可复制
        # 删除（不可逆，列表清空）
        assert c.delete(f"/api/keys/{kid}").status_code == 200
        assert c.get("/api/keys").json() == []


def test_admin_endpoint_requires_admin():
    with TestClient(app) as c:
        _register(c)  # admin
        _register(c, email="b@x.com")  # 第二个非 admin，且此时已登录为 b
        # 当前 cookie 是 b（非 admin）
        assert c.get("/api/admin/applications").status_code == 403
