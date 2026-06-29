"""带 API Key 把日志条目上报后端（CLI 双模式的上报半边）。

本地始终先写 data.json + 离线渲染（见 entry.write_entry）；本模块只负责把条目
POST 给后端。上报失败不阻断本地——写入待重发队列，下次 CLI 运行时补发。
单向 本地→后端 + 幂等 upsert（按 day#seq），后端是最终一致的副本。
"""
import json
import os

import requests

from .config import cache_root

# 待重发队列：每行一个 JSON（{url, entry}），下次启动时尝试补发
_QUEUE_DIR = os.path.join(cache_root(), "queue")
_QUEUE_FILE = os.path.join(_QUEUE_DIR, "pending.jsonl")
_TIMEOUT = 5


def report_entry(backend, entry_dict):
    """把一条 entry 上报后端。backend = resolve_backend() 的返回。

    成功返回 True；未配置/失败返回 False（失败时入队待重发）。
    """
    if not backend.get("report"):
        return False
    url, key = backend.get("url"), backend.get("api_key")
    if not url or not key:
        print("⚠️ 已开启上报但缺少后端地址或密钥，跳过（本地已保存）")
        return False
    try:
        r = requests.post(
            f"{url}/api/ingest/entries",
            json=entry_dict,
            headers={"Authorization": f"Bearer {key}"},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        return True
    except Exception as e:
        print(f"⚠️ 上报失败（本地已保存，已入队下次重发）：{e}")
        _enqueue(url, key, entry_dict)
        return False


def _enqueue(url, key, entry_dict):
    os.makedirs(_QUEUE_DIR, exist_ok=True)
    with open(_QUEUE_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"url": url, "key": key, "entry": entry_dict}, ensure_ascii=False) + "\n")


def flush_queue():
    """尝试补发队列里的条目；成功的移除，失败的保留。返回 (成功数, 剩余数)。"""
    if not os.path.exists(_QUEUE_FILE):
        return 0, 0
    with open(_QUEUE_FILE, "r", encoding="utf-8") as f:
        lines = [ln for ln in f if ln.strip()]
    remaining, sent = [], 0
    for ln in lines:
        try:
            item = json.loads(ln)
        except json.JSONDecodeError:
            continue  # 丢弃坏行
        try:
            r = requests.post(
                f"{item['url']}/api/ingest/entries", json=item["entry"],
                headers={"Authorization": f"Bearer {item['key']}"}, timeout=_TIMEOUT)
            r.raise_for_status()
            sent += 1
        except Exception:
            remaining.append(ln)
    if remaining:
        with open(_QUEUE_FILE, "w", encoding="utf-8") as f:
            f.writelines(remaining)
    else:
        os.remove(_QUEUE_FILE)
    return sent, len(remaining)
