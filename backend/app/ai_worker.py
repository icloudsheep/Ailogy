"""AI 后台 worker：消费 ai_queue，驱动「分类固化」与「向量化固化」两条流水线。

运行形态（本地单用户）：
- FastAPI lifespan 启动一个单例 asyncio 任务，全程常驻。
- 唤醒 = 事件驱动 + 兜底轮询：平时等 ingest 的 nudge()（近实时）；等满 poll_interval
  秒没人叫也自己扫一轮（兜底，捞掉丢失的信号、手动改库、重启后的积压）。
- 判据永远是「队列里还有没有待办」，信号只决定「多快去查」，不决定「查不查」→ 不漏。
- 就绪门控：AI 配置没配齐则本轮跳过，不刷错误。
- 取批次：未 paused 的待办，按 enqueued_at 升序；失败(attempts>0)的垫后并单独限流，
  不堵新日志（详见 fetch_batch）。

本文件（骨架阶段）只负责调度与队列状态机；真正的 AI 调用由 pipelines.py 提供的
process_insight / process_embed / resummarize_topics 完成（后续任务接入）。缺失时安全空跑。
"""
import asyncio
import threading

from sqlalchemy import text

from .db import SessionLocal
from . import ai_config

# 单例状态
_task = None
_wake = None          # asyncio.Event：ingest/接口催促「尽快跑一轮」
_loop = None          # worker 所在事件循环（供跨线程 nudge）
_running = False
BATCH = 20            # 每轮最多处理条数
FAIL_SLICE = 5        # 每轮最多重试的失败条数（垫后、限流，避免堵新日志）


def nudge():
    """催促 worker 尽快跑一轮（线程安全）。ingest 提交后调用。"""
    if _wake is None or _loop is None:
        return
    try:
        _loop.call_soon_threadsafe(_wake.set)
    except Exception:
        pass


def start(app=None):
    """在 lifespan 里调用：启动单例 worker 任务。"""
    global _task, _wake, _loop, _running
    if _running:
        return
    _running = True
    _wake = asyncio.Event()
    _loop = asyncio.get_event_loop()
    _task = _loop.create_task(_run())


async def stop():
    """lifespan 关闭时调用：优雅停止。"""
    global _running, _task
    _running = False
    if _wake:
        _wake.set()
    if _task:
        try:
            await asyncio.wait_for(_task, timeout=5)
        except Exception:
            _task.cancel()


