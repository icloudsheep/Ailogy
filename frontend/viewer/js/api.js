// API 数据层：封装对后端 /api 的分页拉取，是 viewer 唯一的数据来源。
// 游标对前端不透明，只管把 next_cursor 透传回去。

const API_BASE = "";  // 同源；如后端分离部署可改为 http://127.0.0.1:8000

async function _get(path, params) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== ""));
  const url = `${API_BASE}${path}${qs.toString() ? "?" + qs : ""}`;
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

const API = {
  // 全量 / 按日期：同一时间倒序流（view=all|day），按 session 需带 sessionCode
  entries: ({ view = "all", sessionCode = null, cursor = null, limit = 50 } = {}) =>
    _get("/api/entries", { view, session_code: sessionCode, cursor, limit }),
  // session 列表（按 session 视图第一层）
  sessions: ({ cursor = null, limit = 50 } = {}) =>
    _get("/api/sessions", { cursor, limit }),
  // 单条详情
  entry: (id) => _get(`/api/entries/${id}`),
  // 全文搜索
  search: ({ q, cursor = null, limit = 50 }) =>
    _get("/api/search", { q, cursor, limit }),
};
