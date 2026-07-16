"""出站 HTTP 统一入口 —— 让"是否走代理"由用户在设置里控制，而不是被 systemd 环境
变量硬绑定。所有对第三方服务的请求（LLM 对话/embedding、GitHub Releases、
更新包下载、联通性探测）都改走本模块。

- purpose 语义
    - "model"  → AI 对话 / 向量 / 联通测试
    - "github" → GitHub API / zipball 下载 / 联通测试
  两个通道各自独立配置，UI 上两张卡片。

- 读取来源：prefs.ailogy:proxy（JSON）
    {
      "model":  {"enabled": bool, "url": "http://host:port", "user": "", "pass": ""},
      "github": {"enabled": bool, "url": "http://host:port", "user": "", "pass": ""}
    }
  - enabled=false 且 url 为空 → 该通道 trust_env=True（沿用 systemd 环境变量，保护
    现有部署行为不被破坏）
  - enabled=false 且 url 非空 → 显式"强制直连"，忽略环境变量
  - enabled=true 且 url 非空 → 走该 url；有 user 时用 basic auth 拼进 url
  - enabled=true 且 url 为空 → 视作 enabled=false 的兜底（避免用户误开导致全挂）

  这样的设计对老部署零改动：没有 prefs 记录时行为完全等同于之前的 httpx 顶层调用。

- 提供三个薄壳函数：get / post / stream，签名与 httpx 顶层完全一致，方便逐点替换。
"""
from __future__ import annotations

import json
import os
from urllib.parse import quote, urlparse, urlunparse

import httpx


PROXY_PREF_KEY = "ailogy:proxy"

_DEFAULT_CH = {"enabled": False, "url": "", "user": "", "pass": ""}


def _mask(v: str) -> str:
    """密码脱敏：仅前后各留一位（长度<4 时全遮）。"""
    if not v:
        return ""
    if len(v) <= 3:
        return "*" * len(v)
    return v[0] + "*" * (len(v) - 2) + v[-1]


def _get_config(db):
    """从 prefs 读代理配置，标准化为 {model, github} 两通道。缺失键补默认值。"""
    from . import repo as _repo
    try:
        raw = _repo.get_pref(db, PROXY_PREF_KEY)
    except Exception:
        raw = None
    cfg = {}
    if raw:
        try:
            cfg = json.loads(raw) or {}
        except Exception:
            cfg = {}
    out = {}
    for ch in ("model", "github"):
        c = cfg.get(ch) or {}
        out[ch] = {**_DEFAULT_CH, **{k: c.get(k, _DEFAULT_CH[k]) for k in _DEFAULT_CH}}
    return out


def get_config_masked(db):
    """给前端读取的版本：把 pass 脱敏，同时补一个 has_pass 便于 UI 判断。"""
    cfg = _get_config(db)
    out = {}
    for ch, c in cfg.items():
        out[ch] = {
            "enabled": bool(c["enabled"]),
            "url": c["url"],
            "user": c["user"],
            "pass": _mask(c["pass"]),
            "has_pass": bool(c["pass"]),
        }
    return out


def save_config(db, patch):
    """按通道合并保存。patch 形如 {"model": {...}, "github": {...}}；pass 传空串
    表示"不修改"（避免脱敏值把真实密码覆盖）；pass 传 None 表示"清空"。"""
    from . import repo as _repo
    cur = _get_config(db)
    for ch in ("model", "github"):
        if ch not in patch or not isinstance(patch[ch], dict):
            continue
        p = patch[ch]
        c = cur[ch]
        if "enabled" in p:
            c["enabled"] = bool(p["enabled"])
        if "url" in p:
            c["url"] = (p["url"] or "").strip()
        if "user" in p:
            c["user"] = (p["user"] or "").strip()
        if "pass" in p:
            v = p["pass"]
            if v is None:
                c["pass"] = ""
            elif v != "":
                # 空串 = 不修改（保留原值）；非空 = 覆盖
                c["pass"] = v
    _repo.set_pref(db, PROXY_PREF_KEY, json.dumps(cur, ensure_ascii=False))
    db.commit()
    return get_config_masked(db)


def _build_proxy_url(url: str, user: str, pw: str):
    """把 basic auth 塞进 URL 里（httpx 的 proxy 参数仅接受 str/URL，不接受单独的
    auth 元组），保留 scheme 与 path。user/pw 做 URL 编码，防止特殊字符搞挂 URL。"""
    if not url:
        return None
    try:
        u = urlparse(url)
    except Exception:
        return None
    netloc = u.netloc or u.path  # 兜底：某些用户写"host:port"没带 scheme
    if user:
        auth = quote(user, safe="")
        if pw:
            auth += ":" + quote(pw, safe="")
        # 移除原 netloc 里可能存在的 auth，再拼
        host = netloc.split("@", 1)[-1]
        netloc = f"{auth}@{host}"
    scheme = u.scheme or "http"
    if not u.netloc:
        # 用户只填了 host:port，重构一次
        return urlunparse((scheme, netloc, "", "", "", ""))
    return urlunparse((scheme, netloc, u.path, u.params, u.query, u.fragment))