async def _run():
    """主循环：事件唤醒 + 兜底轮询。处理放到线程池（DB/HTTP 是同步的）。"""
    while _running:
        interval = _poll_interval()
        try:
            await asyncio.wait_for(_wake.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass  # 兜底轮询：没人叫也扫一轮
        _wake.clear()
        if not _running:
            break
        try:
            await asyncio.to_thread(_process_once)
        except Exception as e:  # 单轮异常不拖垮循环
            import logging
            logging.getLogger("ai_worker").warning("worker round failed: %s", e)


def _poll_interval() -> int:
    """读配置的兜底轮询间隔；worker 关闭时用较长间隔待命。"""
    db = SessionLocal()
    try:
        cfg = ai_config.get_config_raw(db)
        if not cfg.get("worker_enabled", True):
            return 60
        return int(cfg.get("poll_interval", 20) or 20)
    except Exception:
        return 20
    finally:
        db.close()


def _process_once():
    """同步执行一轮：就绪门控 → 取批次 → 逐条处理 → 批末重算受影响主题综述。"""
    db = SessionLocal()
    try:
        cfg = ai_config.get_config_raw(db)
        if not cfg.get("worker_enabled", True):
            return
        chat_ready = all((cfg.get(k) or "").strip() for k in ("base_url", "api_key", "chat_model"))
        emb = ai_config.resolve_embed_endpoint(db)
        embed_ready = bool((emb.get("base_url") or "").strip() and (emb.get("model") or "").strip())
        if not chat_ready and not embed_ready:
            return  # 完全没配好，静默跳过

        rows = _fetch_batch(db)
        if not rows:
            return

        # 流水线函数按需引入（未实现时安全跳过），避免循环依赖
        try:
            from . import ai_pipelines as P
        except Exception:
            P = None

        affected_topics = set()
        for r in rows:
            cid, op = r["client_id"], r["op"]
            try:
                if op == "delete":
                    if P:
                        t = P.handle_delete(db, cid)
                        if t:
                            affected_topics.add(t)
                    _dequeue(db, cid)
                    continue
                # upsert：两条流水线各自按标志推进、互不拖累
                if r["need_embed"] and embed_ready and P:
                    P.process_embed(db, cid)
                    _clear_flag(db, cid, "need_embed")
                if r["need_insight"] and chat_ready and P:
                    topic = P.process_insight(db, cid)
                    _clear_flag(db, cid, "need_insight")
                    if topic:
                        # process_insight 可能返回单个 topic 或 {新,旧} 集合（改主题时）
                        affected_topics.update(topic if isinstance(topic, (set, list, tuple)) else [topic])
                _maybe_dequeue(db, cid)
                db.commit()
            except Exception as e:
                _mark_failed(db, cid, str(e), int(cfg.get("retry_limit", 1) or 0))
                db.commit()

        # 批末：对受影响主题防抖各重算一次综述（含被标 need_resummarize 的）
        if P and chat_ready:
            try:
                P.resummarize_pending(db, extra_topics=affected_topics)
                db.commit()
            except Exception as e:
                import logging
                logging.getLogger("ai_worker").warning("resummarize failed: %s", e)
    finally:
        db.close()


def _fetch_batch(db):
    """取本轮待办：未 paused 的 upsert/delete。
    排序策略：删除优先（清理快）→ 新条目(attempts=0)优先 → 失败条目(attempts>0)垫后且限流。
    这样一批失败不会堵住新日志的及时处理。"""
    # 新条目 + 删除：主批
    fresh = db.execute(text(
        "SELECT client_id, op, need_insight, need_embed, attempts FROM ai_queue "
        "WHERE paused=0 AND attempts=0 AND (need_insight=1 OR need_embed=1 OR op='delete') "
        "ORDER BY (op='delete') DESC, enqueued_at ASC LIMIT :lim"
    ), {"lim": BATCH}).mappings().all()
    remaining = BATCH - len(fresh)
    retry = []
    if remaining > 0:
        retry = db.execute(text(
            "SELECT client_id, op, need_insight, need_embed, attempts FROM ai_queue "
            "WHERE paused=0 AND attempts>0 AND (need_insight=1 OR need_embed=1 OR op='delete') "
            "ORDER BY enqueued_at ASC LIMIT :lim"
        ), {"lim": min(remaining, FAIL_SLICE)}).mappings().all()
    return list(fresh) + list(retry)


def _clear_flag(db, cid, flag):
    db.execute(text(f"UPDATE ai_queue SET {flag}=0, updated_at=datetime('now') WHERE client_id=:c"),
               {"c": cid})


def _maybe_dequeue(db, cid):
    """两条流水线都完成（need_insight=0 且 need_embed=0）则出队。"""
    db.execute(text(
        "DELETE FROM ai_queue WHERE client_id=:c AND need_insight=0 AND need_embed=0 AND op='upsert'"
    ), {"c": cid})


def _dequeue(db, cid):
    db.execute(text("DELETE FROM ai_queue WHERE client_id=:c"), {"c": cid})
    db.commit()


def _mark_failed(db, cid, err, retry_limit):
    """失败累加 attempts；超上限置 paused（暂停自动重试，等手动/新变更带起）。"""
    db.execute(text(
        "UPDATE ai_queue SET attempts=attempts+1, last_error=:e, "
        "paused=CASE WHEN attempts+1 > :lim THEN 1 ELSE 0 END, updated_at=datetime('now') "
        "WHERE client_id=:c"
    ), {"e": (err or "")[:500], "lim": retry_limit, "c": cid})


def queue_stats(db):
    """队列概况，供设置页「运行」子类展示。"""
    row = db.execute(text(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN paused=1 THEN 1 ELSE 0 END) AS paused, "
        "SUM(CASE WHEN paused=0 AND (need_insight=1 OR need_embed=1 OR op='delete') THEN 1 ELSE 0 END) AS pending "
        "FROM ai_queue"
    )).mappings().first()
    return {"total": row["total"] or 0, "paused": row["paused"] or 0, "pending": row["pending"] or 0}
