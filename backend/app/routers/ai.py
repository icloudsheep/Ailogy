"""AI 智能路由：按「设备 + 主题」组织的洞察（insight）泳道数据。

demo 阶段：数据由 entries 派生（topic 暂用 project 充当），通过 /api/ai/rebuild 重建。
后续 AI 直接读库/接 binlog 产出 ai_insights，本层查询接口保持不变。
无鉴权——本地单用户部署。
"""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from .. import repo, ai_config

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/insights")
def insights(
    topics: str = Query(None, description="逗号分隔的主题；省略=全部"),
    devices: str = Query(None, description="逗号分隔的设备名；省略=全部"),
    db: Session = Depends(get_db),
):
    """二级页面：某主题下的日志（entry→topic 映射），供按会话/月/天排布。"""
    topic_list = None if topics is None else [t for t in topics.split(",")] if topics != "" else []
    dev_list = None if devices is None else [d for d in devices.split(",")] if devices != "" else []
    return {"items": repo.list_ai_insights(db, topic_list, dev_list)}


@router.get("/topics")
def topics(
    devices: str = Query(None, description="逗号分隔的设备名；省略=全部"),
    db: Session = Depends(get_db),
):
    """一级页面（爆炸图）：主题 + 综述 + 计数 + 代表色。可按设备过滤（计数只算该设备下的日志）。"""
    dev_list = None if devices is None else [d for d in devices.split(",")] if devices != "" else []
    return {"topics": repo.list_topics_full(db, dev_list)}


@router.get("/devices")
def devices(db: Session = Depends(get_db)):
    return {"devices": repo.list_ai_devices(db)}


@router.post("/backfill")
def backfill(db: Session = Depends(get_db)):
    """把历史存量日志灌进队列（只补缺失的分类/向量），交由 worker 处理。"""
    n = repo.enqueue_all_entries(db, only_missing=True)
    db.commit()
    _nudge()
    return {"ok": True, "enqueued": n}


def _nudge():
    try:
        from .. import ai_worker
        ai_worker.nudge()
    except Exception:
        pass


# ── AI 配置：API 入口 / 密钥 / 模型 / 各场景系统提示词 ──
class ConfigPatch(BaseModel):
    base_url: str = None
    api_key: str = None
    chat_model: str = None
    embed_use_chat: bool = None
    embed_base_url: str = None
    embed_api_key: str = None
    embed_model: str = None
    prompts: dict = None
    # 运行参数（设置「运行」子类）
    worker_enabled: bool = None
    batch_size: int = None
    poll_interval: int = None
    retry_limit: int = None
    recompute_on_update: str = None


@router.get("/config")
def get_config(db: Session = Depends(get_db)):
    """回吐配置（密钥脱敏）+ 内置默认提示词，供设置页展示「恢复默认」对照。"""
    cfg = ai_config.get_config_public(db)
    cfg["default_prompts"] = ai_config.DEFAULT_PROMPTS
    return cfg


@router.put("/config")
def put_config(patch: ConfigPatch, db: Session = Depends(get_db)):
    """按补丁更新配置。密钥为空/掩码时保持不变（不会被掩码串覆盖）。"""
    pub = ai_config.save_config(db, patch.model_dump(exclude_none=True))
    db.commit()
    return pub


class ResetPromptReq(BaseModel):
    scene: str


@router.post("/config/reset-prompt")
def reset_prompt(req: ResetPromptReq, db: Session = Depends(get_db)):
    pub = ai_config.reset_prompt(db, req.scene)
    db.commit()
    return pub


