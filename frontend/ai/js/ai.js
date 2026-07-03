// AI 智能泳道（demo 框架）：AI 洞察按「设备(多选) + 主题(单选切换)」分类，
// 泳道仍以「会话」为列、沿用会话主题色与名字（复用 aliases.js 的 colorOf/sessDisplay）。
// 数据来自 /api/ai/insights（demo 由 entries 派生，topic=project）。渲染为竖排时间线：
// 会话为列、洞察为节点，节点纵向按时间排列，同列相邻节点用竖线相连。
// 后续细节（真实 AI 产出、主题聚类、跨设备合并等）待敲定，这里先跑通数据链路与交互骨架。

// ── 会话颜色：服务端 color 优先，其余走 aliases.js 的调色板（与 viewer 一致）──
const COLOR_KEY = "ailogy:colors";
const _serverColors = {};
function loadColors() { try { return JSON.parse(localStorage.getItem(COLOR_KEY) || "{}") || {}; } catch (_) { return {}; } }
function saveColorLocal(code, color) {
  const m = loadColors(); if (color) m[code] = color; else delete m[code];
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(m)); } catch (_) {}
}
let _autoIdx = 0;
function colorOf(code) {
  if (_serverColors[code]) return _serverColors[code];
  const m = loadColors();
  if (m[code]) return m[code];
  const c = PALETTE[_autoIdx++ % PALETTE.length];
  saveColorLocal(code, c);
  return c;
}

// ── API ──
const AI = {
  insights: (topics, devices) => {
    const p = new URLSearchParams();
    if (Array.isArray(topics)) p.set("topics", topics.join(","));
    if (Array.isArray(devices)) p.set("devices", devices.join(","));
    return fetch("/api/ai/insights?" + p).then((r) => r.json());
  },
  topics: () => fetch("/api/ai/topics").then((r) => r.json()),
  devices: () => fetch("/api/ai/devices").then((r) => r.json()),
  rebuild: () => fetch("/api/ai/rebuild", { method: "POST" }).then((r) => r.json()),
};

// ── 状态：主题(单选，null=全部) + 设备(多选，null=全部) ──
const ST = {
  items: [],
  topics: [],          // [{topic,count}]
  devices: [],
  topic: null,         // 当前选中主题（null=全部主题混合）
  selectedDevices: null,
  sessions: [],
  active: null,
};

const $ = (id) => document.getElementById(id);
const ROW_H = 64, COL_W = 60, COL_X0 = 30, TOP_PAD = 24;
const ns = "http://www.w3.org/2000/svg";
const NODE_HALF = 17, RIGHT_PAD = 8;

// ── 拉取并构建 ──
async function loadAI() {
  const devs = ST.selectedDevices ? [...ST.selectedDevices] : null;
  const topics = ST.topic ? [ST.topic] : null;
  try {
    const r = await AI.insights(topics, devs);
    ST.items = r.items || [];
    buildModel();
    updateTopicLabel();
    if (ST.items.length) $("feed").innerHTML = "";
    render();
  } catch (err) {
    ST.items = []; ST.sessions = [];
    $("stage").innerHTML = "";
    showToast("加载失败：" + err.message, { type: "err" });
  }
}

function buildModel() {
  for (const k of Object.keys(_serverColors)) delete _serverColors[k];
  for (const e of ST.items) { if (e.color) _serverColors[e.session_code] = e.color; }
  const sessMap = {};
  for (const e of ST.items) {
    if (!sessMap[e.session_code]) {
      sessMap[e.session_code] = { code: e.session_code, name: e.name || e.session_code,
                                  emoji: e.emoji || "✨", color: colorOf(e.session_code) };
    }
  }
  ST.sessions = Object.values(sessMap);
}

function updateTopicLabel() {
  const el = $("device-label");
  if (el) el.textContent = ST.selectedDevices ? `${ST.selectedDevices.size} 台设备` : "全部设备";
}

// ── 渲染 ──
function render() {
  const caps = $("header-row2");
  const has = ST.items.length > 0;
  if (caps) caps.hidden = !ST.topics.length;
  if (!has) { renderEmpty(); renderTopics(); return; }
  renderTopics();
  renderStage();
}

function renderEmpty() {
  $("stage").innerHTML = "";
  $("detail").innerHTML = '<div class="box empty">' + icon("arrowLeft") + ' 点击左侧节点查看该条洞察</div>';
  $("feed").innerHTML = '<div class="empty-center"><div class="empty-main">暂无 AI 洞察</div>'
    + '<div class="empty-sub">可点击右上角设备/主题筛选，或稍后由 AI 生成</div></div>';
}

function renderTopics() {
  const row = $("cap-topics");
  if (!row) return;
  // 「全部」+ 各主题；单选切换（与 viewer 的天多选不同，这里主题是单选分类）
  const all = [{ topic: null, label: "全部", count: ST.items.length }]
    .concat(ST.topics.map((t) => ({ topic: t.topic, label: t.topic, count: t.count })));
  row.innerHTML = all.map((t) => {
    const on = (t.topic === ST.topic) || (t.topic === null && ST.topic === null);
    return `<div class="cap topic-cap ${on ? "on" : "off"}" data-topic="${t.topic === null ? "" : esc(t.topic)}">
      <span class="cap-name">${esc(t.label)}</span>
      <span class="topic-cnt">${t.count}</span></div>`;
  }).join("");
  row.querySelectorAll(".topic-cap").forEach((el) => {
    el.onclick = () => { ST.topic = el.dataset.topic || null; loadAI(); };
  });
}

