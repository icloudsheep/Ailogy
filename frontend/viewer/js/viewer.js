// 瀑布流（本地 ai-log 泳道风格）：会话为列、条目为节点、点节点看详情。
// 天/会话两级胶囊各自切显隐；会话固定主题色（可改色/重命名），天的色 = 当日会话色渐变。
// 默认只显本月，月份切换走顶部月份 + 设备选择。
// 编辑/删除/改色固化到服务端 DB；选择器状态/主题固化到 localStorage。

// ── 会话颜色：服务端 entry.color 优先 → localStorage 调色板分配 ──
const COLOR_KEY = "ailogy:colors";
const _serverColors = {};  // session_code -> color（来自服务端 entry.color）
function loadColors() { try { return JSON.parse(localStorage.getItem(COLOR_KEY) || "{}") || {}; } catch (_) { return {}; } }
function saveColorLocal(code, color) {
  const m = loadColors(); if (color) m[code] = color; else delete m[code];
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(m)); } catch (_) {}
}
let _autoIdx = 0;
function colorOf(code) {
  if (_serverColors[code]) return _serverColors[code];   // 服务端固化优先
  const m = loadColors();
  if (m[code]) return m[code];
  const c = PALETTE[_autoIdx++ % PALETTE.length];
  saveColorLocal(code, c);
  return c;
}

// ── 状态 ──
// 天：selectedDays（用户自由控制的可见天集合）。
// 会话：hiddenSessions（用户显式隐藏，负向）。灰态由「是否出现在可见天」派生。
// 设备：devices（全部）、selectedDevices（当前筛选，null=全部）。
const ST = {
  month: null,
  entries: [],
  sessions: [],
  days: [],
  devices: [],
  selectedDevices: null,  // Set | null（null=全部设备）
  selectedDays: null,
  hiddenSessions: null,
  active: null,
};

const $ = (id) => document.getElementById(id);
const ROW_H = 64, COL_W = 60, COL_X0 = 30, TOP_PAD = 24;

// ── 选择器状态固化（localStorage，按月）──
const SEL_KEY = "ailogy:selection";
function loadSel() { try { return JSON.parse(localStorage.getItem(SEL_KEY) || "{}") || {}; } catch (_) { return {}; } }
function saveSel() {
  const all = loadSel();
  all[ST.month] = {
    days: [...(ST.selectedDays || [])],
    hidden: [...(ST.hiddenSessions || [])],
    devices: ST.selectedDevices ? [...ST.selectedDevices] : null,
  };
  try { localStorage.setItem(SEL_KEY, JSON.stringify(all)); } catch (_) {}
}

// ── 拉取当月数据并构建 ──
async function loadMonth(month, keepSel) {
  try {
    const devs = ST.selectedDevices ? [...ST.selectedDevices] : null;
    const r = await API.timeline(month, devs);
    ST.month = r.month || month;
    ST.entries = r.items;
    buildModel();
    // 恢复固化的选择器状态（仅当本月有保存且 keepSel）
    const saved = loadSel()[ST.month];
    if (keepSel && saved) {
      const validDays = new Set(ST.days.map((d) => d.day));
      ST.selectedDays = new Set((saved.days || []).filter((d) => validDays.has(d)));
      if (!ST.selectedDays.size) ST.selectedDays = new Set(ST.days.map((d) => d.day));
      ST.hiddenSessions = new Set(saved.hidden || []);
    } else {
      ST.selectedDays = new Set(ST.days.map((d) => d.day));
      ST.hiddenSessions = new Set();
    }
    if (ST.sessions.length) {
      $("feed").innerHTML = "";
      $("detail").innerHTML = '<div class="box empty">👈 点击左侧节点查看该条日志</div>';
    }
    render();
  } catch (err) {
    ST.entries = []; ST.sessions = []; ST.days = [];
    ST.selectedDays = new Set(); ST.hiddenSessions = new Set();
    $("feed").innerHTML = '<div class="empty-center"><div class="empty-main">无任何内容</div></div>';
    $("stage").innerHTML = "";
    $("detail").innerHTML = "";
    showToast("加载失败：" + err.message, { type: "err" });
  }
}