def _resolve(db, purpose: str):
    """按 purpose 决定 httpx 客户端如何走：
       返回 {proxy: str | None, trust_env: bool}

    规则（简化版，兜底友好）：
      - enabled=true 且 url 非空 → 走用户配置的代理（明确指定，忽略 env）
      - 其他情况 → trust_env=True，交给 httpx 读环境变量兜底
        · enabled=false 无论 url 空/非空
        · enabled=true 但 url 空（当作未生效）

    这样"用户没在 UI 明确开启并配了 URL"时，行为等同于原始 httpx——完全遵守
    HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量，不出现"强制直连忽略 env"的隐晦语义。
    """
    ch = _get_config(db).get(purpose) or _DEFAULT_CH
    if ch["enabled"] and ch["url"]:
        p = _build_proxy_url(ch["url"], ch["user"], ch["pass"])
        return {"proxy": p, "trust_env": False}
    return {"proxy": None, "trust_env": True}


# ─── 公开薄壳：签名与 httpx 顶层等价，只多一个 purpose ────────────────────────
def get(url, *, purpose: str = "github", db=None, **kwargs):
    r = _resolve(_ensure_db(db), purpose)
    with httpx.Client(proxy=r["proxy"], trust_env=r["trust_env"]) as c:
        return c.get(url, **kwargs)


def post(url, *, purpose: str = "model", db=None, **kwargs):
    r = _resolve(_ensure_db(db), purpose)
    with httpx.Client(proxy=r["proxy"], trust_env=r["trust_env"]) as c:
        return c.post(url, **kwargs)


def stream(method, url, *, purpose: str, db=None, **kwargs):
    """流式（下载 / SSE）。返回 context manager，用法同 httpx.stream。"""
    r = _resolve(_ensure_db(db), purpose)
    client = httpx.Client(proxy=r["proxy"], trust_env=r["trust_env"])

    class _Ctx:
        def __enter__(self_inner):
            self_inner._client = client
            self_inner._req = client.stream(method, url, **kwargs)
            self_inner._resp = self_inner._req.__enter__()
            return self_inner._resp

        def __exit__(self_inner, *exc):
            try:
                self_inner._req.__exit__(*exc)
            finally:
                client.close()

    return _Ctx()


def _ensure_db(db):
    """允许调用方不显式传 db；此时开一个短会话即可（读一次 prefs 就关）。"""
    if db is not None:
        return db
    from .db import SessionLocal
    # 用一次即关：resolve 只读、不改，短会话安全
    class _Shim:
        def __init__(self, s): self._s = s
        def execute(self, *a, **k): return self._s.execute(*a, **k)
        def commit(self): self._s.commit()
        def close(self): self._s.close()
        def __del__(self):
            try: self._s.close()
            except Exception: pass
    return _Shim(SessionLocal())


# ─── 联通性测试 ────────────────────────────────────────────────────────────
_PROBE_URL = "https://www.google.com/generate_204"
_PROBE_TIMEOUT = 6.0


def probe(db, purpose: str):
    """向 generate_204 发一次探测。返回 {ok, status, ms, error, via}。
    via 说明走了什么路径（direct / env / proxy://host:port），便于用户理解。"""
    import time
    r = _resolve(db, purpose)
    if r["proxy"]:
        # 打码后展示 via（避免把密码回显）
        try:
            u = urlparse(r["proxy"])
            host = u.hostname or ""
            port = f":{u.port}" if u.port else ""
            via = f"proxy://{host}{port}"
        except Exception:
            via = "proxy"
    elif r["trust_env"]:
        env_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
        via = f"env({_short_env_proxy(env_proxy)})" if env_proxy else "direct(env未设)"
    else:
        via = "direct(强制直连)"
    t0 = time.time()
    try:
        with httpx.Client(proxy=r["proxy"], trust_env=r["trust_env"]) as c:
            resp = c.get(_PROBE_URL, timeout=_PROBE_TIMEOUT, follow_redirects=True)
        ms = int((time.time() - t0) * 1000)
        # generate_204 期望 204；某些代理会改写成 200 空体，也算通
        ok = resp.status_code in (200, 204)
        return {"ok": ok, "status": resp.status_code, "ms": ms, "via": via, "error": "" if ok else f"意外状态码 {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "status": 0, "ms": int((time.time() - t0) * 1000),
                "via": via, "error": f"{type(e).__name__}: {e}"}


def _short_env_proxy(u: str) -> str:
    """把 env 里的代理 URL 简化为 host:port，避免把用户在环境变量里塞的密码回显。"""
    try:
        p = urlparse(u)
        h = p.hostname or ""
        port = f":{p.port}" if p.port else ""
        return f"{h}{port}"
    except Exception:
        return "*"
