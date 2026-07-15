"""数据访问层：entry 入库 upsert + 三视图分页查询 + FTS 搜索。

所有查询不再带 user_id。游标用 keyset 分页（见 cursor.py）。
"""
import json
import random

from sqlalchemy import text

from ailog_core.schema import Entry as EntrySchema, day_of

# 会话主题色候选盘（与前端 utils.js 的 PALETTE 保持一致）：12 色相 × 5 明暗档 = 60 色。
# 新会话首次入库时从中随机挑一个（尽量避开已被占用的），持久化到 entries.color，
# 使不同会话天然拥有不同、且跨设备/浏览器稳定的颜色。
PALETTE = [
    "#fa5f5f", "#faac5f", "#fafa5f", "#acfa5f", "#5ffa5f", "#5ffaac",
    "#5ffafa", "#5facfa", "#5f5ffa", "#ac5ffa", "#fa5ffa", "#fa5fac",
    "#e64040", "#e69340", "#e6e640", "#93e640", "#40e640", "#40e693",
    "#40e6e6", "#4093e6", "#4040e6", "#9340e6", "#e640e6", "#e64093",
    "#d15e5e", "#d1985e", "#d1d15e", "#98d15e", "#5ed15e", "#5ed198",
    "#5ed1d1", "#5e98d1", "#5e5ed1", "#985ed1", "#d15ed1", "#d15e98",
    "#bf2626", "#bf7326", "#bfbf26", "#73bf26", "#26bf26", "#26bf73",
    "#26bfbf", "#2673bf", "#2626bf", "#7326bf", "#bf26bf", "#bf2673",
    "#fc8b8b", "#fcc48b", "#fcfc8b", "#c4fc8b", "#8bfc8b", "#8bfcc4",
    "#8bfcfc", "#8bc4fc", "#8b8bfc", "#c48bfc", "#fc8bfc", "#fc8bc4",
]


def _ensure_session_color(db, session_code):
    """确保某会话有稳定的主题色：已有则沿用并回填空行；没有则随机分配一个。

    - 若该会话已有任一行带色（用户改过色，或此前已分配），沿用该色并补齐本会话的空行。
    - 否则从调色盘挑一个「当前未被其他会话占用」的色（都占满则纯随机），写入本会话全部行。
    """
    existing = db.execute(text(
        "SELECT color FROM entries WHERE session_code = :s AND color IS NOT NULL LIMIT 1"
    ), {"s": session_code}).scalar()
    if existing:
        db.execute(text(
            "UPDATE entries SET color = :c WHERE session_code = :s AND color IS NULL"
        ), {"c": existing, "s": session_code})
        return
    used = {row[0] for row in db.execute(text(
        "SELECT DISTINCT color FROM entries WHERE color IS NOT NULL"
    )).fetchall()}
    free = [c for c in PALETTE if c not in used]
    chosen = random.choice(free) if free else random.choice(PALETTE)
    db.execute(text(
        "UPDATE entries SET color = :c WHERE session_code = :s"
    ), {"c": chosen, "s": session_code})


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
    # 分配/沿用会话主题色：新会话随机取色，已有色的会话沿用（不覆盖用户改色）。
    _ensure_session_color(db, e.id)


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


def get_entry_by_client_id(db, client_id):
    """按业务键 client_id(=day#seq) 取一条 entry。供 AI worker 溯源处理。"""
    r = db.execute(text(
        f"SELECT {_COLS} FROM entries WHERE client_id = :cid"
    ), {"cid": client_id}).fetchone()
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


def list_recent(db, days=30, devices=None):
    """取最近 N 天（含今天）的条目；devices 语义同 list_month（None=全部，[]=空结果）。"""
    if devices is not None and len(devices) == 0:
        return []
    import datetime as _dt
    since = (_dt.date.today() - _dt.timedelta(days=days - 1)).strftime("%Y-%m-%d")
    params = {"since": since}
    where = "day >= :since"
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


# ── AI 智能洞察（ai_insights 表）──
# demo 阶段：由 entries 派生（topic 用 project 充当，缺失归为「未归类」），
# 后续替换为真正的 AI 产出。分类维度为「设备 + 主题」，泳道仍以 session 为列、沿用会话色/名。
_AI_COLS = ("id, client_id, device, topic, session_code, emoji, name, title, summary, "
            "datetime, day, color")