function buildModel() {
  // 收集服务端颜色覆盖（先清空，只保留当前月条目的颜色，避免跨月累积）
  for (const k of Object.keys(_serverColors)) delete _serverColors[k];
  for (const e of ST.entries) { if (e.color) _serverColors[e.session_code] = e.color; }
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
    o.color = dayGradient([...o.sessions]);
    return o;
  });
}

function dayGradient(codes) {
  const cols = codes.map(colorOf);
  if (cols.length === 1) return cols[0];
  return `linear-gradient(120deg, ${cols.join(", ")})`;
}

// ── 可见性辅助 ──
function isDaySelected(day) { return ST.selectedDays && ST.selectedDays.has(day); }
function sessAppearsInVisibleDays(code) {
  return ST.entries.some((e) => e.session_code === code && isDaySelected(e.day));
}
function isSessVisible(code) {
  return sessAppearsInVisibleDays(code) && !ST.hiddenSessions.has(code);
}
function entrySelected(e) { return isDaySelected(e.day) && isSessVisible(e.session_code); }

// ── 切换逻辑 ──
function toggleDay(day) {
  if (isDaySelected(day)) {
    const count = ST.days.filter((d) => isDaySelected(d.day)).length;
    if (count <= 1) { showToast("至少保留一个可见天", { type: "err" }); return; }
    ST.selectedDays.delete(day);
  } else {
    ST.selectedDays.add(day);
  }
  saveSel(); render();
}

function toggleSession(code) {
  if (!sessAppearsInVisibleDays(code)) return; // 灰态：不可切换
  if (ST.hiddenSessions.has(code)) {
    ST.hiddenSessions.delete(code);
  } else {
    const visibleCount = ST.sessions.filter((s) => isSessVisible(s.code)).length;
    if (visibleCount <= 1) { showToast("至少保留一个可见会话", { type: "err" }); return; }
    ST.hiddenSessions.add(code);
  }
  saveSel(); render();
}

// ── 渲染：增量更新 ──
let _lastCapsHash = "";
function render() {
  const caps = $("header-row2");
  const hasSessions = ST.sessions.length > 0;
  if (caps) caps.hidden = !hasSessions;
  $("month-label").textContent = ST.month || "";
  if (!hasSessions) { renderEmpty(); return; }
  const capHash = _capsHash();
  if (capHash !== _lastCapsHash) { _lastCapsHash = capHash; renderCapsules(); }
  renderStage();
}

function _capsHash() {
  return ST.sessions.map((s) => `${s.code}:${s.color}:${sessAppearsInVisibleDays(s.code)?1:0}:${ST.hiddenSessions.has(s.code)?1:0}`).join("|")
    + "|" + ST.days.map((d) => `${d.day}:${isDaySelected(d.day)?1:0}`).join("|");
}

function renderEmpty() {
  $("stage").innerHTML = "";
  $("detail").innerHTML = "";
  $("feed").innerHTML = '<div class="empty-center"><div class="empty-main">无任何内容</div></div>';
}

function renderCapsules() {
  const sessRow = $("cap-sessions");
  sessRow.innerHTML = ST.sessions.map((s) => {
    const appears = sessAppearsInVisibleDays(s.code);
    const grey = !appears;
    const on = appears && !ST.hiddenSessions.has(s.code);
    const cls = grey ? "grey" : (on ? "on" : "off");
    return `<div class="cap sess-cap ${cls}" data-code="${esc(s.code)}" style="--c:${s.color}">
      <span class="cap-dot"></span><span class="emo">${s.emoji}</span>
      <span class="cap-name">${esc(sessDisplay(s.code, s.name))}</span></div>`;
  }).join("");
  sessRow.querySelectorAll(".sess-cap").forEach((el) => {
    el.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); sessionMenu(ev, el.dataset.code, el.classList.contains("grey")); };
    if (!el.classList.contains("grey")) {
      el.onclick = () => toggleSession(el.dataset.code);
    }
  });

  const dayRow = $("cap-days");
  dayRow.innerHTML = ST.days.map((d) => {
    const cls = isDaySelected(d.day) ? "on" : "off";
    return `<div class="cap day-cap ${cls}" data-day="${d.day}">
      <span class="cap-swatch" style="background:${d.color}"></span>
      <span class="cap-name">${d.day.slice(5)}</span></div>`;
  }).join("");
  dayRow.querySelectorAll(".day-cap").forEach((el) => {
    el.onclick = () => { toggleDay(el.dataset.day); };
  });
}

