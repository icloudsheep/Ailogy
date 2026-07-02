// API 数据层：封装对后端 /api 的请求。
async function _get(path, params) {
  const qs = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v != null && v !== ""));
  const url = `${path}${qs.toString() ? "?" + qs : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function _send(method, path, body) {
  const r = await fetch(path, {
    method, headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

const API = {
  // 泳道时间线。month 模式：传 month；recent 模式：传 {recent:N}（最近 N 天）。
  // devices 为 null=全部，[]=无，数组=指定设备。
  timeline: (opts, devices) => {
    const params = {};
    if (opts && opts.recent) params.recent = opts.recent;
    else params.month = (opts && opts.month) || opts;   // 兼容旧调用 timeline(month, devices)
    if (Array.isArray(devices)) params.devices = devices.join(",");
    return _get("/api/timeline", params);
  },
  // 有数据的月份列表
  months: () => _get("/api/months"),
  // 上报设备列表
  devices: () => _get("/api/devices"),
  // 单条详情
  entry: (id) => _get(`/api/entries/${id}`),
  // 全文搜索
  search: ({ q, cursor = null, limit = 50 }) => _get("/api/search", { q, cursor, limit }),
  // 编辑 / 删除 / 改色（固化到 DB）
  editEntry: (id, title, summary) => _send("PATCH", `/api/entries/${id}`, { title, summary }),
  deleteEntry: (id) => _send("DELETE", `/api/entries/${id}`),
  setColor: (code, color) => _send("PUT", `/api/sessions/${encodeURIComponent(code)}/color`, { color }),
  // 偏好固化（aliases / colors / selection / theme）
  prefs: () => _get("/api/prefs"),
  putPref: (key, value) => _send("PUT", `/api/prefs/${encodeURIComponent(key)}`, { value }),
};