def upsert_insight(db, client_id, topic, entry):
    """写入/更新一条 entry 的分类结果（按 client_id 幂等）。

    topic 由 AI 判定；标题/正文等沿用日志原文。会话色优先用 entry.color，
    否则用会话调色盘 colorOf 的服务端等价（这里直接取 entries.color，前端 aliases.js 再兜底）。
    """
    db.execute(text("""
        INSERT INTO ai_insights
          (client_id, device, topic, session_code, emoji, name, title, summary,
           datetime, day, color, created_at, updated_at)
        VALUES
          (:cid, :device, :topic, :sess, :emoji, :name, :title, :summary,
           :dt, :day, :color, datetime('now'), datetime('now'))
        ON CONFLICT(client_id) DO UPDATE SET
          device=excluded.device, topic=excluded.topic, session_code=excluded.session_code,
          emoji=excluded.emoji, name=excluded.name, title=excluded.title, summary=excluded.summary,
          datetime=excluded.datetime, day=excluded.day, color=excluded.color,
          updated_at=datetime('now')
    """), {
        "cid": client_id, "device": entry.get("device") or "", "topic": topic,
        "sess": entry.get("session_code"), "emoji": entry.get("emoji") or "",
        "name": entry.get("name") or "", "title": entry.get("title") or "",
        "summary": entry.get("summary") or "", "dt": entry.get("datetime"),
        "day": entry.get("day") or "", "color": entry.get("color"),
    })


def get_insight_topic(db, client_id):
    """取某 entry 当前归属的 topic（无则 None）。用于删除/改主题时定位受影响主题。"""
    return db.execute(text(
        "SELECT topic FROM ai_insights WHERE client_id=:c"), {"c": client_id}).scalar()


def delete_insight(db, client_id):
    db.execute(text("DELETE FROM ai_insights WHERE client_id=:c"), {"c": client_id})


def topic_entry_count(db, topic):
    return db.execute(text(
        "SELECT COUNT(*) FROM ai_insights WHERE topic=:t"), {"t": topic}).scalar() or 0


def topic_texts(db, topic, limit=200):
    """取某主题下全部日志的（标题, 正文, 时间），供主题级综述汇总。按时间升序。"""
    rows = db.execute(text(
        "SELECT title, summary, datetime FROM ai_insights WHERE topic=:t "
        "ORDER BY datetime ASC LIMIT :lim"), {"t": topic, "lim": limit}).fetchall()
    return [(r[0] or "", r[1] or "", r[2] or "") for r in rows]


def topic_color(db, topic):
    """取该主题下任一会话色作为主题代表色。"""
    return db.execute(text(
        "SELECT color FROM ai_insights WHERE topic=:t AND color IS NOT NULL LIMIT 1"),
        {"t": topic}).scalar()


def pending_resummarize_topics(db):
    """取所有待重算综述的主题名。"""
    rows = db.execute(text(
        "SELECT topic FROM ai_topics WHERE need_resummarize=1")).fetchall()
    return [r[0] for r in rows]


def save_topic_summary(db, topic, summary):
    """写入主题综述并清除重算标志，刷新计数/代表色。"""
    cnt = topic_entry_count(db, topic)
    color = topic_color(db, topic)
    db.execute(text("""
        INSERT INTO ai_topics (topic, summary, entry_count, need_resummarize, color, updated_at)
        VALUES (:t, :s, :cnt, 0, :color, datetime('now'))
        ON CONFLICT(topic) DO UPDATE SET summary=:s, entry_count=:cnt, need_resummarize=0,
          color=COALESCE(:color, ai_topics.color), updated_at=datetime('now')
    """), {"t": topic, "s": summary, "cnt": cnt, "color": color})


def delete_topic(db, topic):
    """删除空主题行（该主题已无任何日志时）。"""
    db.execute(text("DELETE FROM ai_topics WHERE topic=:t"), {"t": topic})


