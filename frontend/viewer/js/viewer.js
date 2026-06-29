// 瀑布流（本地 ai-log 泳道风格）：会话为列、条目为节点、点节点看详情。
// 天/会话两级胶囊各自切显隐；会话固定主题色（可改色/重命名），天的色 = 当日会话色渐变。
// 默认只显本月，月份切换走顶部月份选择。

// ── 会话颜色（持久化、可改色）：localStorage ──
const COLOR_KEY = "ailogy:colors";
function loadColors() { try { return JSON.parse(localStorage.getItem(COLOR_KEY) || "{}") || {}; } catch (_) { return {}; } }
function saveColor(code, color) {
  const m = loadColors(); if (color) m[code] = color; else delete m[code];
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(m)); } catch (_) {}
}
let _autoIdx = 0;
function colorOf(code) {
  const m = loadColors();
  if (m[code]) return m[code];
  // 未指定则按出现顺序分配调色板色并固化，保证同会话跨天同色
  const c = PALETTE[_autoIdx++ % PALETTE.length];
  saveColor(code, c);
  return c;
}

// ── 状态 ──
const ST = {
  month: null,            // 当前月份 YYYY-MM
  entries: [],            // 当月全部条目（按时间升序）
  sessions: [],           // [{code, name, color}] 当月出现的会话
  days: [],               // [{day, sessions:Set, color}] 当月有数据的天
  hiddenSessions: new Set(),  // 隐藏的会话 code
  hiddenDays: new Set(),      // 隐藏的天
  active: null,           // 当前选中节点
};

const $ = (id) => document.getElementById(id);
const ROW_H = 64, COL_W = 60, COL_X0 = 30, TOP_PAD = 24;

// ── 拉取当月数据并构建 ──
async function loadMonth(month) {
  try {
    const r = await API.timeline(month);
    ST.month = r.month || (API.shareMode() ? "分享" : month);
    ST.entries = r.items;
    buildModel();
    render();
  } catch (err) {
    if (err instanceof AuthError) {
      $("stage").innerHTML = "";
      $("feed").innerHTML = `<div class="auth-gate"><p>需要登录后查看你的日志。</p>
        <a class="gate-btn" href="/platform">前往登录 / 注册 →</a></div>`;
    } else showToast("加载失败：" + err.message, { type: "err" });
  }
}

// 从 entries 派生 sessions / days 模型
function buildModel() {
  const sessMap = {}, dayMap = {};
  for (const e of ST.entries) {
    if (!sessMap[e.session_code]) {
      sessMap[e.session_code] = { code: e.session_code, name: e.name || e.session_code,
                                  emoji: e.emoji || "📝", color: colorOf(e.session_code) };
    }
    if (!dayMap[e.day]) dayMap[e.day] = { day: e.day, sessions: new Set() };
    dayMap[e.day].sessions.add(e.session_code);
  }
  ST.sessions = Object.values(sessMap);
  ST.days = Object.keys(dayMap).sort().reverse().map((d) => {
    const o = dayMap[d];
    o.color = dayGradient([...o.sessions]);  // 天色 = 当日会话色渐变
    return o;
  });
}

// 天的渐变色：当日各会话色组成 linear-gradient（单会话退化为纯色）
function dayGradient(codes) {
  const cols = codes.map(colorOf);
  if (cols.length === 1) return cols[0];
  return `linear-gradient(120deg, ${cols.join(", ")})`;
}

// 某条是否可见：其会话与其所在天都未被隐藏
function entryVisible(e) {
  return !ST.hiddenSessions.has(e.session_code) && !ST.hiddenDays.has(e.day);
}
// 某天是否「实际有可见条目」（会话全隐时该天也不显示）
function dayHasVisible(day) {
  return ST.entries.some((e) => e.day === day && !ST.hiddenSessions.has(e.session_code));
}

// ── 渲染：胶囊两行 + 泳道 stage ──
function render() {
  renderCapsules();
  renderStage();
  $("month-label").textContent = ST.month;
}

