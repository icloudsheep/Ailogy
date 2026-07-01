"""数据访问层：entry 入库 upsert + 三视图分页查询 + FTS 搜索。

所有查询不再带 user_id。游标用 keyset 分页（见 cursor.py）。
"""
import json

from sqlalchemy import text

from ailog_core.schema import Entry as EntrySchema, day_of


def _entry_row_from_schema(e: EntrySchema) -> dict:
    """把上报/导入的 entry（pydantic）拍平成 entries 表的一行 dict。"""
    day = day_of(e.datetime)
    return {
        "seq": e.seq,
        "client_id": f"{day}#{e.seq}",
        "device": e.device,
        "emoji": e.emoji,
        "name": e.name,
        "title": e.title,
        "session_code": e.id,
        "start_ts": e.start,
        "end_ts": e.end,
        "datetime": e.datetime,
        "day": day,
        "duration": e.duration,
        "cwd": e.cwd,
        "project": e.project,
        "branch": e.branch,
        "model": e.model,
        "summary": e.summary,
        "mode": e.mode,
        "carryover": json.dumps(e.carryover.model_dump(), ensure_ascii=False) if e.carryover else None,
        "usage": json.dumps(e.usage.model_dump(), ensure_ascii=False) if e.usage else None,
    }


def upsert_entry(db, e: EntrySchema):
    """按 client_id 幂等 upsert。color 列不被上报覆盖（前端固化的会话色）。"""
    row = _entry_row_from_schema(e)
    db.execute(text("""
        INSERT INTO entries
          (seq, client_id, device, emoji, name, title, session_code, start_ts, end_ts,
           datetime, day, duration, cwd, project, branch, model, summary, mode, carryover, usage,
           created_at, updated_at)
        VALUES
          (:seq, :client_id, :device, :emoji, :name, :title, :session_code, :start_ts, :end_ts,
           :datetime, :day, :duration, :cwd, :project, :branch, :model, :summary, :mode, :carryover, :usage,
           datetime('now'), datetime('now'))
        ON CONFLICT(client_id) DO UPDATE SET
          seq=excluded.seq, device=excluded.device, emoji=excluded.emoji, name=excluded.name, title=excluded.title,
          session_code=excluded.session_code, start_ts=excluded.start_ts, end_ts=excluded.end_ts,
          datetime=excluded.datetime, day=excluded.day, duration=excluded.duration,
          cwd=excluded.cwd, project=excluded.project, branch=excluded.branch, model=excluded.model,
          summary=excluded.summary, mode=excluded.mode, carryover=excluded.carryover, usage=excluded.usage,
          updated_at=datetime('now')
    """), row)


def _row_to_dict(r) -> dict:
    d = dict(r._mapping)
    d["carryover"] = json.loads(d["carryover"]) if d.get("carryover") else None
    d["usage"] = json.loads(d["usage"]) if d.get("usage") else None
    return d


_COLS = ("id, seq, client_id, device, emoji, name, title, session_code, "
         "start_ts AS start, end_ts AS end, datetime, day, duration, cwd, "
         "project, branch, model, summary, mode, color, carryover, usage")


def list_entries(db, cursor=None, limit=50):
    """全量 / 按日期视图：按 datetime DESC, id DESC 的时间倒序流。"""
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    params = {"lim": limit + 1}
    where = "1=1"
    if cur and "dt" in cur and "id" in cur:
        where += " AND (datetime < :dt OR (datetime = :dt AND id < :cid))"
        params["dt"] = cur["dt"]; params["cid"] = cur["id"]
    rows = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE {where} "
        "ORDER BY datetime DESC, id DESC LIMIT :lim"
    ), params).fetchall()
    return _paginate(rows, limit, lambda d: {"dt": d["datetime"], "id": d["id"]}, encode_cursor)


def list_sessions(db, cursor=None, limit=50):
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    params = {"lim": limit + 1}
    having = ""
    if cur and "last" in cur and "code" in cur:
        having = "HAVING last_activity < :last OR (last_activity = :last AND session_code < :code)"
        params["last"] = cur["last"]; params["code"] = cur["code"]
    rows = db.execute(text(
        "SELECT session_code, MAX(datetime) AS last_activity, COUNT(*) AS cnt, "
        "MAX(emoji) AS emoji, MAX(name) AS name "
        "FROM entries "
        f"GROUP BY session_code {having} "
        "ORDER BY last_activity DESC, session_code DESC LIMIT :lim"
    ), params).fetchall()
    items = [dict(r._mapping) for r in rows]
    has_more = len(items) > limit
    items = items[:limit]
    nxt = None
    if has_more and items:
        last = items[-1]
        nxt = encode_cursor({"last": last["last_activity"], "code": last["session_code"]})
    return items, nxt


