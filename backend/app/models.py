"""SQLAlchemy ORM 模型 —— 对应计划里的 SQLite schema。

设计要点：
- entry 的 usage / carryover 用 JSON 文本列，不拆表（个人规模无聚合需求）。
- session 不建实体表，用 entries.session_code 派生聚合；显示名放 aliases。
- 所有面向用户的查询都带 user_id 隔离。
- 索引服务于三视图：全量/按日期共用 (user_id, datetime DESC, id DESC)，
  按 session 用 (user_id, session_code, datetime DESC, id DESC)。
"""
# Python 3.9 下 Mapped[...] 注解需延迟求值，否则 mapped_column 会被当成类型参数报错
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Integer, String, Text, Boolean, ForeignKey, Index, UniqueConstraint, DateTime,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _now():
    return datetime.utcnow()


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)  # argon2
    handle: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # /u/{handle} 路由用
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Session(Base):
    """服务端会话：随机 token 存 httponly cookie，可撤销、可过期。"""
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # 随机 token
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    __table_args__ = (Index("ix_sessions_user", "user_id"),)


class KeyApplication(Base):
    """密钥申请：pending / approved / rejected 状态机。"""
    __tablename__ = "key_applications"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    reason: Mapped[str] = mapped_column(Text, default="")
    reviewed_by: Mapped[int] = mapped_column(Integer, nullable=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    __table_args__ = (Index("ix_applications_status", "status", "created_at"),)


class ApiKey(Base):
    """API 密钥。

    安全取舍：本项目面向个人自托管，应需求把密钥明文也存库（secret 列），
    以便页面随时复制——代价是能读到 .db 的人即可拿到所有明文密钥。
    key_hash 仍保留用于鉴权快速查找；prefix 用于列表辨认。
    """
    __tablename__ = "api_keys"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), nullable=False)        # 明文前 8 位，列表展示用
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)      # sha256(完整密钥)，鉴权查找
    secret: Mapped[str] = mapped_column(Text, nullable=True)               # 明文（个人自托管：随时可复制）
    label: Mapped[str] = mapped_column(String(64), default="")
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_used_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    __table_args__ = (
        Index("ix_keys_hash", "key_hash"),
        Index("ix_keys_user_revoked", "user_id", "revoked"),
    )


class Entry(Base):
    """一条日志条目。字段与 ailog_core.schema.Entry 对齐；usage/carryover 为 JSON 文本。"""
    __tablename__ = "entries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)            # 后端全局自增内部主键
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)             # 用户内序号（来自 CLI）
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)    # 原 entry.id，幂等去重键
    emoji: Mapped[str] = mapped_column(String(16), default="")
    name: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(Text, default="")
    session_code: Mapped[str] = mapped_column(String(64), nullable=False) # session 视图聚合键
    start_ts: Mapped[str] = mapped_column(String(8), default="")          # HH:MM:SS
    end_ts: Mapped[str] = mapped_column(String(8), default="")
    datetime: Mapped[str] = mapped_column(String(19), nullable=False)     # 主排序键 YYYY-MM-DD HH:MM:SS
    day: Mapped[str] = mapped_column(String(10), nullable=False)          # 入库时算好，按日期视图分桶
    duration: Mapped[int] = mapped_column(Integer, default=0)
    cwd: Mapped[str] = mapped_column(Text, default="")
    project: Mapped[str] = mapped_column(String(128), default="")
    branch: Mapped[str] = mapped_column(String(128), default="")
    model: Mapped[str] = mapped_column(String(64), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    mode: Mapped[str] = mapped_column(String(16), nullable=True)
    carryover: Mapped[str] = mapped_column(Text, nullable=True)           # JSON 或 NULL
    usage: Mapped[str] = mapped_column(Text, nullable=True)               # JSON 或 NULL
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    __table_args__ = (
        UniqueConstraint("user_id", "client_id", name="uq_entry_user_client"),
        Index("ix_entries_user_dt", "user_id", "datetime", "id"),               # 全量 & 按日期
        Index("ix_entries_user_session_dt", "user_id", "session_code", "datetime", "id"),  # 按 session
    )


class Alias(Base):
    """会话显示名（右键改名，跨日期生效）。"""
    __tablename__ = "aliases"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    session_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class PageVisibility(Base):
    """逐 scope 的公开/私有设置 + 分享 token。缺记录视为私有。

    scope 形如 'all' / 'day:2026-06-26' / 'session:<code>'。
    """
    __tablename__ = "page_visibility"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    scope: Mapped[str] = mapped_column(String(80), primary_key=True)
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    share_token: Mapped[str] = mapped_column(String(64), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    __table_args__ = (Index("ix_visibility_token", "share_token"),)
