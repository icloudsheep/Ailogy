"""AI worker 实时状态（进程内单例）——供设置页「运行」子类与前端 toast 展示。

记录：当前是否忙、正在处理的条目/阶段、累计 token（上/下行）、近若干条日志行。
线程安全（worker 在线程池里跑，接口在事件循环里读），用一把锁保护。
不落库——重启即清零，属于「运行时观测」而非持久数据。
"""
import threading
import time

_lock = threading.Lock()
_LOG_MAX = 200

_state = {
    "busy": False,             # 是否正在处理一轮
    "phase": "",               # 当前阶段：embed / classify / summarize / delete / idle
    "current": "",             # 当前处理的 client_id 或 topic
    "done": 0,                 # 本次运行已处理条数
    "total": 0,                # 本轮计划处理条数
    "tokens_in": 0,            # 累计上行 token（prompt）
    "tokens_out": 0,           # 累计下行 token（completion）
    "api_calls": 0,            # 累计 API 调用次数
    "started_at": 0.0,         # 本轮开始时间戳
    "updated_at": 0.0,
    "log": [],                 # [{ts, tag, msg}] 环形，最多 _LOG_MAX 条
    "last_error": "",
}


def begin_round(total):
    with _lock:
        _state["busy"] = True
        _state["phase"] = "starting"
        _state["done"] = 0
        _state["total"] = total
        _state["started_at"] = time.time()
        _state["updated_at"] = time.time()
    log("info", f"开始处理一轮，共 {total} 项")


def end_round():
    with _lock:
        _state["busy"] = False
        _state["phase"] = "idle"
        _state["current"] = ""
        _state["updated_at"] = time.time()


def set_phase(phase, current=""):
    with _lock:
        _state["phase"] = phase
        _state["current"] = current
        _state["updated_at"] = time.time()


def inc_done():
    with _lock:
        _state["done"] += 1
        _state["updated_at"] = time.time()


def add_usage(usage):
    """累加一次 API 调用的 token 用量。usage 形如 {prompt_tokens, completion_tokens}。"""
    if not isinstance(usage, dict):
        with _lock:
            _state["api_calls"] += 1
        return
    pi = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
    po = usage.get("completion_tokens") or usage.get("output_tokens") or 0
    with _lock:
        _state["tokens_in"] += int(pi or 0)
        _state["tokens_out"] += int(po or 0)
        _state["api_calls"] += 1
        _state["updated_at"] = time.time()


def log(tag, msg):
    with _lock:
        _state["log"].append({"ts": time.time(), "tag": tag, "msg": str(msg)[:500]})
        if len(_state["log"]) > _LOG_MAX:
            _state["log"] = _state["log"][-_LOG_MAX:]
        if tag == "err":
            _state["last_error"] = str(msg)[:500]
        _state["updated_at"] = time.time()


def snapshot(log_after=0):
    """返回状态快照。log_after: 只返回 ts 大于该值的日志（前端增量拉取）。"""
    with _lock:
        s = dict(_state)
        s["log"] = [ln for ln in _state["log"] if ln["ts"] > log_after]
        return s