// 泳道 stage：会话为列、洞察为节点（简化版，先跑通；动画细节后续对齐 viewer）
function renderStage() {
  const stage = $("stage");
  const sessions = ST.sessions;
  const laneOf = {}; sessions.forEach((s, i) => laneOf[s.code] = i);
  const vis = ST.items.slice().sort((a, b) => a.datetime < b.datetime ? -1 : 1);
  const n = Math.max(sessions.length, 1);
  const W = COL_X0 + (n - 1) * COL_W + NODE_HALF + RIGHT_PAD;

  // 每条洞察一行
  const nodeY = vis.map((_, i) => TOP_PAD + i * ROW_H);
  const H = (nodeY[nodeY.length - 1] || TOP_PAD) + ROW_H + 30;
  stage.style.width = W + "px"; stage.style.height = H + "px";
  stage.innerHTML = "";

  // 泳道竖线
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "rails");
  sessions.forEach((s) => {
    const x = COL_X0 + laneOf[s.code] * COL_W;
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("class", "rail-ext");
    ln.setAttribute("x1", 0); ln.setAttribute("x2", 0); ln.setAttribute("y1", 0); ln.setAttribute("y2", H);
    ln.setAttribute("stroke", s.color);
    ln.style.transform = `translateX(${x}px)`;
    svg.appendChild(ln);
  });
  stage.appendChild(svg);

  // 节点
  vis.forEach((e, i) => {
    const s = sessions.find((x) => x.code === e.session_code);
    const x = COL_X0 + laneOf[e.session_code] * COL_W, ny = nodeY[i];
    const node = document.createElement("div");
    node.className = "node";
    node.dataset.id = e.id;
    node.style.setProperty("--c", s.color);
    node.style.left = x + "px";
    node.style.top = ny + "px";
    node.dataset.tip = e.title || sessDisplay(e.session_code, s.name);
    node.innerHTML = `<div class="knob"><span class="knob-emo">${e.emoji || "✨"}</span><span class="knob-open">${icon("check")}</span></div>`;
    node.onclick = () => selectNode(e, node);
    stage.appendChild(node);
  });
}

// ── 详情面板（复用 viewer 的字段布局，去掉时间/消耗等日志专属项）──
function selectNode(e, node) {
  if (ST.active === node) { closeDetail(); return; }
  if (ST.active && ST.active.classList) ST.active.classList.remove("active");
  node.classList.add("active"); ST.active = node;
  const s = ST.sessions.find((x) => x.code === e.session_code);
  const wrap = $("detail");
  wrap.style.setProperty("--c", s ? s.color : "#6ea8fe");
  wrap.innerHTML =
    `<div class="box fresh"><div class="d-title">${e.title ? esc(e.title) : esc(sessDisplay(e.session_code, s && s.name))}</div>
      <div class="d-head"><span class="d-emo">${e.emoji || "✨"}</span>
        <span class="d-who">${esc(sessDisplay(e.session_code, s && s.name))}</span>
        <span class="d-seq">${esc(e.topic || "")}</span></div></div>`
    + `<div class="box fresh"><div class="bt">${icon("note")} 洞察内容</div><div class="d-sum md">${renderMd(e.summary || "")}</div></div>`
    + `<div class="box fresh"><div class="bt">${icon("laptop")} 来源</div><div class="metrics">`
    + `<div class="f"><div class="k">设备</div><div class="v">${esc(e.device || "(未标注)")}</div></div>`
    + `<div class="f"><div class="k">主题</div><div class="v">${esc(e.topic || "未归类")}</div></div>`
    + `</div></div>`;
  renderMermaid(wrap); renderMath(wrap);
}
function closeDetail() {
  document.querySelectorAll("#stage .node.active").forEach((n) => n.classList.remove("active"));
  ST.active = null;
  $("detail").innerHTML = '<div class="box empty">' + icon("arrowLeft") + ' 点击左侧节点查看该条洞察</div>';
}

// ── 设备选择（多选 + 全选，复用 viewer 逻辑的简化版）──
function openDevicePicker(ev) {
  if (!ST.devices.length) { showToast("暂无设备记录", { title: "设备" }); return; }
  const sel = ST.selectedDevices;
  const items = [
    { label: "全部设备", check: sel === null, act: () => { ST.selectedDevices = null; updateTopicLabel(); closeMenu(); loadAI(); } },
    { sep: true },
    ...ST.devices.map((d) => ({
      label: d || "(未标注)",
      check: (sel && sel.has(d)) || sel === null,
      act: () => {
        const next = new Set(ST.selectedDevices === null ? ST.devices : ST.selectedDevices);
        if (next.has(d)) next.delete(d); else next.add(d);
        if (!next.size) { showToast("至少保留一台设备", { type: "err" }); return; }
        ST.selectedDevices = next.size === ST.devices.length ? null : next;
        updateTopicLabel(); closeMenu(); loadAI();
      },
    })),
  ];
  openMenu(ev, { head: "设备筛选（多选）", items });
}

// ── 初始化 ──
async function initAI() {
  if (typeof renderHeader === "function") renderHeader("ai");
  const devPick = $("device-pick");
  if (devPick) devPick.onclick = openDevicePicker;
  bindGlobalMenu();
  if (typeof initDebugTag === "function") initDebugTag("front/ai");
  try {
    // demo：首次进入时若库空则从 entries 重建，保证有数据可看
    const t0 = await AI.topics();
    if (!t0.topics || !t0.topics.length) await AI.rebuild();
    const [tr, dr] = await Promise.all([AI.topics(), AI.devices()]);
    ST.topics = tr.topics || [];
    ST.devices = dr.devices || [];
  } catch (_) {}
  await loadAI();
}
window.addEventListener("DOMContentLoaded", initAI);