// 天胶囊行 + 会话胶囊行（两行，各自切显隐）
function renderCapsules() {
  // 会话行
  const sessRow = $("cap-sessions");
  sessRow.innerHTML = ST.sessions.map((s) => {
    const off = ST.hiddenSessions.has(s.code);
    const name = sessDisplay(s.code, s.name);
    return `<div class="cap sess-cap${off ? " off" : ""}" data-code="${esc(s.code)}" style="--c:${s.color}">
      <span class="cap-dot"></span><span class="emo">${s.emoji}</span>
      <span class="cap-name">${esc(name)}</span></div>`;
  }).join("");
  sessRow.querySelectorAll(".sess-cap").forEach((el) => {
    el.onclick = () => { toggleSession(el.dataset.code); };
    el.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); sessionMenu(ev, el.dataset.code); };
  });
  // 天行
  const dayRow = $("cap-days");
  dayRow.innerHTML = ST.days.map((d) => {
    const off = ST.hiddenDays.has(d.day);
    return `<div class="cap day-cap${off ? " off" : ""}" data-day="${d.day}">
      <span class="cap-swatch" style="background:${d.color}"></span>
      <span class="cap-name">${d.day.slice(5)}</span></div>`;  // 显示 MM-DD
  }).join("");
  dayRow.querySelectorAll(".day-cap").forEach((el) => {
    el.onclick = () => { toggleDay(el.dataset.day); };
  });
}

function toggleSession(code) {
  if (ST.hiddenSessions.has(code)) ST.hiddenSessions.delete(code); else ST.hiddenSessions.add(code);
  render();
}
function toggleDay(day) {
  if (ST.hiddenDays.has(day)) ST.hiddenDays.delete(day); else ST.hiddenDays.add(day);
  render();
}

// 会话右键菜单：重命名 / 改色 / 恢复
function sessionMenu(ev, code) {
  const s = ST.sessions.find((x) => x.code === code);
  const items = [
    { label: "✏️ 重命名", act: async () => {
      const v = await promptModal({ title: "自定义会话名称", desc: `会话 <b>${esc(code)}</b> · 留空恢复原名`,
                                    value: aliasOf(code) || "", placeholder: "易记名称" });
      if (v === null) return; saveAlias(code, v.trim()); render();
      showToast(v.trim() ? `已重命名为「${v.trim()}」` : "已恢复原名", { title: "会话" });
    } },
    { label: "🎨 改主题色", act: () => pickColor(code) },
  ];
  if (loadColors()[code]) items.push({ label: "↩️ 恢复默认色", act: () => { saveColor(code, ""); _autoIdx = 0; buildModel(); render(); } });
  openMenu(ev, { head: `<span class="emo">${s.emoji}</span>${esc(code)}`, items });
}

