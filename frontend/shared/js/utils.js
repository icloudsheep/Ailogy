// 纯渲染/格式化工具，前后端两场景复用，无任何全局数据依赖。

// 高级感配色：低饱和宝石色 + 霓虹
const PALETTE = ["#6ea8fe","#9d7bff","#f178b6","#ffb454","#46d1c4","#7ee787","#ff8a8a","#c084fc","#56c2ff","#ffd166"];
const ROW = 72, TOP = 30, LANE_X0 = 40, LANE_GAP = 52;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
// CSS 属性选择器转义（会话 id 通常安全，仍做兜底以防特殊字符）
const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
const laneX = (lane) => LANE_X0 + lane * LANE_GAP;
const rowY = (i) => TOP + i * ROW;
// 时间范围（时长）格式：001天01时01分01秒。未达 1 天不显示「天」（后续单位同理），
// 一旦某高位单位出现，其后所有单位都补零显示。天 3 位、时/分/秒各 2 位。
const fmtDur = (s) => {
  if (s == null) return "";
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
        m = Math.floor(s % 3600 / 60), sec = s % 60;
  const p = (n, w) => String(n).padStart(w, "0");
  if (d > 0) return `${p(d,3)}天${p(h,2)}时${p(m,2)}分${p(sec,2)}秒`;
  if (h > 0) return `${p(h,2)}时${p(m,2)}分${p(sec,2)}秒`;
  if (m > 0) return `${p(m,2)}分${p(sec,2)}秒`;
  return `${p(sec,2)}秒`;
};
// 时间节点格式：补足为 2000-01-01 01:01:01。只有 HH:MM:SS 时用传入 date 兜底拼日期。
const fmtAt = (val, date) => {
  if (!val) return "";
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) return s.slice(0, 19).replace("T", " ");
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return `${date || ""} ${s}`.trim();
  return s;
};
const fmtTok = (n) => n == null ? "" : (n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"k" : String(n));

