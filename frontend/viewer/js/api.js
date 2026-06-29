// API 数据层：封装对后端 /api 的分页拉取，是 viewer 唯一的数据来源。
// 两种模式：① 登录态看自己（/api/entries 等，需会话 cookie）；
//          ② 公开分享 ?share=token，走 /api/public/{token}/entries 匿名只读。
// 游标对前端不透明，只管把 next_cursor 透传回去。

const API_BASE = "";  // 同源；如后端分离部署可改为 http://127.0.0.1:8000
const SHARE_TOKEN = new URLSearchParams(location.search).get("share");  // 公开分享模式

class AuthError extends Error {}

async function _get(path, params) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== ""));
  const url = `${API_BASE}${path}${qs.toString() ? "?" + qs : ""}`;
  const r = await fetch(url, { credentials: "include" });
  if (r.status === 401) throw new AuthError("未登录");
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

const API = {
  shareMode: () => !!SHARE_TOKEN,
  // 全量 / 按日期 / 按 session。公开分享模式下走 public 端点（仅全量流，scope 由 token 决定）
  entries: ({ view = "all", sessionCode = null, cursor = null, limit = 50 } = {}) =>
    SHARE_TOKEN
      ? _get(`/api/public/${SHARE_TOKEN}/entries`, { cursor, limit })
      : _get("/api/entries", { view, session_code: sessionCode, cursor, limit }),
  sessions: ({ cursor = null, limit = 50 } = {}) =>
    _get("/api/sessions", { cursor, limit }),
  entry: (id) => _get(`/api/entries/${id}`),
  search: ({ q, cursor = null, limit = 50 }) =>
    _get("/api/search", { q, cursor, limit }),
};
