"""数据访问层：entry 入库 upsert + 三视图分页查询 + FTS 搜索。

集中所有面向 entries 的 SQL，路由层只调这里。游标用 keyset 分页（见 cursor.py）。
所有查询都强制带 user_id，多用户隔离的唯一入口。
"""
import json

from sqlalchemy import text

from ailog_core.schema import Entry as EntrySchema, day_of


def _entry_row_from_schema(user_id, e: EntrySchema) -> dict:
    """把上报/导入的 entry（pydantic）拍平成 entries 表的一行 dict。

    client_id 是「每条」的稳定唯一键，取 day#seq（与前端 localStorage 覆盖层的
    日期#seq 寻址一致）；不能用 e.id（那是会话代号，同会话多条共享，会互相覆盖）。
    session_code = e.id 仅作会话分组聚合键。
    """
    day = day_of(e.datetime)
    return {
        "user_id": user_id,
        "seq": e.seq,
        "client_id": f"{day}#{e.seq}",   # 每条唯一：日期#当天序号
        "emoji": e.emoji,
        "name": e.name,
        "title": e.title,
        "session_code": e.id,          # 会话代号即聚合键（同会话多条共享）
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


def upsert_entry(db, user_id, e: EntrySchema):
    """按 (user_id, client_id) 幂等 upsert：已存在则更新内容，否则插入。

    用 SQLite 的 ON CONFLICT 做原子 upsert，避免先查后写的竞态。
    """
    row = _entry_row_from_schema(user_id, e)
    db.execute(text("""
        INSERT INTO entries
          (user_id, seq, client_id, emoji, name, title, session_code, start_ts, end_ts,
           datetime, day, duration, cwd, project, branch, model, summary, mode, carryover, usage,
           created_at, updated_at)
        VALUES
          (:user_id, :seq, :client_id, :emoji, :name, :title, :session_code, :start_ts, :end_ts,
           :datetime, :day, :duration, :cwd, :project, :branch, :model, :summary, :mode, :carryover, :usage,
           datetime('now'), datetime('now'))
        ON CONFLICT(user_id, client_id) DO UPDATE SET
          seq=excluded.seq, emoji=excluded.emoji, name=excluded.name, title=excluded.title,
          session_code=excluded.session_code, start_ts=excluded.start_ts, end_ts=excluded.end_ts,
          datetime=excluded.datetime, day=excluded.day, duration=excluded.duration,
          cwd=excluded.cwd, project=excluded.project, branch=excluded.branch, model=excluded.model,
          summary=excluded.summary, mode=excluded.mode, carryover=excluded.carryover, usage=excluded.usage,
          updated_at=datetime('now')
    """), row)


def _row_to_dict(r) -> dict:
    """把 entries 行（Row）还原成给前端的 JSON 结构（含解析 JSON 列）。"""
    d = dict(r._mapping)
    d["carryover"] = json.loads(d["carryover"]) if d.get("carryover") else None
    d["usage"] = json.loads(d["usage"]) if d.get("usage") else None
    return d


# entries 表对外暴露的列（不含内部 created_at/updated_at）
_COLS = ("id, user_id, seq, client_id, emoji, name, title, session_code, "
         "start_ts AS start, end_ts AS end, datetime, day, duration, cwd, "
         "project, branch, model, summary, mode, carryover, usage")


def list_entries(db, user_id, cursor=None, limit=50):
    """全量 / 按日期视图：按 datetime DESC, id DESC 的时间倒序流（走索引①）。

    两视图后端查询相同；按日期视图由前端用每条的 day 字段插日期分隔头。
    返回 (items, next_cursor)。
    """
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    params = {"uid": user_id, "lim": limit + 1}
    where = "user_id = :uid"
    if cur and "dt" in cur and "id" in cur:
        # keyset：取严格早于游标的（datetime, id）
        where += " AND (datetime < :dt OR (datetime = :dt AND id < :cid))"
        params["dt"] = cur["dt"]; params["cid"] = cur["id"]
    rows = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE {where} "
        "ORDER BY datetime DESC, id DESC LIMIT :lim"
    ), params).fetchall()
    return _paginate(rows, limit, lambda d: {"dt": d["datetime"], "id": d["id"]}, encode_cursor)


