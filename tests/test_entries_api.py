"""读取链路单测：入库 upsert、三视图分页、详情、搜索。"""
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


def _seed(entries):
    db = SessionLocal()
    try:
        for e in entries:
            repo.upsert_entry(db, Entry(**e))
        db.commit()
    finally:
        db.close()


def _mk(seq, code, day="2026-06-29", title="", summary="", **kw):
    return dict(seq=seq, id=code, name=code.split("-")[0], emoji="🦊",
                datetime=f"{day} 10:{seq:02d}:00", title=title, summary=summary, **kw)


@pytest.fixture(autouse=True)
def _clean():
    with TestClient(app):
        pass
    db = sqlite3.connect(DB_PATH)
    db.execute("DELETE FROM entries")
    try: db.execute("DELETE FROM prefs")
    except sqlite3.OperationalError: pass
    db.commit(); db.close()
    yield


def test_same_session_no_collision():
    _seed([_mk(i, "Fox-1111", title=f"t{i}") for i in range(1, 6)])
    with TestClient(app) as c:
        r = c.get("/api/entries?view=all&limit=50").json()
        assert len(r["items"]) == 5
        assert {x["session_code"] for x in r["items"]} == {"Fox-1111"}


def test_upsert_idempotent():
    _seed([_mk(1, "Fox-1111", title="旧")])
    _seed([_mk(1, "Fox-1111", title="新")])
    with TestClient(app) as c:
        r = c.get("/api/entries?view=all").json()
        assert len(r["items"]) == 1
        assert r["items"][0]["title"] == "新"


def test_cursor_pagination_no_overlap():
    _seed([_mk(i, "Fox-1111", title=f"t{i}") for i in range(1, 26)])
    with TestClient(app) as c:
        p1 = c.get("/api/entries?view=all&limit=10").json()
        assert len(p1["items"]) == 10 and p1["next_cursor"]
        p2 = c.get(f"/api/entries?view=all&limit=10&cursor={p1['next_cursor']}").json()
        ids1 = {x["id"] for x in p1["items"]}; ids2 = {x["id"] for x in p2["items"]}
        assert ids1.isdisjoint(ids2)


def test_session_view():
    _seed([_mk(1, "Fox-1111"), _mk(2, "Fox-1111"), _mk(1, "Wolf-2222", day="2026-06-28")])
    with TestClient(app) as c:
        sess = c.get("/api/sessions").json()
        codes = {s["session_code"]: s["cnt"] for s in sess["items"]}
        assert codes == {"Fox-1111": 2, "Wolf-2222": 1}
        r = c.get("/api/entries?view=session&session_code=Fox-1111").json()
        assert len(r["items"]) == 2 and all(x["session_code"] == "Fox-1111" for x in r["items"])


def test_detail():
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


def test_timeline():
    _seed([_mk(1, "Fox-1111", day="2026-06-29"), _mk(2, "Wolf-2222", day="2026-06-29"),
           _mk(1, "Fox-1111", day="2026-06-28")])
    with TestClient(app) as c:
        r = c.get("/api/timeline?month=2026-06").json()
        assert len(r["items"]) == 3


def test_months():
    _seed([_mk(1, "Fox-1111", day="2026-06-29"), _mk(2, "Fox-1111", day="2026-07-01")])
    with TestClient(app) as c:
        mons = c.get("/api/months").json()["months"]
        assert len(mons) == 2


def test_devices_and_filter():
    _seed([_mk(1, "Fox-1111", day="2026-06-29", device="mac"),
           _mk(2, "Wolf-2222", day="2026-06-29", device="linux")])
    with TestClient(app) as c:
        devs = c.get("/api/devices").json()["devices"]
        assert set(devs) == {"mac", "linux"}
        # 只筛 mac
        r = c.get("/api/timeline?month=2026-06&devices=mac").json()
        assert len(r["items"]) == 1 and r["items"][0]["device"] == "mac"
        # 空 devices=（无设备）→ 0 条
        r2 = c.get("/api/timeline?month=2026-06&devices=").json()
        assert len(r2["items"]) == 0
        # 不带 devices → 全部
        r3 = c.get("/api/timeline?month=2026-06").json()
        assert len(r3["items"]) == 2


def test_edit_entry():
    _seed([_mk(1, "Fox-1111", title="旧标题", summary="旧正文")])
    with TestClient(app) as c:
        eid = c.get("/api/entries?view=all").json()["items"][0]["id"]
        r = c.patch(f"/api/entries/{eid}", json={"title": "新标题", "summary": "新正文"})
        assert r.status_code == 200
        e = c.get(f"/api/entries/{eid}").json()
        assert e["title"] == "新标题" and e["summary"] == "新正文"


def test_delete_entry():
    _seed([_mk(1, "Fox-1111"), _mk(2, "Fox-1111")])
    with TestClient(app) as c:
        items = c.get("/api/entries?view=all").json()["items"]
        eid = items[0]["id"]
        assert c.delete(f"/api/entries/{eid}").status_code == 200
        assert len(c.get("/api/entries?view=all").json()["items"]) == 1
        assert c.delete(f"/api/entries/{eid}").status_code == 404


def test_session_color():
    _seed([_mk(1, "Fox-1111"), _mk(2, "Fox-1111")])
    with TestClient(app) as c:
        assert c.put("/api/sessions/Fox-1111/color", json={"color": "#ff0000"}).status_code == 200
        items = c.get("/api/entries?view=all").json()["items"]
        assert all(x["color"] == "#ff0000" for x in items)
        # 清除
        c.put("/api/sessions/Fox-1111/color", json={"color": ""})
        items2 = c.get("/api/entries?view=all").json()["items"]
        assert all(x["color"] is None for x in items2)


def test_prefs():
    with TestClient(app) as c:
        c.put("/api/prefs/theme", json={"value": '{"mode":"dark"}'})
        assert c.get("/api/prefs").json()["theme"] == '{"mode":"dark"}'
