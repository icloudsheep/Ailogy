"""轻量内存滑动窗口限流（单进程自托管够用，零额外依赖）。

按 (键, 路由) 记录时间戳列表，窗口内超额则拒。键通常取客户端 IP。
仅适配单进程 uvicorn；多进程/多实例需换 Redis 等共享存储。
"""
import time
import threading
from collections import defaultdict

from fastapi import HTTPException, Request

_hits = defaultdict(list)   # (key, name) -> [timestamps]
_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    # 本地直连用 client.host；反代后应读 X-Forwarded-For（上线时按部署配置调整）
    return (request.client.host if request.client else "?")


def rate_limit(name: str, limit: int, window: int):
    """返回一个 FastAPI 依赖：同一 IP 在 window 秒内对 name 最多 limit 次，超额 429。"""
    def dep(request: Request):
        key = (_client_ip(request), name)
        now = time.time()
        with _lock:
            xs = [t for t in _hits[key] if now - t < window]
            if len(xs) >= limit:
                retry = int(window - (now - xs[0])) + 1
                raise HTTPException(429, f"请求过于频繁，请 {retry}s 后再试",
                                    headers={"Retry-After": str(retry)})
            xs.append(now)
            _hits[key] = xs
    return dep
