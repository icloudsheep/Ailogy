"""AI 两条流水线的具体实现，由 ai_worker 逐条调用。

- process_embed(db, client_id)     ：向量化固化（本任务实现）
- process_insight(db, client_id)   ：分类固化，返回 topic（后续任务）
- handle_delete(db, client_id)     ：删除联动，返回受影响 topic（后续任务）
- resummarize_pending(db, extra)   ：主题级综述重算（后续任务）

约定：这些函数只做「一条/一批」的实际工作，队列状态机（清标志/出队/失败计数）由 worker 管。
出错时直接抛异常，worker 负责 attempts+1 / paused。
"""
from . import repo, ai_config, ai_client


def _embed_text(entry) -> str:
    """拼接用于向量化的文本：标题 + 正文。"""
    title = (entry.get("title") or "").strip()
    summary = (entry.get("summary") or "").strip()
    return (title + "\n" + summary).strip() if title else summary


def process_embed(db, client_id):
    """向量化固化：取 entry → 调 embed 模型 → upsert embeddings。

    若已有向量且模型未变、内容未变，可跳过（幂等）；模型变了则重嵌入。
    向量入口走 resolve_embed_endpoint（支持独立向量 API 或复用对话入口）。
    """
    entry = repo.get_entry_by_client_id(db, client_id)
    if not entry:
        # entry 已不存在（可能刚被删）；交由 delete 流程清理，这里直接视为完成
        return
    text_snippet = _embed_text(entry)
    if not text_snippet:
        return  # 空内容不嵌入

    emb = ai_config.resolve_embed_endpoint(db)
    base, key, model = emb.get("base_url"), emb.get("api_key"), emb.get("model")
    if not (base and model):
        raise RuntimeError("向量入口未配置（base_url/model 缺失）")

    # 模型未变且已有向量 → 认为最新，跳过（内容变更时触发器已重置队列，会走到这里重嵌）
    meta = repo.get_embedding_meta(db, "entry", client_id)
    # 内容是否变了无法只凭 meta 判断，这里策略：只要队列把 need_embed 置了 1 就重算，
    # 但若模型一致且文本一致可省调用——文本一致性通过比对 embeddings.text 实现
    if meta and meta.get("model") == model:
        existing = db.execute(
            __import__("sqlalchemy").text(
                "SELECT text FROM embeddings WHERE source_type='entry' AND source_id=:sid"),
            {"sid": client_id}).scalar()
        if existing == text_snippet:
            return  # 模型与文本都没变，无需重嵌

    r = ai_client.embed(base, key, model, [text_snippet], timeout=60.0)
    if not r.get("ok"):
        raise RuntimeError(f"embed 失败 HTTP {r.get('status')}: {r.get('error')}")
    vectors = r.get("vectors") or []
    if not vectors:
        raise RuntimeError("embed 返回空向量")
    vec = vectors[0]
    repo.upsert_embedding(db, "entry", client_id, model, r.get("dim") or len(vec), text_snippet, vec)
    # 回填维度，便于设置页展示 & 一致性校验
    if r.get("dim"):
        cur = ai_config.get_config_raw(db)
        if cur.get("embed_dim") != r["dim"]:
            ai_config.save_config(db, {"embed_dim": int(r["dim"])})


def _chat_endpoint(db):
    cfg = ai_config.get_config_raw(db)
    return cfg.get("base_url"), cfg.get("api_key"), cfg.get("chat_model"), cfg.get("prompts") or {}


