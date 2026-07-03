// AI 智能页（两级）：
//   一级 = 主题爆炸图：中心「洞察」迸发出各主题节点；悬停显名、交替闪烁+脉动；
//          点主题弹综述卡片；卡片内「进入该主题」→ 二级。仅受设备选择器约束。
//   二级 = 主题内泳道：该主题下的日志按会话为列排布，受 月/天/会话 选择器约束
//          （主题为固定隐藏筛选）；点节点看原文。复用会话主题色/名（aliases.js + PALETTE）。

// ── 会话颜色（与 viewer 一致）──
const COLOR_KEY = "ailogy:colors";
const _serverColors = {};
function loadColors() { try { return JSON.parse(localStorage.getItem(COLOR_KEY) || "{}") || {}; } catch (_) { return {}; } }
function saveColorLocal(code, color) { const m = loadColors(); if (color) m[code] = color; else delete m[code]; try { localStorage.setItem(COLOR_KEY, JSON.stringify(m)); } catch (_) {} }
let _autoIdx = 0;
function colorOf(code) {
  if (_serverColors[code]) return _serverColors[code];
  const m = loadColors(); if (m[code]) return m[code];
  const c = PALETTE[_autoIdx++ % PALETTE.length]; saveColorLocal(code, c); return c;
}

// ── API ──
const AI = {
  topics: (devices) => { const p = new URLSearchParams(); if (Array.isArray(devices)) p.set("devices", devices.join(",")); return fetch("/api/ai/topics?" + p).then((r) => r.json()); },
  insights: (topic, devices) => { const p = new URLSearchParams(); if (topic != null) p.set("topics", topic); if (Array.isArray(devices)) p.set("devices", devices.join(",")); return fetch("/api/ai/insights?" + p).then((r) => r.json()); },
  devices: () => fetch("/api/ai/devices").then((r) => r.json()),
};

const $ = (id) => document.getElementById(id);
const ST = {
  level: 1,
  devices: [], selectedDevices: null,
  topics: [],
  topic: null,          // 当前进入的主题
  // 二级泳道状态
  items: [], sessions: [], days: [], month: null,
  selectedDays: null, hiddenSessions: null, active: null,
};

// ══════════ 一级：主题爆炸图 ══════════
async function loadGalaxy() {
  const devs = ST.selectedDevices ? [...ST.selectedDevices] : null;
  try {
    const r = await AI.topics(devs);
    ST.topics = r.topics || [];
  } catch (_) { ST.topics = []; }
  renderGalaxy();
}

let _labelTimer = 0;
function renderGalaxy() {
  const stage = $("galaxy-stage");
  const empty = $("galaxy-empty");
  // 清掉旧节点/标签/连线（保留核）
  stage.querySelectorAll(".galaxy-node, .galaxy-label, .galaxy-rays").forEach((e) => e.remove());
  const topics = ST.topics;
  if (empty) empty.hidden = topics.length > 0;
  if (!topics.length) return;

  const rect = stage.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const R = Math.max(140, Math.min(rect.width, rect.height) * 0.34);
  const maxCnt = Math.max(...topics.map((t) => t.entry_count || 1));

  // 连线层
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "galaxy-rays");
  stage.appendChild(svg);

  topics.forEach((t, i) => {
    const ang = (i / topics.length) * Math.PI * 2 - Math.PI / 2;
    // 半径按数量微调（大主题略近核、更聚焦），并加轻微错落
    const rr = R * (0.82 + 0.28 * (i % 2 ? 1 : 0.6));
    const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
    const color = t.color || colorOf(t.topic);
    const size = 40 + 26 * Math.min(1, (t.entry_count || 1) / maxCnt);  // 40~66px 按数量

    // 连线
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", cx); ln.setAttribute("y1", cy);
    ln.setAttribute("x2", x); ln.setAttribute("y2", y);
    ln.setAttribute("class", "galaxy-ray"); ln.setAttribute("stroke", color);
    svg.appendChild(ln);

    // 节点
    const node = document.createElement("div");
    node.className = "galaxy-node enter";
    node.style.setProperty("--c", color);
    node.style.left = x + "px"; node.style.top = y + "px";
    node.style.width = size + "px"; node.style.height = size + "px";
    node.style.setProperty("--pulse", (2.4 + (i % 5) * 0.5) + "s");   // 交替脉动周期
    node.style.setProperty("--delay", (i % 4) * 0.4 + "s");
    node.innerHTML = `<span class="gn-emo">${topicEmoji(t.topic)}</span>`;
    node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
    // 悬停标签
    const label = document.createElement("div");
    label.className = "galaxy-label";
    label.style.left = x + "px"; label.style.top = (y + size / 2) + "px";
    label.textContent = t.topic;
    stage.appendChild(label);
    node.addEventListener("mouseenter", () => label.classList.add("on"));
    node.addEventListener("mouseleave", () => label.classList.remove("on"));
    node.onclick = () => openTopicCard(t);
    stage.appendChild(node);
  });
}