// ── 会话菜单项 ──
function sessionMenuItems(code, grey) {
  const items = [
    { label: "✏️ 重命名会话", act: async () => {
      const v = await promptModal({ title: "自定义会话名称", desc: `会话 <b>${esc(code)}</b> · 留空恢复原名`,
                                    value: aliasOf(code) || "", placeholder: "易记名称" });
      if (v === null) return; saveAlias(code, v.trim()); render();
      showToast(v.trim() ? `已重命名为「${v.trim()}」` : "已恢复原名", { title: "会话" });
    } },
    { label: "🎨 改主题色", act: () => pickColor(code) },
  ];
  if (_serverColors[code] || loadColors()[code]) items.push({ label: "↩️ 恢复默认色",
    act: () => applyColor(code, "") });
  if (!grey) {
    const visible = !ST.hiddenSessions.has(code);
    items.unshift({ label: visible ? "🙈 隐藏" : "👁️ 显示", act: () => toggleSession(code) });
  }
  return items;
}

function sessionMenu(ev, code, grey) {
  const s = ST.sessions.find((x) => x.code === code);
  const head = `<span class="emo">${s.emoji}</span>${esc(code)}` + (grey ? ' <span style="font-size:10px;color:var(--dim)">(当前无可显示天)</span>' : '');
  openMenu(ev, { head, items: sessionMenuItems(code, grey) });
}

// 节点右键菜单：预览 + 编辑 + 删除 + 会话操作
function nodeMenu(ev, e, node) {
  cancelTip();
  openMenu(ev, {
    head: `<span class="emo">${e.emoji || "📝"}</span>${esc(e.title || sessDisplay(e.session_code, ""))}`,
    items: [
      { label: "👁️ 预览", act: () => openPreview(e) },
      { label: "✏️ 编辑", act: () => openEditModal(e) },
      { label: "🗑️ 删除", act: () => openDeleteModal(e) },
      { sep: true },
      ...sessionMenuItems(e.session_code, false),
    ],
  });
}

// ── 预览模态 ──
function openPreview(e) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal preview" role="dialog">
    <div class="modal-title">${esc(e.title || sessDisplay(e.session_code, e.name))}</div>
    <div class="modal-desc">${esc(e.day)} #${e.seq}</div>
    <div class="preview-body md">${renderMd(e.summary || "")}</div>
    <div class="modal-actions"><button class="modal-btn cancel">关闭</button></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("on"));
  const close = () => { document.removeEventListener("keydown", onEsc, true); overlay.classList.remove("on"); setTimeout(() => overlay.remove(), 260); };
  const onEsc = (ev2) => { if (ev2.key === "Escape") close(); };
  document.addEventListener("keydown", onEsc, true);
  overlay.querySelector(".cancel").onclick = close;
  overlay.addEventListener("mousedown", (ev2) => { if (ev2.target === overlay) close(); });
  renderMermaid(overlay); renderMath(overlay);
}

