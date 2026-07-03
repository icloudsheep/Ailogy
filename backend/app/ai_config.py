"""AI 配置层：API 入口 / 密钥 / 模型名 / 各场景系统提示词，统一存 prefs 表。

设计要点（本地单用户零鉴权）：
- 所有 AI 配置以单个 JSON 存进 prefs 表的 key = "ai:config"，一处读写、随库走。
- API 采用 OpenAI 兼容协议。对话与向量可来自不同 API：
    对话：base_url + api_key + chat_model
    向量：embed_use_chat=True 时复用对话入口/密钥；否则用独立 embed_base_url + embed_api_key + embed_model
  可对接 OpenAI / 本地 runner(ollama、vllm 等) / 各类兼容网关的任意组合。
- 密钥回读一律脱敏（sk-****后四位），明文只存服务端、不回吐给前端；
  前端提交空串或掩码串时视为「不修改密钥」，避免把掩码写回覆盖真钥。
- 系统提示词分场景（总结 summarize / 分类 classify / 提问 ask），各带内置默认与「恢复默认」。
"""
import json

from . import repo

CONFIG_KEY = "ai:config"

# 各场景内置默认系统提示词。用户可在设置页编辑；「恢复默认」即回到这里。
DEFAULT_PROMPTS = {
    "summarize": (
        "你是一名资深工程效率分析师。请把给定的一段工作日志浓缩成一条简明「洞察」：\n"
        "- 用一句不超过 25 字的标题概括这段工作做了什么；\n"
        "- 正文 2~5 句说清关键动作、取舍与结果，聚焦事实，不堆砌套话；\n"
        "- 保留关键技术名词原文；不要编造日志中不存在的信息。"
    ),
    "classify": (
        "你是一名工作内容分类器。请依据给定日志的核心工作对象，判定它属于哪个「主题」。\n"
        "- 主题应是稳定、可复用的短名词（如「性能优化」「鉴权重构」「文档整理」）；\n"
        "- 优先复用已存在的主题列表（若提供），语义相近就归入同一个，避免同义碎片化；\n"
        "- 只输出主题名本身，不要解释。"
    ),
    "ask": (
        "你是用户工作日志的智能助手。你会收到若干条经向量检索召回的相关日志片段作为上下文。\n"
        "- 严格依据上下文作答，不要臆测；上下文不足以回答时，如实说明「资料不足」；\n"
        "- 回答简洁、结构化，必要时引用具体日志的标题或时间；\n"
        "- 保留技术名词原文，使用与提问一致的语言作答。"
    ),
}

DEFAULT_CONFIG = {
    # 对话（chat）入口
    "base_url": "",                 # 如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1
    "api_key": "",                  # 明文仅存服务端
    "chat_model": "",               # 如 gpt-4o-mini / qwen2.5 等
    # 向量（embedding）入口——可独立于对话
    "embed_use_chat": True,         # True=复用对话入口/密钥；False=用下面的独立入口
    "embed_base_url": "",           # 独立向量 API 入口（embed_use_chat=False 时生效）
    "embed_api_key": "",            # 独立向量 API 密钥
    "embed_model": "",              # 如 text-embedding-3-small / bge-m3 等
    "embed_dim": 0,                 # 向量维度（首次 embedding 后回填，用于校验一致性）
    "prompts": dict(DEFAULT_PROMPTS),
}


def _load_raw(db) -> dict:
    raw = repo.get_pref(db, CONFIG_KEY)
    if not raw:
        return dict(DEFAULT_CONFIG, prompts=dict(DEFAULT_PROMPTS))
    try:
        cfg = json.loads(raw)
    except Exception:
        cfg = {}
    # 与默认合并，容错缺字段
    merged = dict(DEFAULT_CONFIG, prompts=dict(DEFAULT_PROMPTS))
    for k, v in (cfg or {}).items():
        if k == "prompts" and isinstance(v, dict):
            merged["prompts"] = {**DEFAULT_PROMPTS, **v}
        else:
            merged[k] = v
    return merged


def get_config_raw(db) -> dict:
    """服务端内部用：含明文密钥的完整配置。"""
    return _load_raw(db)


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:3]}****{key[-4:]}"


def get_config_public(db) -> dict:
    """回吐给前端：对话/向量两处密钥均脱敏，并附带「是否已配置密钥」标记。"""
    cfg = _load_raw(db)
    key = cfg.get("api_key") or ""
    ekey = cfg.get("embed_api_key") or ""
    pub = dict(cfg)
    pub["api_key"] = mask_key(key)
    pub["has_key"] = bool(key)
    pub["embed_api_key"] = mask_key(ekey)
    pub["has_embed_key"] = bool(ekey)
    return pub


def resolve_embed_endpoint(db) -> dict:
    """解析向量实际使用的入口：复用对话则回退到 chat 的 base_url/api_key。"""
    cfg = _load_raw(db)
    if cfg.get("embed_use_chat", True):
        return {"base_url": cfg.get("base_url") or "", "api_key": cfg.get("api_key") or "",
                "model": cfg.get("embed_model") or ""}
    return {"base_url": cfg.get("embed_base_url") or "", "api_key": cfg.get("embed_api_key") or "",
            "model": cfg.get("embed_model") or ""}


# 前端提交密钥时，这些值代表「不修改」：空串、掩码串本身
def _is_masked_or_blank(submitted: str, current: str) -> bool:
    if submitted is None or submitted == "":
        return True
    if submitted == mask_key(current):
        return True
    return False


def save_config(db, patch: dict) -> dict:
    """按补丁更新配置（仅覆盖 patch 中出现的字段）。密钥为空/掩码时保持原值不变。
    返回脱敏后的公开配置。"""
    cur = _load_raw(db)
    nxt = dict(cur)
    for k in ("base_url", "chat_model", "embed_base_url", "embed_model"):
        if k in patch and patch[k] is not None:
            nxt[k] = str(patch[k]).strip()
    if "embed_use_chat" in patch and patch["embed_use_chat"] is not None:
        nxt["embed_use_chat"] = bool(patch["embed_use_chat"])
    if "embed_dim" in patch and isinstance(patch["embed_dim"], int):
        nxt["embed_dim"] = patch["embed_dim"]
    if "api_key" in patch:
        if not _is_masked_or_blank(patch["api_key"], cur.get("api_key") or ""):
            nxt["api_key"] = str(patch["api_key"]).strip()
    if "embed_api_key" in patch:
        if not _is_masked_or_blank(patch["embed_api_key"], cur.get("embed_api_key") or ""):
            nxt["embed_api_key"] = str(patch["embed_api_key"]).strip()
    if "prompts" in patch and isinstance(patch["prompts"], dict):
        merged = dict(nxt.get("prompts") or DEFAULT_PROMPTS)
        for scene, txt in patch["prompts"].items():
            if scene in DEFAULT_PROMPTS and isinstance(txt, str):
                merged[scene] = txt
        nxt["prompts"] = merged
    repo.set_pref(db, CONFIG_KEY, json.dumps(nxt, ensure_ascii=False))
    return get_config_public(db)


def reset_prompt(db, scene: str) -> dict:
    """把某场景提示词恢复为内置默认。"""
    if scene not in DEFAULT_PROMPTS:
        return get_config_public(db)
    cfg = _load_raw(db)
    prompts = dict(cfg.get("prompts") or DEFAULT_PROMPTS)
    prompts[scene] = DEFAULT_PROMPTS[scene]
    cfg["prompts"] = prompts
    repo.set_pref(db, CONFIG_KEY, json.dumps(cfg, ensure_ascii=False))
    return get_config_public(db)