def process_insight(db, client_id):
    """分类固化：一次结构化调用只回 topic（复用已有主题、避免碎片化），写入 ai_insights。
    返回判定出的 topic（供 worker 汇入「受影响主题」以重算综述）。"""
    entry = repo.get_entry_by_client_id(db, client_id)
    if not entry:
        return None
    base, key, model, prompts = _chat_endpoint(db)
    if not (base and key and model):
        raise RuntimeError("对话入口未配置")

    existing = [t["topic"] for t in repo.list_ai_topics(db)]  # 已有主题，供复用
    sys_prompt = prompts.get("classify") or ai_config.DEFAULT_PROMPTS["classify"]
    title = (entry.get("title") or "").strip()
    summary = (entry.get("summary") or "").strip()
    user = (
        f"已有主题列表（尽量复用，语义相近就归入同一个）：{existing or '（暂无）'}\n\n"
        f"待分类日志：\n标题：{title}\n正文：{summary[:2000]}\n\n"
        '只输出 JSON：{"topic": "主题名"}'
    )
    r = ai_client.chat_json(base, key, model, [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user},
    ], timeout=60.0)
    if not r.get("ok"):
        raise RuntimeError(f"分类失败 HTTP {r.get('status')}: {r.get('error')}")
    topic = (r["data"].get("topic") or "").strip() if isinstance(r.get("data"), dict) else ""
    if not topic:
        topic = "未归类"

    prev = repo.get_insight_topic(db, client_id)   # 改主题时旧主题也需重算综述
    repo.upsert_insight(db, client_id, topic, entry)
    _touch_topic(db, topic)
    if prev and prev != topic:
        _touch_topic(db, prev)
        return {topic, prev}   # worker 会 update(set) 合并
    return topic


def _touch_topic(db, topic):
    """确保 ai_topics 有该主题行，并标记需重算综述、刷新计数与代表色。"""
    from sqlalchemy import text as _t
    cnt = repo.topic_entry_count(db, topic)
    color = repo.topic_color(db, topic)
    db.execute(_t("""
        INSERT INTO ai_topics (topic, summary, entry_count, need_resummarize, color, updated_at)
        VALUES (:t, '', :cnt, 1, :color, datetime('now'))
        ON CONFLICT(topic) DO UPDATE SET entry_count=:cnt, need_resummarize=1,
          color=COALESCE(excluded.color, ai_topics.color), updated_at=datetime('now')
    """), {"t": topic, "cnt": cnt, "color": color})


def handle_delete(db, client_id):
    """删除联动：清该 entry 的向量与分类，返回其原主题（需重算综述/可能清空）。"""
    repo.delete_embedding(db, "entry", client_id)
    topic = repo.get_insight_topic(db, client_id)
    repo.delete_insight(db, client_id)
    if topic:
        _touch_topic(db, topic)   # 刷新计数；若归零，综述重算时会清理空主题
    return topic


def resummarize_pending(db, extra_topics=None):
    """批末防抖：对所有 need_resummarize=1 的主题（并合入本批 extra_topics）各重算一次综述。

    一主题一总结：跨条汇总该主题下全部日志成一段更高视角综述。
    主题已无日志（计数=0）→ 删除该主题行（空主题不展示）。
    这里是「批末」调用，天然对同批多次变更去重（同一主题只算一次）。
    """
    base, key, model, prompts = _chat_endpoint(db)
    if not (base and key and model):
        return
    pending = set(repo.pending_resummarize_topics(db))
    if extra_topics:
        pending.update(extra_topics if isinstance(extra_topics, (set, list, tuple)) else [extra_topics])
    if not pending:
        return
    sys_prompt = prompts.get("summarize") or ai_config.DEFAULT_PROMPTS["summarize"]
    for topic in pending:
        cnt = repo.topic_entry_count(db, topic)
        if cnt == 0:
            repo.delete_topic(db, topic)   # 空主题清理
            continue
        rows = repo.topic_texts(db, topic, limit=200)
        # 拼汇总输入：逐条「时间 · 标题：正文」，超长截断，避免一条正文撑爆上下文
        parts = []
        for title, summary, dt in rows:
            seg = f"[{(dt or '')[:16]}] {title}：{summary}".strip()
            parts.append(seg[:600])
        joined = "\n".join(parts)[:12000]
        user = (
            f"主题「{topic}」下共有 {cnt} 条工作日志，按时间排列如下。\n"
            f"请站在更高、更全的视角，把它们汇总成一段该主题的综述"
            f"（说清这个主题在做什么、进展脉络、关键成果，不要逐条罗列）：\n\n{joined}"
        )
        r = ai_client.chat_complete(base, key, model, [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user},
        ], timeout=90.0)
        if not r.get("ok"):
            # 综述失败不阻断整批：保留 need_resummarize=1，下轮再试
            import logging
            logging.getLogger("ai_pipelines").warning(
                "topic '%s' resummarize failed: %s", topic, r.get("error"))
            continue
        summary_text = (r.get("content") or "").strip()
        repo.save_topic_summary(db, topic, summary_text)