def list_topics_full(db, devices=None):
    """一级页面用：主题 + 综述 + 计数 + 代表色（按计数降序）。

    devices=None → 全部（用 ai_topics 缓存的综述与全量计数）。
    devices=[...] → 计数按该设备集合从 ai_insights 现算，只保留在此设备下有日志的主题；
    综述仍取全量综述（综述是跨全部日志的，不随设备切分重算）。
    """
    if devices is None:
        # 全量：主题综述/计数/emoji 都来自 ai_topics 缓存；会话数从 ai_insights 现算（缓存没存）
        rows = db.execute(text(
            "SELECT t.topic AS topic, t.summary AS summary, t.entry_count AS entry_count, "
            "  t.color AS color, t.emoji AS emoji, t.need_resummarize AS need_resummarize, "
            "  t.updated_at AS updated_at, "
            "  (SELECT COUNT(DISTINCT i.session_code) FROM ai_insights i WHERE i.topic = t.topic) AS session_count "
            "FROM ai_topics t WHERE t.entry_count > 0 "
            "ORDER BY t.entry_count DESC, t.topic")).fetchall()
        return [dict(r._mapping) for r in rows]
    if len(devices) == 0:
        return []
    ph = ", ".join(f":d{i}" for i in range(len(devices)))
    params = {f"d{i}": d for i, d in enumerate(devices)}
    rows = db.execute(text(
        f"SELECT i.topic AS topic, COUNT(*) AS entry_count, "
        f"  COUNT(DISTINCT i.session_code) AS session_count, "
        f"  MAX(i.color) AS color, "
        f"  (SELECT emoji FROM ai_topics t WHERE t.topic = i.topic) AS emoji, "
        f"  (SELECT summary FROM ai_topics t WHERE t.topic = i.topic) AS summary "
        f"FROM ai_insights i WHERE COALESCE(i.device,'') IN ({ph}) "
        f"GROUP BY i.topic ORDER BY entry_count DESC, i.topic"), params).fetchall()
    return [dict(r._mapping) for r in rows]


def list_failed_queue(db, limit=100):
    """列出已暂停（超重试上限）的失败队列项，供设置页展示 + 手动重试。"""
    rows = db.execute(text(
        "SELECT q.client_id, q.op, q.need_insight, q.need_embed, q.attempts, q.last_error, "
        "e.title AS title FROM ai_queue q "
        "LEFT JOIN entries e ON e.client_id = q.client_id "
        "WHERE q.paused=1 ORDER BY q.updated_at DESC LIMIT :lim"
    ), {"lim": limit}).fetchall()
    return [dict(r._mapping) for r in rows]


def retry_failed(db, client_id=None):
    """解除暂停以重试：指定 client_id 只重试该条，否则全部失败项。返回受影响条数。"""
    if client_id:
        r = db.execute(text(
            "UPDATE ai_queue SET paused=0, attempts=0, last_error='', updated_at=datetime('now') "
            "WHERE client_id=:c AND paused=1"), {"c": client_id})
    else:
        r = db.execute(text(
            "UPDATE ai_queue SET paused=0, attempts=0, last_error='', updated_at=datetime('now') "
            "WHERE paused=1"))
    return r.rowcount


def reset_classification(db):
    """重置主题分类+综述：清空 ai_insights / ai_topics，所有 entry 重新入队做分类。
    返回重新入队条数。（换模型/大改提示词后推倒重来用。）"""
    db.execute(text("DELETE FROM ai_insights"))
    db.execute(text("DELETE FROM ai_topics"))
    # 所有 entry 置 need_insight=1（保留 need_embed 现状：若已有向量则不动）
    rows = db.execute(text("SELECT client_id FROM entries")).fetchall()
    for (cid,) in [(r[0],) for r in rows]:
        db.execute(text("""
            INSERT INTO ai_queue (client_id, op, need_insight, need_embed, attempts, paused, last_error, enqueued_at, updated_at)
            VALUES (:c, 'upsert', 1, 0, 0, 0, '', datetime('now'), datetime('now'))
            ON CONFLICT(client_id) DO UPDATE SET op='upsert', need_insight=1,
              attempts=0, paused=0, last_error='', updated_at=datetime('now')
        """), {"c": cid})
    return len(rows)


