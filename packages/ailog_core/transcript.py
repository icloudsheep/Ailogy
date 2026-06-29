"""会话 transcript 解析与 token / 轮数统计。

据 CLAUDE_CODE_SESSION_ID 定位 ~/.claude/projects/*/<id>.jsonl，
统计某时间区间内本段的 input/output/cache tokens、对话轮数与 API 调用数。
"""
import json
import os
from datetime import datetime

# Claude Code 会话 transcript 根目录（每会话一个 <session-id>.jsonl）
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")


def find_transcript(session_id):
    """按 session_id 在 ~/.claude/projects 下定位会话 transcript 文件（.jsonl）。"""
    if not session_id or not os.path.isdir(PROJECTS_DIR):
        return None
    target = session_id + ".jsonl"
    for dirpath, _dirs, files in os.walk(PROJECTS_DIR):
        if target in files:
            return os.path.join(dirpath, target)
    return None


def _is_real_user_turn(row):
    """判断一条 transcript 记录是否为「用户真实提问」（排除工具结果回灌）。"""
    if row.get("type") != "user":
        return False
    msg = row.get("message") or {}
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, list):
        # 全是 tool_result 的不算一轮新提问
        return not all(
            isinstance(x, dict) and x.get("type") == "tool_result" for x in content
        )
    return bool(content)


def _local_naive(iso_ts):
    """把 transcript 的 ISO 时间戳（多为 UTC，带 Z）转成本地无时区 datetime。"""
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt


def usage_since(session_id, start_dt, end_dt):
    """统计 transcript 中 (start_dt, end_dt] 区间内本段的 token 与轮数（分段增量）。

    start_dt/end_dt 为本地无时区 datetime；start_dt 为 None 表示从会话起点算。
    返回字段全为整数的字典；transcript 不可用时返回空字典（调用方据此跳过）。
    """
    path = find_transcript(session_id)
    if not path:
        return {}
    agg = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
           "turns": 0, "api_calls": 0}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = _local_naive(row.get("timestamp", ""))
                # 无时间戳的元数据行跳过；区间为左开右闭，归属「本段」
                if ts is None or ts > end_dt or (start_dt is not None and ts <= start_dt):
                    continue
                if _is_real_user_turn(row):
                    agg["turns"] += 1
                msg = row.get("message") or {}
                u = msg.get("usage") or {}
                if u:
                    agg["api_calls"] += 1
                    agg["input"] += u.get("input_tokens", 0) or 0
                    agg["output"] += u.get("output_tokens", 0) or 0
                    agg["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
                    agg["cache_write"] += u.get("cache_creation_input_tokens", 0) or 0
    except OSError:
        return {}
    return agg