@router.post("/test")
def test_connection(db: Session = Depends(get_db)):
    """真实探测：向对话与向量接口各发一次最小请求，返回命令行风格的分步日志。

    前端把 log 逐行打印到向量卡片下方的终端窗口。每步含耗时、状态与关键回传摘要。
    """
    from .. import ai_client
    cfg = ai_config.get_config_raw(db)
    log = []

    def line(tag, msg):
        log.append({"tag": tag, "msg": msg})

    ok_all = True

    # ── 对话接口 ──
    base, key, cmodel = (cfg.get("base_url") or "").strip(), (cfg.get("api_key") or "").strip(), (cfg.get("chat_model") or "").strip()
    line("info", "── 对话模型 ──")
    if not (base and key and cmodel):
        miss = [n for n, v in (("Base URL", base), ("API Key", key), ("模型名", cmodel)) if not v]
        line("err", f"配置不完整，缺少：{'、'.join(miss)}")
        ok_all = False
    else:
        line("cmd", f"POST {base.rstrip('/')}/chat/completions  (model={cmodel})")
        r = ai_client.chat_complete(base, key, cmodel,
                                    [{"role": "user", "content": "回复两个字：连通"}],
                                    timeout=30.0, max_tokens=16)
        if r["ok"]:
            line("ok", f"HTTP {r['status']} · {r['ms']}ms · 回传：{(r.get('content') or '').strip()[:60] or '(空)'}")
            if r.get("usage"):
                line("dim", f"usage: {r['usage']}")
        else:
            line("err", f"HTTP {r.get('status')} · {r['ms']}ms · {r.get('error')}")
            ok_all = False

    # ── 向量接口 ──
    emb = ai_config.resolve_embed_endpoint(db)
    ebase, ekey, emodel = (emb.get("base_url") or "").strip(), (emb.get("api_key") or "").strip(), (emb.get("model") or "").strip()
    reuse = bool(cfg.get("embed_use_chat", True))
    line("info", f"── 向量模型{'（复用对话入口）' if reuse else ''} ──")
    if not (ebase and emodel):
        miss = [n for n, v in (("Base URL", ebase), ("模型名", emodel)) if not v]
        line("err", f"配置不完整，缺少：{'、'.join(miss)}")
        ok_all = False
    else:
        line("cmd", f"POST {ebase.rstrip('/')}/embeddings  (model={emodel})")
        r = ai_client.embed(ebase, ekey, emodel, ["连通性测试"], timeout=30.0)
        if r["ok"]:
            line("ok", f"HTTP {r['status']} · {r['ms']}ms · 向量维度：{r.get('dim')}")
            # 回填维度，供 RAG 一致性校验
            if r.get("dim"):
                ai_config.save_config(db, {"embed_dim": int(r["dim"])})
                db.commit()
        else:
            line("err", f"HTTP {r.get('status')} · {r['ms']}ms · {r.get('error')}")
            ok_all = False

    line("done", "测试完成 ✓" if ok_all else "测试结束，存在失败项 ✗")
    return {"ok": ok_all, "log": log}


# ── RAG 向量库概况（骨架：真实 embedding 入库后此处反映进度）──
@router.get("/rag/stats")
def rag_stats(db: Session = Depends(get_db)):
    return repo.embedding_stats(db)


# ── worker 实时状态 + 队列 + 失败重试 + 重置（供设置页「运行」子类）──
@router.get("/worker/status")
def worker_status(log_after: float = Query(0.0), db: Session = Depends(get_db)):
    """worker 实时快照：忙/阶段/进度/累计 token/增量日志 + 队列概况 + 失败列表。
    前端每秒轮询以更新 toast 的 token 与运行终端。"""
    from .. import ai_status, ai_worker
    snap = ai_status.snapshot(log_after=log_after)
    return {
        "status": snap,
        "queue": ai_worker.queue_stats(db),
        "failed": repo.list_failed_queue(db),
    }


class RetryReq(BaseModel):
    client_id: str = None


@router.post("/worker/retry")
def worker_retry(req: RetryReq, db: Session = Depends(get_db)):
    n = repo.retry_failed(db, req.client_id)
    db.commit()
    _nudge()
    return {"ok": True, "retried": n}


@router.post("/reset/classification")
def reset_classification(db: Session = Depends(get_db)):
    """重置主题分类 + 综述，全量重跑分类。"""
    n = repo.reset_classification(db)
    db.commit()
    _nudge()
    return {"ok": True, "enqueued": n}


@router.post("/reset/embeddings")
def reset_embeddings(db: Session = Depends(get_db)):
    """重置向量知识库，全量重嵌入。"""
    n = repo.reset_embeddings(db)
    db.commit()
    _nudge()
    return {"ok": True, "enqueued": n}


# ═══════════════════ RAG 问答（提问按钮驱动）═══════════════════
# 交互：
#   1) POST /ai/ask/search   传 question → 返回 top-K 相似日志片段（预览）
#   2) POST /ai/ask/stream   传 question + 选中的 ref ids → SSE 流式返回回答
#   3) GET  /ai/ask/history  → 历史列表（服务端持久化）
#   4) DELETE /ai/ask/history/{id} → 删单条
class AskSearchReq(BaseModel):
    question: str
    top_k: int = 6


