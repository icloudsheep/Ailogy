// 纯渲染/格式化工具，前后端两场景复用，无任何全局数据依赖。

// 高级感配色：12 色相 × 5 明暗档 = 60 色，覆盖彩虹并有深浅变化，供会话主题色随机分配与手动选取。
const PALETTE = [
  "#fa5f5f","#faac5f","#fafa5f","#acfa5f","#5ffa5f","#5ffaac",
  "#5ffafa","#5facfa","#5f5ffa","#ac5ffa","#fa5ffa","#fa5fac",
  "#e64040","#e69340","#e6e640","#93e640","#40e640","#40e693",
  "#40e6e6","#4093e6","#4040e6","#9340e6","#e640e6","#e64093",
  "#d15e5e","#d1985e","#d1d15e","#98d15e","#5ed15e","#5ed198",
  "#5ed1d1","#5e98d1","#5e5ed1","#985ed1","#d15ed1","#d15e98",
  "#bf2626","#bf7326","#bfbf26","#73bf26","#26bf26","#26bf73",
  "#26bfbf","#2673bf","#2626bf","#7326bf","#bf26bf","#bf2673",
  "#fc8b8b","#fcc48b","#fcfc8b","#c4fc8b","#8bfc8b","#8bfcc4",
  "#8bfcfc","#8bc4fc","#8b8bfc","#c48bfc","#fc8bfc","#fc8bc4",
];
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