// 简单取色：用一个隐藏 input[type=color]
function pickColor(code) {
  const inp = document.createElement("input");
  inp.type = "color"; inp.value = toHex(colorOf(code));
  inp.style.position = "fixed"; inp.style.left = "-9999px";
  document.body.appendChild(inp);
  inp.oninput = () => { saveColor(code, inp.value); buildModel(); render(); };
  inp.onchange = () => { inp.remove(); showToast("已更新会话主题色", { title: "会话" }); };
  inp.click();
}
function toHex(c) { return /^#/.test(c) ? c : "#6ea8fe"; }

// ── 泳道 stage：可见会话为列，可见天分段，节点按时间排列 ──
function renderStage() {
  const stage = $("stage");
  // 可见会话 → 列号
  const visSessions = ST.sessions.filter((s) => !ST.hiddenSessions.has(s.code));
  const laneOf = {}; visSessions.forEach((s, i) => laneOf[s.code] = i);
  // 可见条目（天可见 + 该天有可见条目 + 会话可见），按时间升序
  const vis = ST.entries.filter((e) => entryVisible(e) && dayHasVisible(e.day))
                        .sort((a, b) => a.datetime < b.datetime ? -1 : 1);
  if (!vis.length) { stage.innerHTML = '<div class="empty">本月暂无可见日志</div>'; clearDetailIfGone(); return; }

  const ns = "http://www.w3.org/2000/svg";
  const W = COL_X0 + Math.max(visSessions.length, 1) * COL_W + 24;
  // 行：插入天分隔，逐条排行
  let row = 0, lastDay = null;
  const rowOf = [];  // 每条 entry 的行号
  const dayMarks = [];  // {day, row}
  vis.forEach((e) => {
    if (e.day !== lastDay) { dayMarks.push({ day: e.day, row }); row++; lastDay = e.day; }
    rowOf.push(row); row++;
  });
  const H = TOP_PAD + row * ROW_H + 30;
  stage.style.width = W + "px"; stage.style.height = H + "px";
  stage.innerHTML = "";

  // 泳道竖线（每个可见会话一列）
  const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "rails");
  visSessions.forEach((s) => {
    const x = COL_X0 + laneOf[s.code] * COL_W;
    const ext = document.createElementNS(ns, "line");
    ext.setAttribute("x1", x); ext.setAttribute("x2", x); ext.setAttribute("y1", 0); ext.setAttribute("y2", H);
    ext.setAttribute("stroke", s.color); ext.setAttribute("class", "rail-ext");
    svg.appendChild(ext);
  });
  stage.appendChild(svg);

  // 天分隔头
  dayMarks.forEach((m) => {
    const d = document.createElement("div");
    d.className = "day-row"; d.style.top = (TOP_PAD + m.row * ROW_H) + "px";
    const dd = ST.days.find((x) => x.day === m.day);
    d.innerHTML = `<span class="day-chip" style="background:${dd ? dd.color : "#888"}"></span> ${esc(m.day)}`;
    stage.appendChild(d);
  });

  // 节点
  vis.forEach((e, i) => {
    const s = ST.sessions.find((x) => x.code === e.session_code);
    const x = COL_X0 + laneOf[e.session_code] * COL_W, y = TOP_PAD + rowOf[i] * ROW_H;
    const n = document.createElement("div");
    n.className = "node"; n.style.left = x + "px"; n.style.top = y + "px";
    n.style.setProperty("--c", s.color); n.style.animationDelay = (i * 60) + "ms";
    const moon = e.carryover ? `<span class="moon">🌙</span>` : "";
    const rocket = e.mode === "full" ? `<span class="rocket">🚀</span>` : "";
    n.innerHTML = `<div class="knob">${e.emoji || "📝"}<span class="num">${e.seq}</span>${moon}${rocket}</div>`;
    n.dataset.id = e.id;
    n.dataset.tip = e.title || sessDisplay(e.session_code, s.name);
    n.onclick = () => selectNode(e, n);
    n.addEventListener("mouseenter", () => scheduleTip(n));
    n.addEventListener("mouseleave", cancelTip);
    stage.appendChild(n);
  });
  clearDetailIfGone();
}

function clearDetailIfGone() {
  // 选中的节点若已不在 DOM（被隐藏），关详情
  if (ST.active && !document.body.contains(ST.active)) { ST.active = null; closeDetail(); }
}

