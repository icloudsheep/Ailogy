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

// 原子结构布局：按 entry_count 降序分环，内环最大、外环渐小。节点 DOM 按 topic 复用，
// 定时刷新时只更新 left/top/size（CSS transition 补间），不重建；不画中心连线。
// 选中（打开综述）的主题节点不参与刷新重排、放大并显示对号。
const _galaxyNodes = {};   // topic -> {node, label}
function ringLayout(topics, cx, cy, baseR) {
  // 分环：每环容量随环号增大（1、6、12…），内环大节点、外环小节点
  const rings = [];
  let idx = 0, ring = 0;
  while (idx < topics.length) {
    const cap = ring === 0 ? 1 : ring * 6;   // 原子壳层式容量
    rings.push(topics.slice(idx, idx + cap));
    idx += cap; ring++;
  }
  const pos = [];
  rings.forEach((items, r) => {
    const radius = r === 0 ? 0 : baseR * (0.55 + r * 0.62);
    const sizeBase = Math.max(34, 78 - r * 14);   // 内环最大，外环渐小
    items.forEach((t, i) => {
      const ang = items.length === 1 && r === 0 ? 0 : (i / items.length) * Math.PI * 2 - Math.PI / 2 + r * 0.4;
      pos.push({ t, x: cx + Math.cos(ang) * radius, y: cy + Math.sin(ang) * radius, size: sizeBase, ring: r });
    });
  });
  return pos;
}

function renderGalaxy() {
  const stage = $("galaxy-stage");
  const empty = $("galaxy-empty");
  const topics = ST.topics;
  if (empty) empty.hidden = topics.length > 0;

  const rect = stage.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const baseR = Math.max(120, Math.min(rect.width, rect.height) * 0.24);
  const layout = ringLayout(topics, cx, cy, baseR);
  const seen = new Set();

  layout.forEach((p, i) => {
    const t = p.t, color = t.color || colorOf(t.topic);
    seen.add(t.topic);
    let entry = _galaxyNodes[t.topic];
    if (!entry) {
      // 新节点：从中心迸发入场
      const node = document.createElement("div");
      node.className = "galaxy-node enter";
      node.innerHTML = `<span class="gn-emo">${topicEmoji(t.topic)}</span><span class="gn-check">${icon("check")}</span>`;
      node.style.left = cx + "px"; node.style.top = cy + "px";
      const label = document.createElement("div");
      label.className = "galaxy-label";
      node.addEventListener("mouseenter", () => label.classList.add("on"));
      node.addEventListener("mouseleave", () => label.classList.remove("on"));
      node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
      stage.appendChild(node); stage.appendChild(label);
      entry = _galaxyNodes[t.topic] = { node, label };
    }
    const { node, label } = entry;
    node.dataset.topic = t.topic;
    node.style.setProperty("--c", color);
    node.style.setProperty("--pulse", (2.6 + (i % 5) * 0.5) + "s");
    node.style.setProperty("--delay", (i % 4) * 0.35 + "s");
    label.textContent = t.topic;
    node.onclick = () => openTopicCard(t, node);
    // 选中的节点：位置/大小锁定，不随刷新重排（保持在原位，避免综述被它遮挡时错位）
    if (node.classList.contains("selected")) {
      label.style.left = node.style.left; label.style.top = (parseFloat(node.style.top) + parseFloat(node.style.height) / 2) + "px";
      return;
    }
    node.style.width = p.size + "px"; node.style.height = p.size + "px";
    node.style.left = p.x + "px"; node.style.top = p.y + "px";
    label.style.left = p.x + "px"; label.style.top = (p.y + p.size / 2) + "px";
  });
  // 移除已消失主题的节点（缩回中心淡出）
  Object.keys(_galaxyNodes).forEach((tp) => {
    if (!seen.has(tp)) {
      const { node, label } = _galaxyNodes[tp];
      node.classList.add("leaving"); label.remove();
      setTimeout(() => node.remove(), 500);
      delete _galaxyNodes[tp];
    }
  });
}

