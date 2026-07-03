"""SQLAlchemy ORM 模型 —— 个人单用户本地部署，无需用户/密钥/分享机制。

设计要点：
- entry 只有一张表，无 user_id 列。
- 无 users/sessions/api_keys/key_applications/aliases/page_visibility 表。
- session 不建实体表，用 entries.session_code 派生聚合。
"""
# Python 3.9 下 Mapped[...] 注解需延迟求值，否则 mapped_column 会被当做类型参数报错
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Integer, String, Text, Index, UniqueConstraint, DateTime, LargeBinary,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _now():
    return datetime.utcnow()


class Entry(Base):
    """一条日志条目。"""
    __tablename__ = "entries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    device: Mapped[str] = mapped_column(String(64), default="", index=True)  # 上报设备名
    emoji: Mapped[str] = mapped_column(String(16), default="")
    name: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(Text, default="")
    session_code: Mapped[str] = mapped_column(String(64), nullable=False)
    start_ts: Mapped[str] = mapped_column(String(8), default="")
    end_ts: Mapped[str] = mapped_column(String(8), default="")
    datetime: Mapped[str] = mapped_column(String(19), nullable=False)
    day: Mapped[str] = mapped_column(String(10), nullable=False)
    duration: Mapped[int] = mapped_column(Integer, default=0)
    cwd: Mapped[str] = mapped_column(Text, default="")
    project: Mapped[str] = mapped_column(String(128), default="")
    branch: Mapped[str] = mapped_column(String(128), default="")
    model: Mapped[str] = mapped_column(String(64), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    mode: Mapped[str] = mapped_column(String(16), nullable=True)
    color: Mapped[str] = mapped_column(String(16), nullable=True)   # 会话颜色覆盖（持久化）
    carryover: Mapped[str] = mapped_column(Text, nullable=True)
    usage: Mapped[str] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    __table_args__ = (
        UniqueConstraint("client_id", name="uq_entry_client"),
        Index("ix_entries_dt", "datetime", "id"),
        Index("ix_entries_session_dt", "session_code", "datetime", "id"),
    )


class AIInsight(Base):
    """一条日志的「分类结果」——entry → topic 映射 + 展示所需的会话元信息。

    由 worker 的分类流水线产出（按 client_id 幂等 upsert）：AI 只判定该条属于哪个 topic，
    不再对单条做二次总结（标题/正文沿用日志原文）。凝练总结在「主题级」(AITopic) 做。
    与日志解耦：worker 直接读 entries 生成，不回写 entries。
    二级页面用它按会话排布某主题下的日志；沿用会话主题色/emoji/名字。
    """
    __tablename__ = "ai_insights"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)        # = day#seq，溯源+幂等键
    device: Mapped[str] = mapped_column(String(64), default="", index=True)
    topic: Mapped[str] = mapped_column(String(128), default="", index=True)   # AI 判定的主题
    session_code: Mapped[str] = mapped_column(String(64), nullable=False)     # 沿用会话代号（取色/取名）
    emoji: Mapped[str] = mapped_column(String(16), default="")
    name: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(Text, default="")                      # 沿用日志标题
    summary: Mapped[str] = mapped_column(Text, default="")                    # 沿用日志正文
    datetime: Mapped[str] = mapped_column(String(19), nullable=False)         # 供泳道内排序
    day: Mapped[str] = mapped_column(String(10), default="", index=True)      # 二级页面月/天筛选
    color: Mapped[str] = mapped_column(String(16), nullable=True)            # 冗余会话色（沿用）
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    __table_args__ = (
        UniqueConstraint("client_id", name="uq_insight_client"),
        Index("ix_ai_topic", "topic"),
        Index("ix_ai_device", "device"),
    )


class AITopic(Base):
    """一个「主题」及其跨条综述——AI 一级页面（爆炸图 + 综述卡片）的数据源。

    一主题一条：summary 是把该主题下所有日志汇总成的更高视角综述。
    主题内任一日志增/删/改 → need_resummarize=1 → worker 批末防抖重算一次。
    """
    __tablename__ = "ai_topics"
    topic: Mapped[str] = mapped_column(String(128), primary_key=True)
    summary: Mapped[str] = mapped_column(Text, default="")                    # 主题综述（跨条汇总）
    entry_count: Mapped[int] = mapped_column(Integer, default=0)              # 该主题下日志数
    need_resummarize: Mapped[int] = mapped_column(Integer, default=1, index=True)  # 1=待重算综述
    color: Mapped[str] = mapped_column(String(16), nullable=True)            # 代表色（取主题内某会话色）
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class AIQueue(Base):
    """AI 处理队列（触发器写入、worker 消费）——类 binlog 的变更待办。

    每条 entry 一行（client_id 主键），重复变更合并为「重置为待处理」而非堆多行。
    两条流水线各一个标志位，互不拖累：need_insight(分类) / need_embed(向量化)。
    失败：attempts 累加，超上限置 paused=1（暂停自动重试，等新变更带起或用户手动重试）。
    """
    __tablename__ = "ai_queue"
    client_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    op: Mapped[str] = mapped_column(String(8), default="upsert")              # upsert / delete
    need_insight: Mapped[int] = mapped_column(Integer, default=1, index=True)
    need_embed: Mapped[int] = mapped_column(Integer, default=1, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    paused: Mapped[int] = mapped_column(Integer, default=0, index=True)       # 1=超重试上限，暂停自动重试
    last_error: Mapped[str] = mapped_column(Text, default="")
    enqueued_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class Embedding(Base):
    """一条日志/洞察内容的向量化结果，供 RAG 检索。

    落地方案（本地单用户、零额外依赖、随 git 走）：向量以 float32 小端 BLOB 存 `vec` 列，
    检索时在 Python 里做暴力余弦相似度（本项目规模下足够快，无需 sqlite-vec 扩展）。
    - source_type/source_id 溯源到被向量化的对象（demo：entry 的 client_id）；
    - model/dim 记录产出该向量的模型与维度，换模型/换维度时可据此失效重建；
    - text 冗余存被向量化的原文片段，便于召回后直接拼进 RAG 上下文、免二次查库。
    """
    __tablename__ = "embeddings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_type: Mapped[str] = mapped_column(String(16), default="entry", index=True)
    source_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    model: Mapped[str] = mapped_column(String(64), default="")
    dim: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text, default="")
    vec = mapped_column(LargeBinary, nullable=True)   # float32 小端连续存储
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    __table_args__ = (
        UniqueConstraint("source_type", "source_id", name="uq_embed_source"),
    )


class Pref(Base):
    """前端偏好的服务端固化：key-value（JSON 文本）。

    存会话别名(aliases)、会话颜色(colors)、选择器状态(selection)、主题(theme) 等。
    单用户本地部署，全局一份。
    """
    __tablename__ = "prefs"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
