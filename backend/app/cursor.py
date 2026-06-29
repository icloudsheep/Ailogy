"""keyset(cursor) 分页编解码。

游标 = base64(json)，对调用方不透明。不同视图载荷不同：
- 全量/按日期：{dt, id}
- session 列表：{last, code}
- session 内：{dt, id}
不可解析的游标视为「从头开始」，避免脏游标导致 500。
"""
import base64
import json


def encode_cursor(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_cursor(cursor: str):
    if not cursor:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii"))
        v = json.loads(raw)
        return v if isinstance(v, dict) else None
    except Exception:
        return None  # 脏游标当作无游标，从头开始
