"""OpenAI 兼容 API 客户端：对话补全 + 向量嵌入。

只依赖 httpx（FastAPI 自带）。所有调用都返回结构化结果，供 /test 汇报连通性、
供后续总结/分类/RAG 复用。base_url 末尾是否带 /v1 都能容错拼接。
"""
import time

import httpx


def _join(base_url: str, path: str) -> str:
    base = (base_url or "").rstrip("/")
    return f"{base}/{path.lstrip('/')}"


def chat_complete(base_url, api_key, model, messages, timeout=30.0, max_tokens=None):
    """调用 /chat/completions。返回 {ok, content, error, status, ms, raw_usage}。"""
    url = _join(base_url, "chat/completions")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"model": model, "messages": messages}
    if max_tokens:
        payload["max_tokens"] = max_tokens
    t0 = time.time()
    try:
        r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
        ms = int((time.time() - t0) * 1000)
        if r.status_code >= 400:
            return {"ok": False, "status": r.status_code, "error": _short(r.text), "ms": ms}
        data = r.json()
        content = ""
        try:
            content = data["choices"][0]["message"]["content"]
        except Exception:
            content = ""
        return {"ok": True, "status": r.status_code, "content": content, "ms": ms,
                "usage": data.get("usage")}
    except Exception as e:
        return {"ok": False, "status": 0, "error": f"{type(e).__name__}: {e}",
                "ms": int((time.time() - t0) * 1000)}


def chat_json(base_url, api_key, model, messages, timeout=30.0):
    """要求模型返回 JSON 对象并解析。优先用 response_format=json_object，
    失败或不支持则回退到从纯文本里提取第一个 {...}。返回 {ok, data, error, status, ms}。"""
    import json as _json
    import re as _re
    url = _join(base_url, "chat/completions")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    t0 = time.time()

    def _try(with_format):
        payload = {"model": model, "messages": messages, "temperature": 0}
        if with_format:
            payload["response_format"] = {"type": "json_object"}
        return httpx.post(url, headers=headers, json=payload, timeout=timeout)

    try:
        r = _try(True)
        if r.status_code >= 400:
            # 有些兼容网关不认 response_format，去掉再试一次
            r = _try(False)
        ms = int((time.time() - t0) * 1000)
        if r.status_code >= 400:
            return {"ok": False, "status": r.status_code, "error": _short(r.text), "ms": ms}
        content = ""
        try:
            content = r.json()["choices"][0]["message"]["content"] or ""
        except Exception:
            content = ""
        data = None
        try:
            data = _json.loads(content)
        except Exception:
            m = _re.search(r"\{.*\}", content, _re.S)
            if m:
                try:
                    data = _json.loads(m.group(0))
                except Exception:
                    data = None
        if data is None:
            return {"ok": False, "status": r.status_code, "error": f"无法解析 JSON：{_short(content)}", "ms": ms}
        return {"ok": True, "status": r.status_code, "data": data, "ms": ms}
    except Exception as e:
        return {"ok": False, "status": 0, "error": f"{type(e).__name__}: {e}",
                "ms": int((time.time() - t0) * 1000)}


def embed(base_url, api_key, model, texts, timeout=30.0):
    """调用 /embeddings。texts 为字符串列表。返回 {ok, vectors, dim, error, status, ms}。"""
    url = _join(base_url, "embeddings")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"model": model, "input": texts}
    t0 = time.time()
    try:
        r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
        ms = int((time.time() - t0) * 1000)
        if r.status_code >= 400:
            return {"ok": False, "status": r.status_code, "error": _short(r.text), "ms": ms}
        data = r.json()
        vectors = [d["embedding"] for d in data.get("data", [])]
        dim = len(vectors[0]) if vectors else 0
        return {"ok": True, "status": r.status_code, "vectors": vectors, "dim": dim, "ms": ms}
    except Exception as e:
        return {"ok": False, "status": 0, "error": f"{type(e).__name__}: {e}",
                "ms": int((time.time() - t0) * 1000)}


def _short(text: str, limit=300) -> str:
    t = (text or "").strip().replace("\n", " ")
    return t[:limit] + ("…" if len(t) > limit else "")