def reset_embeddings(db):
    """重置向量知识库：清空 embeddings，所有 entry 重新入队做向量化。返回重新入队条数。"""
    db.execute(text("DELETE FROM embeddings"))
    rows = db.execute(text("SELECT client_id FROM entries")).fetchall()
    for (cid,) in [(r[0],) for r in rows]:
        db.execute(text("""
            INSERT INTO ai_queue (client_id, op, need_insight, need_embed, attempts, paused, last_error, enqueued_at, updated_at)
            VALUES (:c, 'upsert', 0, 1, 0, 0, '', datetime('now'), datetime('now'))
            ON CONFLICT(client_id) DO UPDATE SET op='upsert', need_embed=1,
              attempts=0, paused=0, last_error='', updated_at=datetime('now')
        """), {"c": cid})
    return len(rows)


def enqueue_all_entries(db, only_missing=True):
    """把 entries 全量（或仅「缺分类/缺向量」的）灌进 ai_queue，供 worker 消费。

    - only_missing=True：只补做缺失部分——没有 insight 的置 need_insight=1，
      没有 embedding 的置 need_embed=1；两者都齐的不入队。用于历史存量首次回填。
    - only_missing=False：强制全量重跑（两标志都置 1）。用于「全量重建」。
    重复入队走 ON CONFLICT 合并。返回入队条数。
    """
    if only_missing:
        rows = db.execute(text(
            "SELECT e.client_id, "
            "  CASE WHEN i.client_id IS NULL THEN 1 ELSE 0 END AS need_i, "
            "  CASE WHEN em.source_id IS NULL THEN 1 ELSE 0 END AS need_e "
            "FROM entries e "
            "LEFT JOIN ai_insights i ON i.client_id = e.client_id "
            "LEFT JOIN embeddings em ON em.source_type='entry' AND em.source_id = e.client_id"
        )).fetchall()
        todo = [(r[0], r[1], r[2]) for r in rows if (r[1] or r[2])]
    else:
        rows = db.execute(text("SELECT client_id FROM entries")).fetchall()
        todo = [(r[0], 1, 1) for r in rows]
    for cid, ni, ne in todo:
        db.execute(text("""
            INSERT INTO ai_queue (client_id, op, need_insight, need_embed, attempts, paused, last_error, enqueued_at, updated_at)
            VALUES (:c, 'upsert', :ni, :ne, 0, 0, '', datetime('now'), datetime('now'))
            ON CONFLICT(client_id) DO UPDATE SET op='upsert',
              need_insight=MAX(ai_queue.need_insight, :ni), need_embed=MAX(ai_queue.need_embed, :ne),
              attempts=0, paused=0, last_error='', updated_at=datetime('now')
        """), {"c": cid, "ni": ni, "ne": ne})
    return len(todo)


def list_ai_insights(db, topics=None, devices=None):
    """按主题 + 设备取 AI 洞察。topics/devices 为 None=全部，[]=空结果，数组=指定集合。"""
    if (topics is not None and len(topics) == 0) or (devices is not None and len(devices) == 0):
        return []
    where = "1=1"
    params = {}
    if devices is not None:
        ph = ", ".join(f":d{i}" for i in range(len(devices)))
        where += f" AND COALESCE(device,'') IN ({ph})"
        for i, d in enumerate(devices):
            params[f"d{i}"] = d
    if topics is not None:
        ph = ", ".join(f":t{i}" for i in range(len(topics)))
        where += f" AND topic IN ({ph})"
        for i, t in enumerate(topics):
            params[f"t{i}"] = t
    rows = db.execute(text(
        f"SELECT {_AI_COLS} FROM ai_insights WHERE {where} "
        "ORDER BY datetime ASC, id ASC"
    ), params).fetchall()
    return [dict(r._mapping) for r in rows]


def list_ai_topics(db):
    rows = db.execute(text(
        "SELECT topic, COUNT(*) AS cnt FROM ai_insights GROUP BY topic ORDER BY cnt DESC, topic"
    )).fetchall()
    return [{"topic": r[0], "count": r[1]} for r in rows]


def list_ai_devices(db):
    rows = db.execute(text(
        "SELECT DISTINCT COALESCE(device,'') AS d FROM ai_insights ORDER BY d"
    )).fetchall()
    return [r[0] for r in rows]