// ── 详情面板（右侧） ──
function selectNode(e, node) {
  if (ST.active === node) { closeDetail(); return; }
  document.querySelectorAll("#stage .node.active").forEach((n) => n.classList.remove("active"));
  node.classList.add("active"); ST.active = node;
  const s = ST.sessions.find((x) => x.code === e.session_code);
  const f = (k, v) => v ? `<div class="f"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>` : "";
  const u = e.usage;
  const wrap = $("detail");
  wrap.style.setProperty("--c", s.color);
  wrap.innerHTML =
    `<div class="box"><div class="d-title">${e.title ? esc(e.title) : esc(sessDisplay(e.session_code, s.name))}</div>
      <div class="d-head"><span class="d-emo">${e.emoji || "📝"}</span>
        <span class="d-who">${esc(sessDisplay(e.session_code, s.name))}</span>
        <span class="d-seq">#${e.seq}</span></div></div>`
    + `<div class="box"><div class="bt">📝 日志内容</div><div class="d-sum md">${renderMd(e.summary || "")}</div></div>`
    + `<div class="box"><div class="bt">⏱ 时间</div><div class="metrics">${f("起", fmtAt(e.start, e.day))}${f("止", fmtAt(e.end, e.day))}${f("时长", fmtDur(e.duration))}</div></div>`
    + (u ? `<div class="box"><div class="bt">📊 本段消耗</div><div class="metrics">${f("输入", fmtTok(u.input))}${f("输出", fmtTok(u.output))}${f("缓存读", fmtTok(u.cache_read))}${f("轮数", u.turns)}${f("API", u.api_calls)}</div></div>` : "")
    + `<div class="box"><div class="bt">🌿 / 🤖 / 📁</div><div class="metrics">${f("分支", e.branch)}${f("模型", e.model)}${f("项目", e.project)}</div></div>`;
  renderMermaid(wrap); renderMath(wrap);
  drawLink();
}
function closeDetail() {
  document.querySelectorAll("#stage .node.active").forEach((n) => n.classList.remove("active"));
  ST.active = null;
  $("detail").innerHTML = '<div class="box empty">👈 点击左侧节点查看该条日志</div>';
  $("linkpath").classList.remove("on");
}

// ── 连接线（选中节点 → 详情） ──
function drawLink() {
  const path = $("linkpath");
  if (!ST.active) { path.classList.remove("on"); return; }
  const a = ST.active.getBoundingClientRect(), b = $("detail").getBoundingClientRect();
  const x1 = a.right, y1 = a.top + a.height / 2, x2 = b.left, y2 = b.top + 28, mx = x1 + (x2 - x1) * .5;
  path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
  path.setAttribute("stroke", ST.active.style.getPropertyValue("--c"));
  path.classList.add("on");
}

// ── 节点悬停气泡（0.5s 延迟） ──
let _tipEl = null, _tipTimer = 0;
function scheduleTip(node) { clearTimeout(_tipTimer); _tipTimer = setTimeout(() => showTip(node), 500); }
function cancelTip() { clearTimeout(_tipTimer); if (_tipEl) _tipEl.classList.remove("on"); }
function showTip(node) {
  const text = node.dataset.tip || ""; if (!text) return;
  if (!_tipEl) { _tipEl = document.createElement("div"); _tipEl.className = "node-tip"; document.body.appendChild(_tipEl); }
  _tipEl.textContent = text; _tipEl.classList.add("on");
  const r = node.getBoundingClientRect(), tw = _tipEl.offsetWidth, th = _tipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 10;
  if (y < 6) y = r.bottom + 10;
  x = Math.max(6, Math.min(x, innerWidth - tw - 6));
  _tipEl.style.left = x + "px"; _tipEl.style.top = y + "px";
}

// ── 月份选择 ──
async function openMonthPicker(ev) {
  let months = [];
  try { months = (await API.months()).months; } catch (_) {}
  if (!months.length) { showToast("暂无历史月份", { title: "月份" }); return; }
  openMenu(ev, { head: "选择月份", items: months.map((m) => ({
    label: (m === ST.month ? "✓ " : "") + m, act: () => loadMonth(m),
  })) });
}

// ── 初始化 ──
async function initViewer() {
  if (typeof renderHeader === "function") renderHeader("viewer");
  $("month-pick").onclick = openMonthPicker;
  const left = $("left");
  if (left) left.addEventListener("scroll", () => { drawLink(); cancelTip(); }, { passive: true });
  window.addEventListener("scroll", () => { drawLink(); cancelTip(); }, { passive: true });
  window.addEventListener("resize", drawLink);
  bindGlobalMenu();
  initDebugTag("front/viewer");
  await loadMonth(null);  // 默认本月
}
window.addEventListener("DOMContentLoaded", initViewer);