// ── 编辑模态：固化到服务端，不重置页面 ──
function openEditModal(e) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal edit" role="dialog">
    <div class="modal-title">✏️ 编辑日志</div>
    <div class="modal-desc">${esc(e.day)} #${e.seq} · ${esc(sessDisplay(e.session_code, e.name))}</div>
    <label class="edit-label">标题</label>
    <input class="modal-input edit-title" type="text" value="${esc(e.title || "")}" placeholder="日志标题" />
    <label class="edit-label">正文（Markdown，⌘/Ctrl+Enter 保存）</label>
    <textarea class="modal-input edit-body" placeholder="支持 Markdown、Mermaid 图与 $LaTeX$ 公式">${esc(e.summary || "")}</textarea>
    <div class="modal-actions">
      <button class="modal-btn cancel">取消</button>
      <button class="modal-btn ok">保存</button>
    </div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("on"));
  const body = overlay.querySelector(".edit-body");
  setTimeout(() => { body.focus(); body.setSelectionRange(body.value.length, body.value.length); }, 60);
  let done = false;
  const close = () => {
    if (done) return; done = true;
    body.removeEventListener("keydown", onBodyKey, false);
    overlay.classList.remove("on"); setTimeout(() => overlay.remove(), 260);
  };
  const save = async () => {
    const newTitle = overlay.querySelector(".edit-title").value.trim();
    const newSummary = body.value;
    try {
      await API.editEntry(e.id, newTitle, newSummary);
      // 原地更新内存条目，不重载页面
      e.title = newTitle; e.summary = newSummary;
      const arr = ST.entries.find((x) => x.id === e.id);
      if (arr) { arr.title = newTitle; arr.summary = newSummary; }
      close();
      showToast("已保存", { title: "日志" });
      patchNodeTitle(e);
      if (ST.active && ST.active.dataset.id === String(e.id)) selectNodeDetail(e, ST.active);
    } catch (err) { showToast("保存失败：" + err.message, { type: "err" }); }
  };
  const onBodyKey = (ev2) => {
    if ((ev2.metaKey || ev2.ctrlKey) && ev2.key === "Enter") { ev2.preventDefault(); save(); }
    else if (ev2.key === "Escape") { close(); }
  };
  overlay.querySelector(".ok").onclick = save;
  overlay.querySelector(".cancel").onclick = close;
  overlay.addEventListener("mousedown", (ev2) => { if (ev2.target === overlay) close(); });
  body.addEventListener("keydown", onBodyKey, false);
}

// ── 删除模态：固化到服务端，原地移除节点，不重置页面 ──
function openDeleteModal(e) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal" role="dialog">
    <div class="modal-title">删除日志</div>
    <div class="modal-desc">确认删除 <b>${esc(e.day)} #${e.seq}</b> · ${esc(e.title || sessDisplay(e.session_code, e.name))}？</div>
    <div class="modal-actions">
      <button class="modal-btn cancel">取消</button>
      <button class="modal-btn ok danger">确认删除</button>
    </div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("on"));
  let done = false;
  const escHandler = (ev2) => { if (ev2.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler, true);
  const close = () => {
    if (done) return; done = true;
    document.removeEventListener("keydown", escHandler, true);
    overlay.classList.remove("on"); setTimeout(() => overlay.remove(), 260);
  };
  const del = async () => {
    try {
      await API.deleteEntry(e.id);
      ST.entries = ST.entries.filter((x) => x.id !== e.id);
      buildModel();
      // 保持当前选择器状态：剔除已不存在的天/会话
      const validDays = new Set(ST.days.map((d) => d.day));
      ST.selectedDays = new Set([...ST.selectedDays].filter((d) => validDays.has(d)));
      if (!ST.selectedDays.size) ST.selectedDays = new Set(ST.days.map((d) => d.day));
      if (ST.active && ST.active.dataset.id === String(e.id)) closeDetail();
      render();
      close();
      showToast("已删除", { title: "日志" });
    } catch (err) { showToast("删除失败：" + err.message, { type: "err" }); }
  };
  overlay.querySelector(".ok").onclick = del;
  overlay.querySelector(".cancel").onclick = close;
  overlay.addEventListener("mousedown", (ev2) => { if (ev2.target === overlay) close(); });
}

// 编辑后原地更新节点 tooltip（不重渲整个 stage）
function patchNodeTitle(e) {
  const node = document.querySelector(`#stage .node[data-id="${e.id}"]`);
  if (node) node.dataset.tip = e.title || sessDisplay(e.session_code, e.name);
}