@router.post("/ask/search")
def ask_search(req: AskSearchReq, db: Session = Depends(get_db)):
    """问答第一步：向量检索相关日志，供用户预览确认。"""
    from .. import ai_client
    q = (req.question or "").strip()
    if not q:
        return {"ok": False, "error": "问题为空"}
    emb = ai_config.resolve_embed_endpoint(db)
    if not (emb.get("base_url") and emb.get("model")):
        return {"ok": False, "error": "向量入口未配置"}
    r = ai_client.embed(emb["base_url"], emb.get("api_key"), emb["model"], [q], timeout=30.0)
    if not r.get("ok"):
        return {"ok": False, "error": f"向量化失败：{r.get('error')}"}
    vec = (r.get("vectors") or [None])[0]
    if not vec:
        return {"ok": False, "error": "向量化返回空"}
    refs = repo.search_embeddings(db, vec, top_k=max(1, min(20, int(req.top_k or 6))))
    # 补充溯源信息（title/topic/device/day）方便前端展示
    for ref in refs:
        cid = ref.get("source_id")
        if not cid:
            continue
        e = repo.get_entry_by_client_id(db, cid)
        if e:
            ref["title"] = e.get("title") or ""
            ref["day"] = e.get("day") or ""
            ref["device"] = e.get("device") or ""
        t = repo.get_insight_topic(db, cid)
        if t:
            ref["topic"] = t
    return {"ok": True, "refs": refs}


class AskStreamReq(BaseModel):
    question: str
    ref_ids: list = None    # 用户勾选的日志 client_id 列表；空/None 则用 top-K 自动检索
    topic: str = None       # 若指定：以该主题所有日志作为上下文（用于右键"就此主题提问"）
    save: bool = True       # 结束时保存到历史


@router.post("/ask/stream")
def ask_stream(req: AskStreamReq, db: Session = Depends(get_db)):
    """问答第二步：SSE 流式返回。每帧 `data: <json>` 一行，
    payload: {"delta":"..."} 或 {"done":true, "answer_id":"..."} 或 {"error":"..."}
    """
    from fastapi.responses import StreamingResponse
    from .. import ai_client
    import json as _json, time as _time, uuid as _uuid

    q = (req.question or "").strip()
    if not q:
        return {"ok": False, "error": "问题为空"}
    cfg = ai_config.get_config_raw(db)
    if not (cfg.get("base_url") and cfg.get("api_key") and cfg.get("chat_model")):
        return {"ok": False, "error": "对话入口未配置"}

    # 组装上下文：topic > ref_ids > 自动 top-K
    ref_ids = req.ref_ids or []
    refs_ctx = []
    if req.topic:
        # 就此主题提问：拉该主题下所有日志（限 30 条，按时间倒序取最新）
        items = repo.list_ai_insights(db, topics=[req.topic], devices=None) or []
        items = items[-30:]     # list_ai_insights 是升序，取尾部 = 最新 30 条
        for it in items:
            refs_ctx.append({
                "title": it.get("title") or "",
                "day": it.get("day") or "",
                "topic": req.topic,
                "text": (it.get("summary") or "")[:1200],
            })
    elif ref_ids:
        for cid in ref_ids[:20]:
            e = repo.get_entry_by_client_id(db, cid)
            if not e:
                continue
            refs_ctx.append({
                "title": e.get("title") or "",
                "day": e.get("day") or "",
                "topic": repo.get_insight_topic(db, cid) or "",
                "text": (e.get("summary") or "")[:1500],
            })
    else:
        emb = ai_config.resolve_embed_endpoint(db)
        if emb.get("base_url") and emb.get("model"):
            er = ai_client.embed(emb["base_url"], emb.get("api_key"), emb["model"], [q], timeout=30.0)
            vec = (er.get("vectors") or [None])[0] if er.get("ok") else None
            if vec:
                for ref in repo.search_embeddings(db, vec, top_k=6):
                    cid = ref.get("source_id")
                    e = repo.get_entry_by_client_id(db, cid) if cid else None
                    refs_ctx.append({
                        "title": (e or {}).get("title") or "",
                        "day": (e or {}).get("day") or "",
                        "topic": (repo.get_insight_topic(db, cid) if cid else "") or "",
                        "text": ((e or {}).get("summary") or ref.get("text", ""))[:1500],
                    })

    prompts = cfg.get("prompts") or {}
    sys_prompt = prompts.get("ask") or (
        "你是一个基于日志的问答助手。根据「参考日志」回答用户问题。"
        "引用日志时用 [n] 标注对应参考编号，不要编造未在参考中出现的事实。"
        "回答用简洁的中文；必要时可用 markdown（标题/列表/代码块）。"
    )
    ctx_lines = []
    for i, r in enumerate(refs_ctx, 1):
        head = f"[{i}] "
        if r.get("topic"):
            head += f"主题《{r['topic']}》 · "
        if r.get("day"):
            head += f"{r['day']} · "
        if r.get("title"):
            head += r["title"]
        ctx_lines.append(head + "\n" + (r.get("text") or ""))
    user_msg = f"问题：{q}\n\n参考日志：\n" + ("\n\n".join(ctx_lines) if ctx_lines else "（无相关日志）")

    def gen():
        answer_full = ""
        answer_id = _uuid.uuid4().hex[:12]
        try:
            for piece in ai_client.chat_stream(
                cfg["base_url"], cfg["api_key"], cfg["chat_model"],
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                timeout=180.0,
            ):
                if isinstance(piece, dict):
                    if piece.get("__error__"):
                        yield "data: " + _json.dumps({"error": piece["__error__"]}, ensure_ascii=False) + "\n\n"
                        return
                    if piece.get("__done__"):
                        break
                    continue
                answer_full += piece
                yield "data: " + _json.dumps({"delta": piece}, ensure_ascii=False) + "\n\n"
            # 保存历史（可选）
            if req.save and answer_full.strip():
                _append_history(db, {
                    "id": answer_id,
                    "ts": int(_time.time()),
                    "question": q,
                    "answer": answer_full,
                    "refs": [{"id": r.get("source_id") if isinstance(r, dict) else None,
                              "title": r.get("title"), "topic": r.get("topic")}
                             for r in refs_ctx],
                })
            yield "data: " + _json.dumps({"done": True, "answer_id": answer_id}, ensure_ascii=False) + "\n\n"
        except Exception as e:
            yield "data: " + _json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    })