// 主题 emoji：用主题名派生一个稳定 emoji（无语义，仅点缀）
const _EMOJI_POOL = ["🌱","⚙️","🔧","📦","🚀","🧭","🧩","📊","🔬","🎯","🗂️","💡","🛠️","🔭","📐","🧪"];
function topicEmoji(topic) {
  let h = 0; for (const ch of (topic || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return _EMOJI_POOL[h % _EMOJI_POOL.length];
}

// ── 主题综述卡片 ──
function openTopicCard(t) {
  const card = $("topic-card");
  card.style.setProperty("--c", t.color || colorOf(t.topic));
  $("topic-card-name").textContent = t.topic;
  $("topic-card-cnt").textContent = `${t.entry_count || 0} 条日志`;
  $("topic-card-body").innerHTML = renderMd(t.summary || "");
  renderMermaid($("topic-card-body")); renderMath($("topic-card-body"));
  $("topic-card-enter").onclick = () => { closeTopicCard(); enterTopic(t); };
  card.hidden = false;
}
function closeTopicCard() { $("topic-card").hidden = true; }

// ══════════ 二级：主题内泳道 ══════════
const ROW_H = 64, COL_W = 60, COL_X0 = 30, TOP_PAD = 24;
const ns = "http://www.w3.org/2000/svg";
const NODE_HALF = 17, RIGHT_PAD = 8;

async function enterTopic(t) {
  ST.level = 2; ST.topic = t.topic;
  // 切换页面显隐
  $("ai-galaxy").hidden = true;
  $("ai-lane").hidden = false;
  $("ai-back").hidden = false;
  $("month-pick").hidden = false;
  await loadTopicLane();
}

function backToGalaxy() {
  ST.level = 1; ST.topic = null; ST.active = null;
  $("ai-lane").hidden = true;
  $("ai-back").hidden = true;
  $("month-pick").hidden = true;
  $("header-row2").hidden = true;
  $("ai-galaxy").hidden = false;
  loadGalaxy();
}

async function loadTopicLane() {
  const devs = ST.selectedDevices ? [...ST.selectedDevices] : null;
  try {
    const r = await AI.insights(ST.topic, devs);
    ST.items = r.items || [];
  } catch (_) { ST.items = []; }
  buildLaneModel();
  // 默认全选天、不隐藏会话
  ST.selectedDays = new Set(ST.days.map((d) => d.day));
  ST.hiddenSessions = new Set();
  updateMonthLabel();
  renderLane();
}

function buildLaneModel() {
  for (const k of Object.keys(_serverColors)) delete _serverColors[k];
  for (const e of ST.items) { if (e.color) _serverColors[e.session_code] = e.color; }
  const sessMap = {}, dayMap = {};
  for (const e of ST.items) {
    if (!sessMap[e.session_code]) sessMap[e.session_code] = { code: e.session_code, name: e.name || e.session_code, emoji: e.emoji || "📝", color: colorOf(e.session_code) };
    if (!dayMap[e.day]) dayMap[e.day] = { day: e.day };
  }
  ST.sessions = Object.values(sessMap);
  ST.days = Object.keys(dayMap).sort().reverse().map((d) => ({ day: d }));
}

function updateMonthLabel() {
  const el = $("month-label");
  if (el) el.textContent = ST.topic || "";
}

// 可见性
function isDaySelected(day) { return ST.selectedDays && ST.selectedDays.has(day); }
function sessAppearsInVisibleDays(code) { return ST.items.some((e) => e.session_code === code && isDaySelected(e.day)); }
function isSessVisible(code) { return sessAppearsInVisibleDays(code) && !ST.hiddenSessions.has(code); }
function entrySelected(e) { return isDaySelected(e.day) && isSessVisible(e.session_code); }

function renderLane() {
  const row2 = $("header-row2");
  row2.hidden = ST.sessions.length === 0;
  renderLaneCaps();
  renderLaneStage();
}

function renderLaneCaps() {
  const sessRow = $("cap-sessions");
  sessRow.innerHTML = ST.sessions.map((s) => {
    const appears = sessAppearsInVisibleDays(s.code);
    const cls = !appears ? "grey" : (!ST.hiddenSessions.has(s.code) ? "on" : "off");
    return `<div class="cap sess-cap ${cls}" data-code="${esc(s.code)}" style="--c:${s.color}">
      <span class="cap-dot"></span><span class="emo">${s.emoji}</span>
      <span class="cap-name">${sessDisplayHtml(s.code, s.name)}</span></div>`;
  }).join("");
  sessRow.querySelectorAll(".sess-cap").forEach((el) => {
    if (!el.classList.contains("grey")) el.onclick = () => { toggleSession(el.dataset.code); };
  });
  const dayRow = $("cap-days");
  dayRow.innerHTML = ST.days.map((d) => `<div class="cap day-cap ${isDaySelected(d.day) ? "on" : "off"}" data-day="${d.day}">
    <span class="cap-name">${d.day.slice(5)}</span></div>`).join("");
  dayRow.querySelectorAll(".day-cap").forEach((el) => el.onclick = () => toggleDay(el.dataset.day));
}
function toggleDay(day) {
  if (isDaySelected(day)) { if (ST.days.filter((d) => isDaySelected(d.day)).length <= 1) { showToast("至少保留一个可见天", { type: "err" }); return; } ST.selectedDays.delete(day); }
  else ST.selectedDays.add(day);
  renderLane();
}
function toggleSession(code) {
  if (!sessAppearsInVisibleDays(code)) return;
  if (ST.hiddenSessions.has(code)) ST.hiddenSessions.delete(code);
  else { if (ST.sessions.filter((s) => isSessVisible(s.code)).length <= 1) { showToast("至少保留一个可见会话", { type: "err" }); return; } ST.hiddenSessions.add(code); }
  renderLane();
}

function renderLaneStage() {
  const stage = $("stage");
  const visSessions = ST.sessions.filter((s) => isSessVisible(s.code));
  const laneOf = {}; visSessions.forEach((s, i) => laneOf[s.code] = i);
  const vis = ST.items.filter(entrySelected).sort((a, b) => a.datetime < b.datetime ? -1 : 1);
  stage.innerHTML = "";
  if (!vis.length) { stage.innerHTML = '<div class="empty">该主题在当前筛选下暂无日志</div>'; return; }
  const n = Math.max(visSessions.length, 1);
  const W = COL_X0 + (n - 1) * COL_W + NODE_HALF + RIGHT_PAD;
  const nodeY = []; let y = TOP_PAD, lastDay = null;
  vis.forEach((e, i) => {
    if (e.day !== lastDay) { if (i > 0) y += ROW_H; y += ROW_H; lastDay = e.day; }
    else y += ROW_H;
    nodeY.push(y);
  });
  const H = (nodeY[nodeY.length - 1] || TOP_PAD) + ROW_H + 30;
  stage.style.width = W + "px"; stage.style.height = H + "px";

  const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "rails");
  visSessions.forEach((s) => {
    const x = COL_X0 + laneOf[s.code] * COL_W;
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("class", "rail-ext"); ln.setAttribute("x1", 0); ln.setAttribute("x2", 0);
    ln.setAttribute("y1", 0); ln.setAttribute("y2", H); ln.setAttribute("stroke", s.color);
    ln.style.transform = `translateX(${x}px)`; svg.appendChild(ln);
  });
  stage.appendChild(svg);

  vis.forEach((e, i) => {
    const s = visSessions.find((x) => x.code === e.session_code) || ST.sessions.find((x) => x.code === e.session_code);
    const x = COL_X0 + laneOf[e.session_code] * COL_W, ny = nodeY[i];
    const node = document.createElement("div");
    node.className = "node"; node.dataset.id = e.id;
    node.style.setProperty("--c", s.color); node.style.left = x + "px"; node.style.top = ny + "px";
    node.dataset.tip = e.title || sessDisplay(e.session_code, s.name);
    node.innerHTML = `<div class="knob"><span class="knob-emo">${e.emoji || "📝"}</span><span class="knob-open">${icon("check")}</span></div>`;
    node.onclick = () => selectLaneNode(e, node);
    stage.appendChild(node);
  });
}

function selectLaneNode(e, node) {
  if (ST.active === node) { closeLaneDetail(); return; }
  if (ST.active && ST.active.classList) ST.active.classList.remove("active");
  node.classList.add("active"); ST.active = node;
  const s = ST.sessions.find((x) => x.code === e.session_code);
  const wrap = $("detail"); wrap.style.setProperty("--c", s ? s.color : "#6ea8fe");
  wrap.innerHTML =
    `<div class="box fresh"><div class="d-title">${e.title ? esc(e.title) : esc(sessDisplay(e.session_code, s && s.name))}</div>
      <div class="d-head"><span class="d-emo">${e.emoji || "📝"}</span>
        <span class="d-who">${esc(sessDisplay(e.session_code, s && s.name))}</span>
        <span class="d-seq">${esc(e.day || "")}</span></div></div>`
    + `<div class="box fresh"><div class="bt">${icon("note")} 日志原文</div><div class="d-sum md">${renderMd(e.summary || "")}</div></div>`
    + `<div class="box fresh"><div class="bt">${icon("laptop")} 归属</div><div class="metrics">`
    + `<div class="f"><div class="k">主题</div><div class="v">${esc(ST.topic || "")}</div></div>`
    + `<div class="f"><div class="k">设备</div><div class="v">${esc(e.device || "(未标注)")}</div></div>`
    + `</div></div>`;
  renderMermaid(wrap); renderMath(wrap);
}
function closeLaneDetail() {
  document.querySelectorAll("#stage .node.active").forEach((n) => n.classList.remove("active"));
  ST.active = null;
  $("detail").innerHTML = '<div class="box empty">' + icon("arrowLeft") + ' 点击左侧节点查看该条日志</div>';
}

// ══════════ 设备选择（多选，两级通用）══════════
function openDevicePicker(ev) {
  if (!ST.devices.length) { showToast("暂无设备记录", { title: "设备" }); return; }
  const sel = ST.selectedDevices;
  const apply = (next) => {
    ST.selectedDevices = next; updateDeviceLabel(); closeMenu();
    if (ST.level === 1) loadGalaxy(); else loadTopicLane();
  };
  const items = [
    { label: "全部设备", check: sel === null, act: () => apply(null) },
    { sep: true },
    ...ST.devices.map((d) => ({
      label: d || "(未标注)", check: (sel && sel.has(d)) || sel === null,
      act: () => {
        const next = new Set(sel === null ? ST.devices : sel);
        if (next.has(d)) next.delete(d); else next.add(d);
        if (!next.size) { showToast("至少保留一台设备", { type: "err" }); return; }
        apply(next.size === ST.devices.length ? null : next);
      },
    })),
  ];
  openMenu(ev, { head: "设备筛选（多选）", items });
}
function updateDeviceLabel() {
  const el = $("device-label"); if (!el) return;
  const sel = ST.selectedDevices;
  el.textContent = sel === null ? "全部设备" : sel.size === 1 ? ([...sel][0] || "(未标注)") : `${sel.size} 台设备`;
}

// ══════════ 初始化 ══════════
async function initAI() {
  if (typeof renderHeader === "function") renderHeader("ai");
  const devPick = $("device-pick"); if (devPick) devPick.onclick = openDevicePicker;
  $("ai-back").onclick = backToGalaxy;
  $("topic-card-close").onclick = closeTopicCard;
  $("topic-card").addEventListener("mousedown", (e) => { if (e.target === $("topic-card")) closeTopicCard(); });
  bindGlobalMenu();
  if (typeof initDebugTag === "function") initDebugTag("front/ai");
  try { const dr = await AI.devices(); ST.devices = dr.devices || []; } catch (_) {}
  updateDeviceLabel();
  await loadGalaxy();
  // 轻量轮询：主题/综述由后台 worker 异步产出，定时刷新一级图
  setInterval(() => { if (ST.level === 1 && !document.hidden) loadGalaxy(); }, 8000);
}
window.addEventListener("DOMContentLoaded", initAI);
