"""entry 字段定义与校验（pydantic 模型）—— CLI 上报与后端 ingest 共用。

一条日志条目的规范形状。CLI 在上报前用它校验，后端 ingest 用它解析请求体，
两端共享同一定义，避免字段漂移。落盘到 SQLite 的列映射见 backend/app/models.py。
"""
from typing import Optional
from pydantic import BaseModel, Field


class Usage(BaseModel):
    """本段 token / 轮数统计（transcript 可用时才有）。"""
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    turns: int = 0
    api_calls: int = 0


class Carryover(BaseModel):
    """跨午夜接续标注：本会话前一部分在 prev_date，止于 prev_end。"""
    prev_date: str
    prev_end: str


class Entry(BaseModel):
    """一条日志条目。字段与原 data.json 中的 entry 对齐。

    上报时 client_id 取原 entry 的 id 字段（会话代号 name-suffix），
    配合 user_id 做幂等去重；datetime 是主排序键、day 供按日期视图分桶。
    """
    seq: int
    id: str                      # 会话代号 name-suffix（即 client 侧的 session/entry 标识）
    emoji: str = ""
    name: str = ""
    title: str = ""
    start: str = ""              # HH:MM:SS
    end: str = ""                # HH:MM:SS
    datetime: str                # YYYY-MM-DD HH:MM:SS，主排序键
    duration: int = 0
    cwd: str = ""
    project: str = ""
    branch: str = ""
    model: str = ""
    summary: str = ""
    mode: Optional[str] = None           # 如 "full"
    carryover: Optional[Carryover] = None
    usage: Optional[Usage] = None

    # 体积上限交由后端在路由层做（413），此处只定形状。
    model_config = {"extra": "ignore"}


def day_of(entry_datetime: str) -> str:
    """从 entry 的 datetime（YYYY-MM-DD HH:MM:SS）取出日期段，供按日期视图分桶。"""
    return (entry_datetime or "")[:10]
