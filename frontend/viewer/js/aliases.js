// 会话别名：右键会话改易记名称，写浏览器 localStorage（跨页面同源共享）。
// 在线端先做本地软别名（够用、零后端改动）；展示处用 aliasOf() 覆盖原 session 名。
const ALIAS_KEY = "ailogy:aliases";

function loadAliases() {
  try { const v = JSON.parse(localStorage.getItem(ALIAS_KEY) || "{}"); return v && typeof v === "object" ? v : {}; }
  catch (_) { return {}; }
}
function aliasOf(code) {
  const m = loadAliases();
  return code in m ? m[code] : null;
}
function saveAlias(code, alias) {
  const m = loadAliases();
  if (alias) m[code] = alias; else delete m[code];
  try { localStorage.setItem(ALIAS_KEY, JSON.stringify(m)); } catch (_) {}
}
// 展示名：有别名用别名，否则用会话代号（动物+后四位，如 Eagle-7517，与本地 ai-log 一致）。
// 注意不要回退到 name（那只是 "Eagle"，丢了后缀）。
function sessDisplay(code, _fallbackName) {
  return aliasOf(code) || code;
}
// 展示名（HTML）：有别名时在其后追加半透明小字括号旧名（原会话代号），
// 让用户重命名后仍能对照原始会话。无别名则等同 esc(code)。调用方负责已引入 esc()。
function sessDisplayHtml(code, _fallbackName) {
  const alias = aliasOf(code);
  if (!alias) return esc(code);
  return `${esc(alias)}<span class="old-name">(${esc(code)})</span>`;
}
