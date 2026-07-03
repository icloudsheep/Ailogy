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
_AI_COLS = ("id, device, topic, session_code, emoji, name, title, summary, "
            "datetime, color, src_client_id")


def rebuild_ai_from_entries(db):
    """demo 脚手架：清空并从 entries 重建 ai_insights（topic=project，空则「未归类」）。

    每条 entry 派生一条 insight，沿用其会话代号/emoji/名字/颜色。真实 AI 接入后此函数将被替换。
    """
    db.execute(text("DELETE FROM ai_insights"))
    rows = db.execute(text(
        "SELECT device, project, session_code, emoji, name, title, summary, datetime, color, client_id "
        "FROM entries ORDER BY datetime ASC, id ASC"
    )).fetchall()
    for r in rows:
        m = r._mapping
        topic = (m["project"] or "").strip() or "未归类"
        db.execute(text("""
            INSERT INTO ai_insights
              (device, topic, session_code, emoji, name, title, summary, datetime, color, src_client_id,
               created_at, updated_at)
            VALUES
              (:device, :topic, :session_code, :emoji, :name, :title, :summary, :datetime, :color, :src,
               datetime('now'), datetime('now'))
        """), {
            "device": m["device"] or "", "topic": topic, "session_code": m["session_code"],
            "emoji": m["emoji"] or "", "name": m["name"] or "", "title": m["title"] or "",
            "summary": m["summary"] or "", "datetime": m["datetime"], "color": m["color"],
            "src": m["client_id"],
        })
    return len(rows)


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