// 主题 emoji：用主题名派生一个稳定 emoji（无语义，仅点缀）
const _EMOJI_POOL = ["🌱","⚙️","🔧","📦","🚀","🧭","🧩","📊","🔬","🎯","🗂️","💡","🛠️","🔭","📐","🧪"];
function topicEmoji(topic) {
  let h = 0; for (const ch of (topic || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return _EMOJI_POOL[h % _EMOJI_POOL.length];
}

// ── 主题综述面板（右侧滑出，日志样式，无背景模糊；打开时选中节点放大+对号、暂停刷新）──
let _paused = false;                 // 打开综述后暂停一级刷新
function openTopicCard(t, node) {
  const card = $("topic-card");
  // 选中节点：清除旧选中、放大当前并显示对号
  Object.values(_galaxyNodes).forEach((e) => e.node.classList.remove("selected"));
  if (node) {
    node.classList.add("selected");
    // 把被选节点移到「左半区中心」：整图会向左平移(-24%)让出右侧给综述面板，
    // 节点落在 stage 中心，配合平移即居中于可见的左侧区域，且放大后不被面板遮挡。
    const stage = $("galaxy-stage");
    const w = stage.clientWidth, h = stage.clientHeight;
    node.style.left = (w / 2) + "px"; node.style.top = (h / 2) + "px";
    const { label } = _galaxyNodes[t.topic] || {};
    if (label) { label.style.left = (w / 2) + "px"; label.style.top = (h / 2 + parseFloat(node.style.height || 60) / 2) + "px"; }
  }
  $("ai-galaxy").classList.add("card-open");
  ST.selectedTopic = t; _paused = true;
  card.style.setProperty("--c", t.color || colorOf(t.topic));
  $("topic-card-name").textContent = t.topic;
  $("topic-card-cnt").textContent = `${t.entry_count || 0} 条日志`;
  const body = $("topic-card-body");
  if ((t.summary || "").trim()) {
    body.innerHTML = renderMd(t.summary);
    renderMermaid(body); renderMath(body);
  } else {
    body.innerHTML = '<div class="topic-card-empty">该主题暂无综述。综述由后台在配置好对话模型后自动生成；'
      + '可在「设置 → 智能 → 运行」查看处理进度或手动触发。</div>';
  }
  $("topic-card-enter").onclick = () => enterTopic(t);
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add("on"));   // 右侧滑入
}
function closeTopicCard() {
  const card = $("topic-card");
  card.classList.remove("on");
  setTimeout(() => { card.hidden = true; }, 320);
  $("ai-galaxy").classList.remove("card-open");   // 整图平移复位
  Object.values(_galaxyNodes).forEach((e) => e.node.classList.remove("selected"));
  renderGalaxy();   // 复位后重排选中节点回其原轨道位
  ST.selectedTopic = null; _paused = false;
}

// ══════════ 二级：主题内泳道 ══════════
const ROW_H = 64, COL_W = 60, COL_X0 = 30, TOP_PAD = 24;
const ns = "http://www.w3.org/2000/svg";
const NODE_HALF = 17, RIGHT_PAD = 8;

async function enterTopic(t) {
  ST.level = 2; ST.topic = t.topic;
  // 综述面板向右缩放关闭
  const card = $("topic-card");
  card.classList.remove("on"); card.classList.add("closing-right");
  setTimeout(() => { card.hidden = true; card.classList.remove("closing-right"); }, 340);
  // 爆炸图最小化消失（缩小淡出）——先去掉平移态，避免与 minimized 的 scale 叠加
  const galaxy = $("ai-galaxy");
  galaxy.classList.remove("card-open");
  galaxy.classList.add("minimized");
  setTimeout(() => { galaxy.hidden = true; galaxy.classList.remove("minimized"); }, 400);
  Object.values(_galaxyNodes).forEach((e) => e.node.classList.remove("selected"));
  _paused = false;
  // 二级：泳道 + 详情从缩小态放大进入
  const lane = $("ai-lane");
  lane.hidden = false; lane.classList.add("entering");
  requestAnimationFrame(() => lane.classList.remove("entering"));
  $("ai-back").hidden = false;
  await loadTopicLane();
}

function backToGalaxy() {
  ST.level = 1; ST.topic = null; ST.active = null;
  // 泳道向左缩小消失、详情向右缩小消失
  const lane = $("ai-lane");
  lane.classList.add("leaving");
  setTimeout(() => { lane.hidden = true; lane.classList.remove("leaving"); }, 360);
  $("ai-back").hidden = true;
  $("header-row2").hidden = true;
  // 爆炸图居中放大回归
  const galaxy = $("ai-galaxy");
  galaxy.hidden = false; galaxy.classList.add("restoring");
  requestAnimationFrame(() => galaxy.classList.remove("restoring"));
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
  bindGlobalMenu();
  if (typeof initDebugTag === "function") initDebugTag("front/ai");
  try { const dr = await AI.devices(); ST.devices = dr.devices || []; } catch (_) {}
  updateDeviceLabel();
  await loadGalaxy();
  // 轻量轮询：主题/综述由后台 worker 异步产出，定时刷新一级图（补间过渡）。
  // 打开综述（_paused）或在二级页面时不刷新，避免打断查看。
  setInterval(() => { if (ST.level === 1 && !_paused && !document.hidden) loadGalaxy(); }, 8000);
}
window.addEventListener("DOMContentLoaded", initAI);
