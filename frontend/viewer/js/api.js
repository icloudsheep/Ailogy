// API 数据层：封装对后端 /api 的请求，是 viewer 唯一的数据来源。
// 登录态看自己；公开分享 ?share=token 走 public 端点（匿名只读）。

const SHARE_TOKEN = new URLSearchParams(location.search).get("share");

class AuthError extends Error {}

async function _get(path, params) {
  const qs = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v != null && v !== ""));
  const url = `${path}${qs.toString() ? "?" + qs : ""}`;
  const r = await fetch(url, { credentials: "include" });
  if (r.status === 401) throw new AuthError("未登录");
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

const API = {
  shareMode: () => !!SHARE_TOKEN,
  // 某月泳道时间线（默认当月）。公开分享模式走 public（scope 由 token 决定，忽略 month）
  timeline: (month) =>
    SHARE_TOKEN ? _get(`/api/public/${SHARE_TOKEN}/entries`, { limit: 500 })
                : _get("/api/timeline", { month }),
  // 有数据的月份列表
  months: () => _get("/api/months"),
  // 单条详情
  entry: (id) => _get(`/api/entries/${id}`),
  // 全文搜索（全部日志，FTS）
  search: ({ q, cursor = null, limit = 50 }) => _get("/api/search", { q, cursor, limit }),
};
