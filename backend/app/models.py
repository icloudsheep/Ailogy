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
    Integer, String, Text, Index, UniqueConstraint, DateTime,
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


class Pref(Base):
    """前端偏好的服务端固化：key-value（JSON 文本）。

    存会话别名(aliases)、会话颜色(colors)、选择器状态(selection)、主题(theme) 等。
    单用户本地部署，全局一份。
    """
    __tablename__ = "prefs"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