// ── 取色模态：固化到服务端 ──
function pickColor(code) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const swatches = PALETTE.map((c) =>
    `<button class="sw" data-c="${c}" style="background:${c}"></button>`).join("");
  overlay.innerHTML = `<div class="modal" role="dialog">
      <div class="modal-title">会话主题色</div>
      <div class="modal-desc">会话 <b>${esc(code)}</b> · 选预设或自定义</div>
      <div class="sw-grid">${swatches}</div>
      <div class="sw-custom">自定义 <input type="color" class="sw-input" value="${toHex(colorOf(code))}"></div>
      <div class="modal-actions"><button class="modal-btn ok">完成</button></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("on"));
  overlay.querySelectorAll(".sw").forEach((b) => b.onclick = () => applyColor(code, b.dataset.c));
  overlay.querySelector(".sw-input").addEventListener("input", (ev2) => applyColor(code, ev2.target.value));
  const close = () => { overlay.classList.remove("on"); setTimeout(() => overlay.remove(), 240); };
  overlay.querySelector(".ok").onclick = close;
  overlay.addEventListener("mousedown", (ev2) => { if (ev2.target === overlay) close(); });
}

// 应用颜色：固化服务端 + 更新内存 + 原地重渲，不重载
async function applyColor(code, color) {
  try {
    await API.setColor(code, color);
    if (color) _serverColors[code] = color; else delete _serverColors[code];
    saveColorLocal(code, color);  // 同步本地缓存，刷新前也一致
    // 更新内存中该会话颜色与所有条目
    for (const s of ST.sessions) if (s.code === code) s.color = colorOf(code);
    for (const e of ST.entries) if (e.session_code === code) e.color = color || null;
    // 重算天渐变色
    ST.days.forEach((d) => { d.color = dayGradient([...d.sessions]); });
    _lastCapsHash = "";  // 强制胶囊重绘（颜色变了）
    render();
    showToast(color ? "已更新会话主题色" : "已恢复默认色", { title: "会话" });
  } catch (err) { showToast("改色失败：" + err.message, { type: "err" }); }
}
function toHex(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#6ea8fe"; }

// ── 泳道 stage ──
function renderStage() {
  const stage = $("stage");
  const visSessions = ST.sessions.filter((s) => isSessVisible(s.code));
  const laneOf = {}; visSessions.forEach((s, i) => laneOf[s.code] = i);
  const vis = ST.entries.filter((e) => entrySelected(e))
                        .sort((a, b) => a.datetime < b.datetime ? -1 : 1);
  if (!vis.length) { stage.innerHTML = '<div class="empty">本月暂无可见日志</div>'; clearDetailIfGone(); return; }

  const ns = "http://www.w3.org/2000/svg";
  const n = Math.max(visSessions.length, 1);
  // 右边缘留 8px：最后一列节点中心 + 节点半宽(17) + 8
  const W = COL_X0 + (n - 1) * COL_W + 17 + 8;
  let row = 0, lastDay = null;
  const rowOf = [], dayMarks = [];
  vis.forEach((e) => {
    if (e.day !== lastDay) { dayMarks.push({ day: e.day, row }); row++; lastDay = e.day; }
    rowOf.push(row); row++;
  });
  const H = TOP_PAD + row * ROW_H + 30;
  stage.style.width = W + "px"; stage.style.height = H + "px";
  stage.innerHTML = "";

  const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "rails");
  visSessions.forEach((s) => {
    const x = COL_X0 + laneOf[s.code] * COL_W;
    const ext = document.createElementNS(ns, "line");
    ext.setAttribute("x1", x); ext.setAttribute("x2", x); ext.setAttribute("y1", 0); ext.setAttribute("y2", H);
    ext.setAttribute("stroke", s.color); ext.setAttribute("class", "rail-ext");
    svg.appendChild(ext);
  });
  stage.appendChild(svg);

  // 日期标识：横跨整个泳道宽度的圆角矩形，固定在两天交界处
  dayMarks.forEach((m) => {
    const dd = ST.days.find((x) => x.day === m.day);
    const band = document.createElement("div");
    band.className = "day-band";
    band.style.top = (TOP_PAD + m.row * ROW_H - 6) + "px";
    band.style.width = W + "px";
    band.innerHTML = `<span class="day-band-label">${esc(m.day.slice(5))}</span>`;
    if (dd) band.style.setProperty("--day-c", dd.color);
    stage.appendChild(band);
  });

  vis.forEach((e, i) => {
    const s = ST.sessions.find((x) => x.code === e.session_code);
    const x = COL_X0 + laneOf[e.session_code] * COL_W, y = TOP_PAD + rowOf[i] * ROW_H;
    const n = document.createElement("div");
    n.className = "node"; n.style.left = x + "px"; n.style.top = y + "px";
    n.style.setProperty("--c", s.color); n.style.animationDelay = (i * 60) + "ms";
    const moon = e.carryover ? `<span class="moon">🌙</span>` : "";
    const rocket = e.mode === "full" ? `<span class="rocket">🚀</span>` : "";
    n.innerHTML = `<div class="knob">${e.emoji || "📝"}${moon}${rocket}</div>`;
    n.dataset.id = e.id;
    n.dataset.tip = e.title || sessDisplay(e.session_code, s.name);
    n.onclick = () => selectNode(e, n);
    n.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); nodeMenu(ev, e, n); };
    n.addEventListener("mouseenter", () => scheduleTip(n));
    n.addEventListener("mouseleave", cancelTip);
    stage.appendChild(n);
  });
  clearDetailIfGone();
  stage.classList.remove("swap");
  void stage.offsetWidth;
  stage.classList.add("swap");
}

function clearDetailIfGone() {
  if (ST.active && !document.body.contains(ST.active)) { ST.active = null; closeDetail(); }
}

async function focusEntry(e) {
  const month = (e.day || e.datetime || "").slice(0, 7);
  if (month && month !== ST.month) await loadMonth(month, false);
  ST.selectedDays = new Set([e.day]);
  ST.hiddenSessions = new Set(
    ST.sessions.map((s) => s.code).filter((c) => c !== e.session_code));
  saveSel();
  render();
  const node = document.querySelector(`#stage .node[data-id="${e.id}"]`);
  if (node) { selectNode(e, node); node.scrollIntoView({ behavior: "smooth", block: "center" }); }
  else showToast("已跳转，但未定位到该条节点", { title: "搜索" });
}