# ── RAG 向量：float32 小端 BLOB 存储 + 暴力余弦检索 ──
import struct as _struct
import math as _math


def vec_to_blob(vec):
    """float 序列 → float32 小端 BLOB。"""
    return _struct.pack(f"<{len(vec)}f", *vec)


def blob_to_vec(blob):
    """float32 小端 BLOB → float 列表。"""
    if not blob:
        return []
    n = len(blob) // 4
    return list(_struct.unpack(f"<{n}f", blob))


def upsert_embedding(db, source_type, source_id, model, dim, text_snippet, vec):
    """按 (source_type, source_id) 幂等写入向量。"""
    db.execute(text("""
        INSERT INTO embeddings (source_type, source_id, model, dim, text, vec, created_at, updated_at)
        VALUES (:st, :sid, :model, :dim, :text, :vec, datetime('now'), datetime('now'))
        ON CONFLICT(source_type, source_id) DO UPDATE SET
          model=excluded.model, dim=excluded.dim, text=excluded.text, vec=excluded.vec,
          updated_at=datetime('now')
    """), {"st": source_type, "sid": source_id, "model": model, "dim": dim,
           "text": text_snippet, "vec": vec_to_blob(vec)})


def embedding_stats(db):
    """向量库概况：总数、涉及模型、维度。供设置页/AI 页展示 RAG 就绪度。"""
    row = db.execute(text(
        "SELECT COUNT(*) AS cnt, "
        "(SELECT COUNT(DISTINCT model) FROM embeddings) AS models, "
        "(SELECT MAX(dim) FROM embeddings) AS dim FROM embeddings"
    )).fetchone()
    m = row._mapping
    return {"count": m["cnt"] or 0, "models": m["models"] or 0, "dim": m["dim"] or 0}


def get_embedding_meta(db, source_type, source_id):
    """取某来源已有向量的元信息（模型/维度），无则 None。用于判断是否需重嵌入。"""
    r = db.execute(text(
        "SELECT model, dim FROM embeddings WHERE source_type=:st AND source_id=:sid"
    ), {"st": source_type, "sid": source_id}).fetchone()
    return {"model": r[0], "dim": r[1]} if r else None


def delete_embedding(db, source_type, source_id):
    db.execute(text("DELETE FROM embeddings WHERE source_type=:st AND source_id=:sid"),
               {"st": source_type, "sid": source_id})


def clear_embeddings(db):
    db.execute(text("DELETE FROM embeddings"))


def search_embeddings(db, query_vec, top_k=8):
    """暴力余弦相似度检索：与库中所有向量比对，返回 top_k。
    本地单用户规模（数百~数千条）下 numpy/纯 Python 均在毫秒级。"""
    rows = db.execute(text(
        "SELECT source_type, source_id, model, dim, text, vec FROM embeddings"
    )).fetchall()
    if not rows:
        return []
    q = list(query_vec)
    qnorm = _math.sqrt(sum(x * x for x in q)) or 1.0
    try:
        import numpy as _np
        qa = _np.asarray(q, dtype=_np.float32)
        qn = float(_np.linalg.norm(qa)) or 1.0
        scored = []
        for r in rows:
            m = r._mapping
            v = _np.frombuffer(m["vec"], dtype=_np.float32) if m["vec"] else None
            if v is None or v.size != qa.size:
                continue
            denom = (float(_np.linalg.norm(v)) or 1.0) * qn
            sim = float(_np.dot(qa, v)) / denom
            scored.append((sim, m))
    except Exception:
        scored = []
        for r in rows:
            m = r._mapping
            v = blob_to_vec(m["vec"])
            if not v or len(v) != len(q):
                continue
            dot = sum(a * b for a, b in zip(q, v))
            vnorm = _math.sqrt(sum(x * x for x in v)) or 1.0
            scored.append((dot / (qnorm * vnorm), m))
    scored.sort(key=lambda t: t[0], reverse=True)
    out = []
    for sim, m in scored[:top_k]:
        out.append({"source_type": m["source_type"], "source_id": m["source_id"],
                    "text": m["text"], "score": round(sim, 4)})
    return out
