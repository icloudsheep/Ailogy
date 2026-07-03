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
    """AI 智能分析结果的一条「洞察」——AI 侧泳道页的数据源。

    demo 阶段：由 entries 派生（topic 暂用 project 充当），后续替换为真正的 AI 产出。
    与日志解耦：AI 直接读库/接 binlog 生成 insight，不回写 entries。
    泳道仍以 session 为列、沿用会话主题色与名字；但分类维度改为「设备 + 主题」，不再按月/天。
    """
    __tablename__ = "ai_insights"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device: Mapped[str] = mapped_column(String(64), default="", index=True)
    topic: Mapped[str] = mapped_column(String(128), default="", index=True)  # 分类主题（demo=project）
    session_code: Mapped[str] = mapped_column(String(64), nullable=False)     # 沿用会话代号（取色/取名）
    emoji: Mapped[str] = mapped_column(String(16), default="")
    name: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    datetime: Mapped[str] = mapped_column(String(19), nullable=False)         # 供泳道内排序
    color: Mapped[str] = mapped_column(String(16), nullable=True)            # 冗余会话色（沿用）
    src_client_id: Mapped[str] = mapped_column(String(64), nullable=True)     # 溯源到的 entry（可空）
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    __table_args__ = (
        Index("ix_ai_topic", "topic"),
        Index("ix_ai_device", "device"),
    )


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