// ── 详情面板 ──
function selectNode(e, node) {
  if (ST.active === node) { closeDetail(); return; }
  selectNodeDetail(e, node);
}

function selectNodeDetail(ef, node) {
  if (ST.active && ST.active !== node && ST.active.classList) ST.active.classList.remove("active");
  if (node && node.classList) { node.classList.add("active"); ST.active = node; }
  else ST.active = null;
  const s = ST.sessions.find((x) => x.code === ef.session_code);
  const f = (k, v) => v ? `<div class="f"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>` : "";
  const u = ef.usage;
  const wrap = $("detail");
  wrap.style.setProperty("--c", s.color);
  wrap.innerHTML =
    `<div class="box fresh"><div class="d-title">${ef.title ? esc(ef.title) : esc(sessDisplay(ef.session_code, s.name))}</div>
      <div class="d-head"><span class="d-emo">${ef.emoji || "📝"}</span>
        <span class="d-who">${esc(sessDisplay(ef.session_code, s.name))}</span>
        <span class="d-seq">#${ef.seq}</span></div></div>`
    + `<div class="box fresh"><div class="bt">📝 日志内容</div><div class="d-sum md">${renderMd(ef.summary || "")}</div></div>`
    + `<div class="box fresh"><div class="bt">⏱ 时间</div><div class="metrics">${f("起", fmtAt(ef.start, ef.day))}${f("止", fmtAt(ef.end, ef.day))}${f("时长", fmtDur(ef.duration))}</div></div>`
    + (u ? `<div class="box fresh"><div class="bt">📊 本段消耗</div><div class="metrics">${f("输入", fmtTok(u.input))}${f("输出", fmtTok(u.output))}${f("缓存读", fmtTok(u.cache_read))}${f("轮数", u.turns)}${f("API", u.api_calls)}</div></div>` : "")
    + `<div class="box fresh"><div class="bt">🌿 / 🤖 / 📁 / 💻</div><div class="metrics">${f("分支", ef.branch)}${f("模型", ef.model)}${f("项目", ef.project)}${f("设备", ef.device)}</div></div>`;
  renderMermaid(wrap); renderMath(wrap);
  drawLink();
}

function closeDetail() {
  document.querySelectorAll("#stage .node.active").forEach((n) => n.classList.remove("active"));
  ST.active = null;
  $("detail").innerHTML = '<div class="box empty">👈 点击左侧节点查看该条日志</div>';
  $("linkpath").classList.remove("on");
  _linkActive = false;
  if (_linkFrame) { cancelAnimationFrame(_linkFrame); _linkFrame = 0; }
}