def list_sessions(db, user_id, cursor=None, limit=50):
    """按 session 视图第一层：聚合出 session 列表，按最近活动倒序。

    每项含 session_code、最近活动时间、条数、首条 emoji/name（用于展示）。
    """
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    params = {"uid": user_id, "lim": limit + 1}
    having = ""
    if cur and "last" in cur and "code" in cur:
        having = "HAVING last_activity < :last OR (last_activity = :last AND session_code < :code)"
        params["last"] = cur["last"]; params["code"] = cur["code"]
    rows = db.execute(text(
        "SELECT session_code, MAX(datetime) AS last_activity, COUNT(*) AS cnt, "
        "MAX(emoji) AS emoji, MAX(name) AS name "
        "FROM entries WHERE user_id = :uid "
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


def list_session_entries(db, user_id, session_code, cursor=None, limit=50):
    """按 session 视图第二层：某 session 内按时间倒序拉条目（走索引②）。"""
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    params = {"uid": user_id, "code": session_code, "lim": limit + 1}
    where = "user_id = :uid AND session_code = :code"
    if cur and "dt" in cur and "id" in cur:
        where += " AND (datetime < :dt OR (datetime = :dt AND id < :cid))"
        params["dt"] = cur["dt"]; params["cid"] = cur["id"]
    rows = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE {where} "
        "ORDER BY datetime DESC, id DESC LIMIT :lim"
    ), params).fetchall()
    return _paginate(rows, limit, lambda d: {"dt": d["datetime"], "id": d["id"]}, encode_cursor)


def get_entry(db, user_id, entry_id):
    """取单条详情（带 user_id 归属校验，防 IDOR）。不存在/不属于该用户返回 None。"""
    r = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE id = :id AND user_id = :uid"
    ), {"id": entry_id, "uid": user_id}).fetchone()
    return _row_to_dict(r) if r else None


def search_entries(db, user_id, q, cursor=None, limit=50):
    """FTS5 全文搜索（title/summary/name/project），按相关度 + 时间排序，cursor 分页。

    用 offset 游标（FTS rank 不便做 keyset），个人规模可接受；游标里存已取条数。
    """
    from .cursor import decode_cursor, encode_cursor
    limit = max(1, min(limit, 100))
    cur = decode_cursor(cursor)
    offset = cur.get("off", 0) if cur else 0
    q = (q or "").strip()
    if not q:
        return [], None
    # FTS MATCH 用参数化 + 前缀匹配；特殊字符交给 fts5 默认 tokenizer
    fts_q = _fts_sanitize(q)
    rows = db.execute(text(
        f"SELECT {_COLS} FROM entries "
        "WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH :q) "
        "AND user_id = :uid "
        "ORDER BY datetime DESC, id DESC LIMIT :lim OFFSET :off"
    ), {"q": fts_q, "uid": user_id, "lim": limit + 1, "off": offset}).fetchall()
    items = [_row_to_dict(r) for r in rows]
    has_more = len(items) > limit
    items = items[:limit]
    nxt = encode_cursor({"off": offset + limit}) if has_more else None
    return items, nxt


def _fts_sanitize(q: str) -> str:
    """把用户输入转成安全的 FTS5 查询：按空白切词、每词加前缀通配、去掉 FTS 语法字符。"""
    import re
    words = re.findall(r"[^\s\"'()*:^-]+", q)
    if not words:
        return '""'
    return " ".join(f'"{w}"*' for w in words)


def _paginate(rows, limit, cursor_of, encode):
    """通用：rows 多取 1 条判断是否还有下一页，返回 (items, next_cursor)。"""
    items = [_row_to_dict(r) for r in rows]
    has_more = len(items) > limit
    items = items[:limit]
    nxt = encode(cursor_of(items[-1])) if (has_more and items) else None
    return items, nxt

