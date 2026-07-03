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