// ── 连接线 ──
let _linkFrame = 0;
let _linkActive = false;
function drawLink() {
  if (_linkFrame) cancelAnimationFrame(_linkFrame);
  const path = $("linkpath");
  if (!ST.active || !ST.active.getBoundingClientRect) { path.classList.remove("on"); _linkActive = false; return; }
  _linkActive = true;
  const track = () => {
    if (!_linkActive) return;
    if (!ST.active || !ST.active.getBoundingClientRect || !document.body.contains(ST.active)) {
      path.classList.remove("on"); _linkActive = false; return;
    }
    const a = ST.active.getBoundingClientRect(), b = $("detail").getBoundingClientRect();
    if (!a || !b || a.width === 0) { _linkFrame = requestAnimationFrame(track); return; }
    const x1 = a.right, y1 = a.top + a.height / 2, x2 = b.left, y2 = b.top + 28, mx = x1 + (x2 - x1) * .5;
    path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    path.setAttribute("stroke", ST.active.style.getPropertyValue("--c"));
    path.classList.add("on");
    _linkFrame = requestAnimationFrame(track);
  };
  track();
}
window.addEventListener("scroll", drawLink, { passive: true });

// ── 节点悬停气泡 ──
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
    label: (m === ST.month ? "✓ " : "") + m, act: () => loadMonth(m, true),
  })) });
}

// ── 设备选择（多选 + 全选）──
function openDevicePicker(ev) {
  if (!ST.devices.length) { showToast("暂无设备记录", { title: "设备" }); return; }
  const sel = ST.selectedDevices;  // null=全部
  const allOn = sel === null;
  const labelOf = (d) => d || "(未标注)";
  const items = [
    { label: (allOn ? "✓ " : "") + "全部设备", act: () => { ST.selectedDevices = null; saveSel(); reloadKeepMonth(); } },
    { sep: true },
    ...ST.devices.map((d) => ({
      label: (sel && sel.has(d) ? "✓ " : (allOn ? "✓ " : "")) + labelOf(d),
      act: () => {
        // 从全部状态开始第一次单选：建立 Set
        if (ST.selectedDevices === null) ST.selectedDevices = new Set(ST.devices);
        if (ST.selectedDevices.has(d)) ST.selectedDevices.delete(d);
        else ST.selectedDevices.add(d);
        if (!ST.selectedDevices.size) ST.selectedDevices.add(d); // 不能全空
        if (ST.selectedDevices.size === ST.devices.length) ST.selectedDevices = null; // 全选归一为 null
        saveSel(); reloadKeepMonth();
      },
    })),
  ];
  openMenu(ev, { head: "设备筛选（多选）", items });
}
function reloadKeepMonth() { closeMenu(); loadMonth(ST.month, true); updateDeviceLabel(); }
function updateDeviceLabel() {
  const el = $("device-label");
  if (!el) return;
  const sel = ST.selectedDevices;
  el.textContent = (sel === null) ? "全部设备"
    : sel.size === 1 ? ([...sel][0] || "(未标注)")
    : `${sel.size} 台设备`;
}

// ── 初始化 ──
async function initViewer() {
  if (typeof renderHeader === "function") renderHeader("viewer");
  $("month-pick").onclick = openMonthPicker;
  const devPick = $("device-pick");
  if (devPick) devPick.onclick = openDevicePicker;
  const left = $("left");
  if (left) left.addEventListener("scroll", () => { drawLink(); cancelTip(); }, { passive: true });
  window.addEventListener("resize", drawLink);
  bindGlobalMenu();
  initDebugTag("front/viewer");
  try {
    const [mr, dr] = await Promise.all([API.months(), API.devices()]);
    ST.month = (mr.months || [])[0] || null;
    ST.devices = dr.devices || [];
  } catch (_) { ST.month = null; }
  // 恢复设备筛选
  const savedSel = ST.month ? loadSel()[ST.month] : null;
  if (savedSel && Array.isArray(savedSel.devices)) {
    ST.selectedDevices = new Set(savedSel.devices.filter((d) => ST.devices.includes(d)));
    if (!ST.selectedDevices.size || ST.selectedDevices.size === ST.devices.length) ST.selectedDevices = null;
  }
  updateDeviceLabel();
  if (!ST.month) { renderEmpty(); return; }
  await loadMonth(ST.month, true);
}
window.addEventListener("DOMContentLoaded", initViewer);