HISTORY_KEY = "ai:ask_history"
HISTORY_MAX = 100


def _append_history(db, item):
    """把一条问答追加到 prefs 里的历史队列，保留最多 HISTORY_MAX 条。"""
    import json as _json
    cur = repo.get_pref(db, HISTORY_KEY)
    try:
        arr = _json.loads(cur) if cur else []
        if not isinstance(arr, list):
            arr = []
    except Exception:
        arr = []
    arr.append(item)
    if len(arr) > HISTORY_MAX:
        arr = arr[-HISTORY_MAX:]
    repo.set_pref(db, HISTORY_KEY, _json.dumps(arr, ensure_ascii=False))
    db.commit()


@router.get("/ask/history")
def ask_history(db: Session = Depends(get_db)):
    """按时间倒序列出提问历史。"""
    import json as _json
    cur = repo.get_pref(db, HISTORY_KEY)
    try:
        arr = _json.loads(cur) if cur else []
    except Exception:
        arr = []
    if not isinstance(arr, list):
        arr = []
    arr = list(reversed(arr))
    return {"ok": True, "items": arr}


@router.delete("/ask/history/{item_id}")
def ask_history_delete(item_id: str, db: Session = Depends(get_db)):
    """删除单条历史。"""
    import json as _json
    cur = repo.get_pref(db, HISTORY_KEY)
    try:
        arr = _json.loads(cur) if cur else []
    except Exception:
        arr = []
    if not isinstance(arr, list):
        arr = []
    arr2 = [x for x in arr if x.get("id") != item_id]
    repo.set_pref(db, HISTORY_KEY, _json.dumps(arr2, ensure_ascii=False))
    db.commit()
    return {"ok": True, "removed": len(arr) - len(arr2)}


@router.delete("/ask/history")
def ask_history_clear(db: Session = Depends(get_db)):
    """清空所有提问历史。"""
    import json as _json
    repo.set_pref(db, HISTORY_KEY, _json.dumps([], ensure_ascii=False))
    db.commit()
    return {"ok": True}