def list_session_entries(db, session_code, cursor=None, limit=50):
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    params = {"code": session_code, "lim": limit + 1}
    where = "session_code = :code"
    if cur and "dt" in cur and "id" in cur:
        where += " AND (datetime < :dt OR (datetime = :dt AND id < :cid))"
        params["dt"] = cur["dt"]; params["cid"] = cur["id"]
    rows = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE {where} "
        "ORDER BY datetime DESC, id DESC LIMIT :lim"
    ), params).fetchall()
    return _paginate(rows, limit, lambda d: {"dt": d["datetime"], "id": d["id"]}, encode_cursor)


def get_entry(db, entry_id):
    r = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE id = :id"
    ), {"id": entry_id}).fetchone()
    return _row_to_dict(r) if r else None


def search_entries(db, q, cursor=None, limit=50):
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    offset = cur.get("off", 0) if cur else 0
    q = (q or "").strip()
    if not q:
        return [], None
    fts_q = _fts_sanitize(q)
    rows = db.execute(text(
        f"SELECT {_COLS} FROM entries "
        "WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH :q) "
        "ORDER BY datetime DESC, id DESC LIMIT :lim OFFSET :off"
    ), {"q": fts_q, "lim": limit + 1, "off": offset}).fetchall()
    items = [_row_to_dict(r) for r in rows]
    has_more = len(items) > limit
    items = items[:limit]
    nxt = encode_cursor({"off": offset + limit}) if has_more else None
    return items, nxt


def _fts_sanitize(q: str) -> str:
    import re
    words = re.findall(r"[^\s\"'()*:^-]+", q)
    if not words:
        return '""'
    return " ".join(f'"{w}"*' for w in words)


def _paginate(rows, limit, cursor_of, encode):
    items = [_row_to_dict(r) for r in rows]
    has_more = len(items) > limit
    items = items[:limit]
    nxt = encode(cursor_of(items[-1])) if (has_more and items) else None
    return items, nxt


def list_month(db, month, devices=None):
    """取某月条目；devices 为 None=全部，[]=无（空结果），否则只取这些设备。"""
    if devices is not None and len(devices) == 0:
        return []  # 显式指定空设备集 → 无结果
    params = {"m": f"{month}-%"}
    where = "day LIKE :m"
    if devices is not None:
        ph = ", ".join(f":d{i}" for i in range(len(devices)))
        where += f" AND COALESCE(device,'') IN ({ph})"
        for i, d in enumerate(devices):
            params[f"d{i}"] = d
    rows = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE {where} "
        "ORDER BY datetime ASC, id ASC"
    ), params).fetchall()
    return [_row_to_dict(r) for r in rows]


def list_months(db):
    rows = db.execute(text(
        "SELECT DISTINCT substr(day,1,7) AS m FROM entries ORDER BY m DESC"
    )).fetchall()
    return [r[0] for r in rows]


def list_devices(db):
    """所有上报设备名（去重，按字母序）。空设备名归一为 ''。"""
    rows = db.execute(text(
        "SELECT DISTINCT COALESCE(device,'') AS d FROM entries ORDER BY d"
    )).fetchall()
    return [r[0] for r in rows]


# ── 编辑 / 删除 / 改色（固化到 DB）──
def edit_entry(db, entry_id, title=None, summary=None):
    """按内部 id 编辑标题/正文。None 表示该字段不变。返回是否命中。"""
    sets, params = [], {"id": entry_id}
    if title is not None: sets.append("title = :title"); params["title"] = title
    if summary is not None: sets.append("summary = :summary"); params["summary"] = summary
    if not sets: return False
    sets.append("updated_at = datetime('now')")
    r = db.execute(text(f"UPDATE entries SET {', '.join(sets)} WHERE id = :id"), params)
    return r.rowcount > 0


def delete_entry(db, entry_id):
    r = db.execute(text("DELETE FROM entries WHERE id = :id"), {"id": entry_id})
    return r.rowcount > 0


def set_session_color(db, session_code, color):
    """给某会话所有条目写入颜色覆盖（color 为空串则清除）。"""
    db.execute(text("UPDATE entries SET color = :c WHERE session_code = :s"),
               {"c": color or None, "s": session_code})


# ── 前端偏好固化（prefs 表）──
def get_pref(db, key):
    r = db.execute(text("SELECT value FROM prefs WHERE key = :k"), {"k": key}).fetchone()
    return r[0] if r else None


def set_pref(db, key, value):
    db.execute(text(
        "INSERT INTO prefs (key, value, updated_at) VALUES (:k, :v, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    ), {"k": key, "v": value})


def all_prefs(db):
    rows = db.execute(text("SELECT key, value FROM prefs")).fetchall()
    return {r[0]: r[1] for r in rows}
