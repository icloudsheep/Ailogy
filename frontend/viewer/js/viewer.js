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
    _lastSig = _entriesSig(r.items);   // 记录基线指纹，供静默轮询比对
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
    }
    closeDetail();  // 刷新即重置所有节点状态：清除高亮/详情/连接线，避免节点仍呈打开态而详情已关
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

// ── 静默轮询自动更新 ──
// 后端数据发生增删改查时，前端无需刷新页面：定时拉取当月时间线，若与当前不同则就地
// 更新 ST.entries 并重渲染（renderStage 是 DOM 复用式，增删改移都通过 CSS 动画自然过渡）。
// 保留当前选择器状态、已展开详情与滚动位置，不打断用户。
let _pollTimer = 0, _lastSig = "";
function _entriesSig(items) {
  // 轻量指纹：任一条的增/删/改（标题、正文长度、颜色、mode、天、会话）都会使其变化
  return (items || []).map((e) =>
    `${e.id}:${e.seq}:${e.day}:${e.session_code}:${e.title}:${(e.summary||"").length}:${e.color||""}:${e.mode||""}`
  ).join("|");
}
async function pollUpdate() {
  if (document.hidden) return;
  try {
    // 当前无月份（库为空或首条尚未出现）：探测月份，出现数据则载入最新月
    if (!ST.month) {
      const mr = await API.months();
      const m = (mr.months || [])[0];
      if (!m) return;
      ST.month = m;
      try { const dr = await API.devices(); ST.devices = dr.devices || []; updateDeviceLabel(); } catch (_) {}
      await loadMonth(ST.month, true);
      return;
    }
    const devs = ST.selectedDevices ? [...ST.selectedDevices] : null;
    const r = await API.timeline(ST.month, devs);
    const sig = _entriesSig(r.items);
    if (sig === _lastSig) return;               // 无变化：不动
    _lastSig = sig;
    ST.entries = r.items;
    buildModel();
    const validDays = new Set(ST.days.map((d) => d.day));
    if (ST.selectedDays) {
      ST.selectedDays = new Set([...ST.selectedDays].filter((d) => validDays.has(d)));
      if (!ST.selectedDays.size) ST.selectedDays = new Set(ST.days.map((d) => d.day));
    } else ST.selectedDays = new Set(ST.days.map((d) => d.day));
    if (!ST.hiddenSessions) ST.hiddenSessions = new Set();
    _lastCapsHash = "";                          // 天/会话可能变化，强制胶囊重绘
    render();                                    // 复用式渲染：变化走 CSS 动画
    // 展开中的详情：条目仍在则用最新数据刷新，否则关闭
    if (ST.active && ST.active.dataset) {
      const cur = ST.entries.find((e) => String(e.id) === ST.active.dataset.id);
      const node = document.querySelector(`#stage .node[data-id="${attrEsc(ST.active.dataset.id)}"]`);
      if (cur && node) selectNodeDetail(cur, node); else closeDetail();
    }
    if (typeof refreshScrollbars === "function") refreshScrollbars();
  } catch (_) { /* 网络抖动忽略，下次再试 */ }
}
function startPolling(ms) {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(pollUpdate, ms || 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollUpdate(); });
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
    { label: icon("edit") + " 重命名会话", act: async () => {
      const v = await promptModal({ title: "自定义会话名称", desc: `会话 <b>${esc(code)}</b> · 留空恢复原名`,
                                    value: aliasOf(code) || "", placeholder: "易记名称" });
      if (v === null) return;                        // 取消
      const next = v.trim();
      if (next === (aliasOf(code) || "")) return;    // 无变动：不保存、不重渲、不提示
      saveAlias(code, next); render();
      showToast(next ? `已重命名为「${next}」` : "已恢复原名", { title: "会话" });
    } },
    { label: icon("palette") + " 改主题色", act: () => pickColor(code) },
  ];
  if (_serverColors[code] || loadColors()[code]) items.push({ label: icon("refresh") + " 恢复默认色",
    act: () => applyColor(code, "") });
  if (!grey) {
    const visible = !ST.hiddenSessions.has(code);
    items.unshift({ label: (visible ? icon("eyeOff") + " 隐藏" : icon("eye") + " 显示"), act: () => toggleSession(code) });
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
      { label: icon("preview") + " 预览", act: () => openPreview(e) },
      { label: icon("edit") + " 编辑", act: () => openEditModal(e) },
      { label: icon("trash") + " 删除", act: () => openDeleteModal(e) },
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
    <div class="modal-title">${icon("edit")} 编辑日志</div>
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
// 当前色若命中调色盘 → 在对应色块上打对号（iconfont check）；
// 若为自定义色（不在盘内且非默认）→ 对号打在「自定义」块上、且自定义块显示该色；
// 否则「自定义」块显示彩虹渐变色轮（提示可自定义）。
function pickColor(code) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  // 当前生效色：服务端固化 > 本地缓存 >（空=默认，走自动分配色但不算“自定义”）
  const curColor = (_serverColors[code] || loadColors()[code] || "").toLowerCase();
  const isCustom = curColor && !PALETTE.some((c) => c.toLowerCase() === curColor);
  const swatches = PALETTE.map((c) => {
    const on = c.toLowerCase() === curColor;
    return `<button class="sw${on ? " on" : ""}" data-c="${c}" style="background:${c}">${on ? icon("check") : ""}</button>`;
  }).join("");
  overlay.innerHTML = `<div class="modal" role="dialog">
      <div class="modal-title">会话主题色</div>
      <div class="modal-desc">会话 <b>${esc(code)}</b> · 选预设或自定义</div>
      <div class="sw-grid">${swatches}</div>
      <div class="sw-custom">
        <label class="sw-cus-box${isCustom ? " on" : ""}"${isCustom ? ` style="--cus:${curColor}"` : ""}>
          <input type="color" class="sw-input" value="${toHex(isCustom ? curColor : colorOf(code))}">
          ${isCustom ? icon("check") : ""}
        </label>
        <span>自定义颜色</span>
      </div>
      <div class="modal-actions"><button class="modal-btn ok">完成</button></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("on"));
  const cusBox = overlay.querySelector(".sw-cus-box");
  // 把「选中态 + 对号 + 弹入动画」落到某个目标上（预设色块或自定义块），其余清除。
  const markSelected = (el, custom) => {
    overlay.querySelectorAll(".sw.on, .sw-cus-box.on").forEach((x) => {
      if (x === el) return;
      x.classList.remove("on");
      const ic = x.querySelector(".icon"); if (ic) ic.remove();
    });
    if (!el) return;
    if (!el.querySelector(".icon")) el.insertAdjacentHTML("beforeend", icon("check"));
    el.classList.add("on");
    const ic = el.querySelector(".icon");
    if (ic) { ic.classList.remove("pick-pop"); void ic.offsetWidth; ic.classList.add("pick-pop"); }
  };
  overlay.querySelectorAll(".sw").forEach((b) => b.onclick = () => {
    markSelected(b, false);
    applyColor(code, b.dataset.c);
  });
  overlay.querySelector(".sw-input").addEventListener("input", (ev2) => {
    const v = ev2.target.value;
    cusBox.style.setProperty("--cus", v);
    markSelected(cusBox, true);
    applyColor(code, v);
  });
  const close = () => { overlay.classList.remove("on"); setTimeout(() => overlay.remove(), 240); };
  overlay.querySelector(".ok").onclick = close;
  overlay.addEventListener("mousedown", (ev2) => { if (ev2.target === overlay) close(); });
}

// 应用颜色：固化服务端 + 更新内存 + 原地重渲，不重载
async function applyColor(code, color) {
  const cur = _serverColors[code] || loadColors()[code] || "";
  const next = color || "";
  if (next === cur) return;  // 无变动：不写服务端、不重渲、不提示
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

// ── 泳道 stage（DOM 复用式渲染：不整块重建，只更新既有元素的位置/尺寸，
//    让 CSS transition 承担「泳道增减、节点重排、时间标识变形、内容宽度变化」的动画）──
const ns = "http://www.w3.org/2000/svg";
const NODE_HALF = 17, RIGHT_PAD = 8;
const SOLO_GAP = 24;                 // 单泳道时给紧凑徽标上下额外留白（原 30 的 80%）
const SOLO_BAND_W = 46, SOLO_BAND_H = 46, MULTI_BAND_H = 32;
const LEAVE_MS = 380;

// 平滑移除：先加 .leaving 播离场动画，再删节点
function leaveAndRemove(el) {
  if (!el || el.dataset.leaving) return;
  el.dataset.leaving = "1";
  el.classList.add("leaving");
  setTimeout(() => el.remove(), LEAVE_MS);
}

function renderStage() {
  const stage = $("stage");
  const visSessions = ST.sessions.filter((s) => isSessVisible(s.code));
  const solo = visSessions.length === 1;  // 单泳道：列宽极窄，日期标识改用竖排紧凑徽标
  const laneOf = {}; visSessions.forEach((s, i) => laneOf[s.code] = i);
  const vis = ST.entries.filter((e) => entrySelected(e))
                        .sort((a, b) => a.datetime < b.datetime ? -1 : 1);
  if (!vis.length) { stage.innerHTML = '<div class="empty">本月暂无可见日志</div>'; clearDetailIfGone(); return; }
  // 从空态切回来时清掉占位
  const emptyBox = stage.querySelector(":scope > .empty");
  if (emptyBox) emptyBox.remove();

  const n = Math.max(visSessions.length, 1);
  const W = COL_X0 + (n - 1) * COL_W + NODE_HALF + RIGHT_PAD;

  // 布局：用像素游标直接算各节点/时间标识的 y；单泳道时在标识上下加留白。
  // 连续 full 节点（同泳道、vis 顺序相邻）之间用更小的行距，让它们在火箭机身内更贴近。
  const GAP = solo ? SOLO_GAP : 0;
  const ROCKET_ROW_H = Math.round(ROW_H * 0.72);   // 火箭内相邻节点行距（更紧凑，但节点为常规尺寸不重叠）
  const AFTER_RUN_H = ROW_H + 44;                  // 离开火箭段后与下一节点的行距（避让加长的鞘尾）
  const inRun = (a, b) => a && b && a.mode === "full" && b.mode === "full"
    && a.session_code === b.session_code && a.day === b.day;
  const nodeY = [], dayMarks = [];
  let y = TOP_PAD, lastDay = null;
  vis.forEach((e, i) => {
    if (e.day !== lastDay) {
      // 新的一天：先留出日期标识行，再放当天首个节点
      if (i > 0) y += GAP + ROW_H;
      dayMarks.push({ day: e.day, top: y });
      y += ROW_H + GAP;
      lastDay = e.day;
    } else {
      const prev = vis[i - 1];
      // 同一天内：段内相邻 full 更紧凑；上一节点是同泳道火箭段末尾、本节点不在该段内时，
      // 额外拉开距离，给加长的鞘尾（含火箭图标）留出空间。
      const leftRun = prev && prev.mode === "full" && prev.session_code === e.session_code
        && prev.day === e.day && e.mode !== "full";
      y += inRun(prev, e) ? ROCKET_ROW_H : (leftRun ? AFTER_RUN_H : ROW_H);
    }
    nodeY.push(y);
  });
  const H = y + ROW_H + 30;
  stage.style.width = W + "px"; stage.style.height = H + "px";

  // ── 1) 泳道竖线（svg.rails）──
  //  a) 细长延伸线：每条可见泳道一条，贯穿整列（淡）。
  //  b) 加粗实色段：以「天」为单位，每条泳道在该天内 首个节点→末个节点 之间画一段粗线（浓）。
  let svg = stage.querySelector(":scope > svg.rails");
  if (!svg) { svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "rails"); stage.appendChild(svg); }
  const seenRail = new Set();
  visSessions.forEach((s) => {
    const x = COL_X0 + laneOf[s.code] * COL_W;
    let ln = svg.querySelector(`line.rail-ext[data-code="${attrEsc(s.code)}"]`);
    const fresh = !ln;
    if (fresh) {
      ln = document.createElementNS(ns, "line");
      ln.setAttribute("data-code", s.code);
      ln.setAttribute("class", "rail-ext");
      ln.setAttribute("x1", 0); ln.setAttribute("x2", 0); ln.setAttribute("y1", 0);
      ln.style.opacity = "0";
      svg.appendChild(ln);
    }
    ln.dataset.leaving = "";
    ln.classList.remove("leaving");
    ln.setAttribute("y2", H);
    ln.setAttribute("stroke", s.color);
    ln.style.transform = `translateX(${x}px)`;
    if (fresh) requestAnimationFrame(() => ln.style.opacity = "");
    seenRail.add(s.code);
  });
  svg.querySelectorAll("line.rail-ext[data-code]").forEach((ln) => {
    if (!seenRail.has(ln.dataset.code)) { ln.style.opacity = "0"; leaveAndRemove(ln); }
  });

  // 加粗实色段：按 (泳道, 天) 聚合首末节点 y
  const segMap = {};   // key: code\x00day -> {code, day, minY, maxY}
  vis.forEach((e, i) => {
    const k = e.session_code + "\x00" + e.day;
    const yy = nodeY[i];
    const g = segMap[k] || (segMap[k] = { code: e.session_code, day: e.day, minY: yy, maxY: yy });
    if (yy < g.minY) g.minY = yy;
    if (yy > g.maxY) g.maxY = yy;
  });
  const seenSeg = new Set();
  Object.entries(segMap).forEach(([k, g]) => {
    if (g.maxY <= g.minY) return;   // 该天该泳道只有单个节点，无需连线段
    const s = ST.sessions.find((x) => x.code === g.code);
    const x = COL_X0 + laneOf[g.code] * COL_W;
    let seg = svg.querySelector(`line.rail-seg[data-seg="${attrEsc(k)}"]`);
    const fresh = !seg;
    if (fresh) {
      seg = document.createElementNS(ns, "line");
      seg.setAttribute("data-seg", k);
      seg.setAttribute("class", "rail-seg");
      seg.setAttribute("x1", 0); seg.setAttribute("x2", 0);
      seg.style.opacity = "0";
      svg.appendChild(seg);
    }
    seg.dataset.leaving = "";
    seg.classList.remove("leaving");
    seg.setAttribute("y1", g.minY); seg.setAttribute("y2", g.maxY);
    seg.setAttribute("stroke", s ? s.color : "#8ea0c8");
    seg.style.transform = `translateX(${x}px)`;
    if (fresh) requestAnimationFrame(() => seg.style.opacity = "");
    seenSeg.add(k);
  });
  svg.querySelectorAll("line.rail-seg[data-seg]").forEach((seg) => {
    if (!seenSeg.has(seg.dataset.seg)) { seg.style.opacity = "0"; leaveAndRemove(seg); }
  });

  // ── 2) 日期标识：按 day 复用，solo/multi 切换时改 class + 内容，尺寸/位置走 transition ──
  const seenBand = new Set();
  dayMarks.forEach((m) => {
    const dd = ST.days.find((x) => x.day === m.day);
    let band = stage.querySelector(`:scope > .day-band[data-day="${attrEsc(m.day)}"]`);
    const fresh = !band;
    if (fresh) {
      band = document.createElement("div");
      band.dataset.day = m.day;
      band.classList.add("enter");
      stage.appendChild(band);
      requestAnimationFrame(() => band.classList.remove("enter"));
    }
    band.dataset.leaving = "";
    band.classList.remove("leaving");
    if (dd) band.style.setProperty("--day-c", dd.color);
    const wantSolo = solo ? "solo" : "multi";
    if (band.dataset.shape !== wantSolo) {
      band.dataset.shape = wantSolo;
      band.className = "day-band" + (solo ? " solo" : "") + (fresh ? " enter" : "");
      band.innerHTML = solo
        ? `<span class="day-band-pill"></span><span class="day-band-num">${esc(m.day.slice(8))}</span>`
        : `<span class="day-band-label">${esc(m.day.slice(5))}</span>`;
    } else if (!solo) {
      const lbl = band.querySelector(".day-band-label"); if (lbl) lbl.textContent = m.day.slice(5);
    }
    band.style.top = (m.top - 6) + "px";
    // 多泳道横带内缩 6px（左移 6、宽度 -12），给左右投影留出空间，避免被 .left 的 overflow-x 裁切
    if (solo) { band.style.left = "6px"; band.style.width = SOLO_BAND_W + "px"; }
    else { band.style.left = "6px"; band.style.width = (W - 12) + "px"; }
    band.style.height = (solo ? SOLO_BAND_H : MULTI_BAND_H) + "px";
    seenBand.add(m.day);
  });
  stage.querySelectorAll(":scope > .day-band[data-day]").forEach((band) => {
    if (!seenBand.has(band.dataset.day)) leaveAndRemove(band);
  });

  // ── 3) 节点：按 entry id 复用，left/top 变化走 transition；新增播 pop，移除播离场 ──
  const seenNode = new Set();
  vis.forEach((e, i) => {
    const s = ST.sessions.find((x) => x.code === e.session_code);
    const x = COL_X0 + laneOf[e.session_code] * COL_W, ny = nodeY[i];
    let node = stage.querySelector(`:scope > .node[data-id="${attrEsc(String(e.id))}"]`);
    const fresh = !node;
    if (fresh) {
      node = document.createElement("div");
      node.className = "node enter";
      node.dataset.id = e.id;
      node.style.animationDelay = (Math.min(i, 10) * 45) + "ms";
      const moon = e.carryover ? `<span class="moon">${icon("moon")}</span>` : "";
      // knob 内含 emoji 与一个默认隐藏的“已选中”图标（选中时放大盖在 emoji 上）
      node.innerHTML = `<div class="knob"><span class="knob-emo">${e.emoji || "📝"}</span><span class="knob-open">${icon("check")}</span>${moon}</div>`;
      node.onclick = () => selectNode(e, node);
      node.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); nodeMenu(ev, e, node); };
      node.addEventListener("mouseenter", () => scheduleTip(node));
      node.addEventListener("mouseleave", cancelTip);
      // pop 是关键帧动画，需播放完再摘 .enter（rAF 立即摘会中断动画）
      node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
      stage.appendChild(node);
    } else {
      node.dataset.leaving = "";
      node.classList.remove("leaving");
    }
    node.style.setProperty("--c", s.color);
    node.style.left = x + "px";
    node.style.top = ny + "px";
    node.dataset.tip = e.title || sessDisplay(e.session_code, s.name);
    seenNode.add(String(e.id));
  });
  stage.querySelectorAll(":scope > .node[data-id]").forEach((node) => {
    if (!seenNode.has(node.dataset.id)) {
      if (node === ST.active) { ST.active = null; closeDetail(); }
      leaveAndRemove(node);
    }
  });

  // ── 4) full 模式火箭背景：同一泳道内「连续相邻」的 full 节点合并为一条可拉伸的火箭轨道，
  //    置于节点之下作连续背景；头(顶,箭头)与尾(底,尾焰)样式区别于中段。单个 full 节点也画一条。
  //    先按泳道分组、组内保序，切分出相邻 full 段（段内相邻节点行号连续、无非 full 节点打断）。
  const byLane = {};
  vis.forEach((e, i) => {
    const code = e.session_code;
    (byLane[code] = byLane[code] || []).push({ e, i });
  });
  const runs = [];  // {id, x, firstY, lastY, count, ids:[]}
  Object.values(byLane).forEach((list) => {
    let run = null;
    const flush = () => { if (run) runs.push(run); run = null; };
    list.forEach(({ e, i }) => {
      if (e.mode === "full") {
        const yy = nodeY[i];
        if (run) { run.lastY = yy; run.count++; run.ids.push(e.id); }
        else run = { id: e.id, x: COL_X0 + laneOf[e.session_code] * COL_W, firstY: yy, lastY: yy, count: 1, ids: [e.id] };
      } else flush();
    });
    flush();
  });
  // full 段内的节点略微缩小并贴近（.in-rocket）——先清旧标记再按当前 runs 打标
  stage.querySelectorAll(":scope > .node.in-rocket").forEach((n) => n.classList.remove("in-rocket"));
  const rocketIds = new Set();
  runs.forEach((r) => r.ids.forEach((id) => rocketIds.add(String(id))));
  rocketIds.forEach((id) => {
    const n = stage.querySelector(`:scope > .node[data-id="${attrEsc(id)}"]`);
    if (n) n.classList.add("in-rocket");
  });
  const seenRun = new Set();
  const RK_HALF = 23;                 // 捆绑鞘半宽（加宽）
  const RK_HEAD = 24, RK_TAIL = 60;   // 首/末节点之外的上下延伸量（底部进一步加长，火箭图标居于末节点下方、不被遮挡）
  runs.forEach((r) => {
    let el = stage.querySelector(`:scope > .rocket-track[data-run="${attrEsc(String(r.id))}"]`);
    const fresh = !el;
    if (fresh) {
      el = document.createElement("div");
      el.className = "rocket-track enter";
      el.dataset.run = r.id;
      // 液态玻璃捆绑鞘：外发光晕 + 磨砂胶囊本体 + 贯穿的连接脊线 + 底部火箭图标
      el.innerHTML =
        `<span class="rk-glow"></span>`
        + `<span class="rk-spine"></span>`
        + `<span class="rk-ic">${icon("rocket")}</span>`;
      stage.appendChild(el);
      requestAnimationFrame(() => el.classList.remove("enter"));
    }
    el.dataset.leaving = "";
    el.classList.remove("leaving");
    const top = r.firstY - RK_HEAD, bottom = r.lastY + RK_TAIL;
    el.style.left = r.x + "px";
    el.style.top = top + "px";
    el.style.height = (bottom - top) + "px";
    el.style.width = (RK_HALF * 2) + "px";
    // 用该泳道主题色淡淡着色（符合本项目液态玻璃风）
    const ent = vis.find((v) => v.id === r.id);
    const col = ent ? (ST.sessions.find((x) => x.code === ent.session_code) || {}).color : null;
    if (col) el.style.setProperty("--c", col);
    seenRun.add(String(r.id));
  });
  stage.querySelectorAll(":scope > .rocket-track[data-run]").forEach((el) => {
    if (!seenRun.has(el.dataset.run)) leaveAndRemove(el);
  });

  clearDetailIfGone();
}

// 带引号属性选择器 [x="..."] 的值转义：只需转义 " 和 \。
// 不能用 utils 的 cssEsc(=CSS.escape)——它按无引号标识符转义，会把数字开头的 id/日期
// 变成 \35 … 形式，放进带引号属性值里反而匹配不上，导致每次都当新元素重建、动画失效。
function attrEsc(v) { return String(v).replace(/["\\]/g, "\\$&"); }

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
    + `<div class="box fresh"><div class="bt">${icon("note")} 日志内容</div><div class="d-sum md">${renderMd(ef.summary || "")}</div></div>`
    + `<div class="box fresh"><div class="bt">${icon("clock")} 时间</div><div class="metrics">${f("起", fmtAt(ef.start, ef.day))}${f("止", fmtAt(ef.end, ef.day))}${f("时长", fmtDur(ef.duration))}</div></div>`
    + (u ? `<div class="box fresh"><div class="bt">${icon("chart")} 本段消耗</div><div class="metrics">${f("输入", fmtTok(u.input))}${f("输出", fmtTok(u.output))}${f("缓存读", fmtTok(u.cache_read))}${f("轮数", u.turns)}${f("API", u.api_calls)}</div></div>` : "")
    + `<div class="box fresh"><div class="bt">${icon("branch")} ${icon("cpu")} ${icon("folder")} ${icon("laptop")}</div><div class="metrics">${f("分支", ef.branch)}${f("模型", ef.model)}${f("项目", ef.project)}${f("设备", ef.device)}</div></div>`;
  renderMermaid(wrap); renderMath(wrap);
  drawLink();
}

function closeDetail() {
  document.querySelectorAll("#stage .node.active").forEach((n) => n.classList.remove("active"));
  ST.active = null;
  $("detail").innerHTML = '<div class="box empty">' + icon("arrowLeft") + ' 点击左侧节点查看该条日志</div>';
}

// ── 选中指示 ──
// 已弃用节点↔详情的连接曲线（两侧独立滚动时易断裂、指向不明）。
// 改为给选中节点本身一个持续的“已在右侧打开”视觉态（见 .node.active，CSS 光环 + → 角标），
// 始终锚定在节点上、不受滚动影响。drawLink 保留为空函数以兼容既有调用点。
function drawLink() { /* no-op：连接线已移除，选中态由 .node.active 表达 */ }

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
    label: m, check: m === ST.month,
    act: () => { if (m === ST.month) { closeMenu(); return; } loadMonth(m, true); },
  })) });
}

// ── 设备选择（多选 + 全选）──
// 设备选择用 null 表示「全部」，或一个 Set 表示具体子集。比较两者是否等价：
function devSelEqual(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function openDevicePicker(ev) {
  if (!ST.devices.length) { showToast("暂无设备记录", { title: "设备" }); return; }
  const sel = ST.selectedDevices;  // null=全部
  const allOn = sel === null;
  const labelOf = (d) => d || "(未标注)";
  // 应用一个新的设备选择：与当前等价则纯关菜单、不刷新不记录；有变动才持久化并重载。
  const applyDevSel = (next) => {
    // 归一：空集不允许、全选归一为 null
    if (next instanceof Set) {
      if (!next.size) { showToast("至少保留一台设备", { type: "err" }); return; }  // 不允许全空
      if (next.size === ST.devices.length) next = null;
    }
    if (devSelEqual(next, ST.selectedDevices)) { closeMenu(); return; }
    ST.selectedDevices = next;
    saveSel(); reloadKeepMonth();
  };
  const items = [
    { label: "全部设备", check: allOn, act: () => applyDevSel(null) },
    { sep: true },
    ...ST.devices.map((d) => ({
      label: labelOf(d), check: (sel && sel.has(d)) || allOn,
      act: () => {
        // 从全部状态开始第一次单选：以全集为基建立 Set，再切换该项
        const next = new Set(ST.selectedDevices === null ? ST.devices : ST.selectedDevices);
        if (next.has(d)) next.delete(d); else next.add(d);
        applyDevSel(next);
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

// ── 自绘滚动条：轨道只落在 banner 之下的区域，thumb 永不藏进 banner ──
// 原生滚动条轨道从视口 y=0 起、被 fixed banner 盖住顶部一段，滚到顶时 thumb 会完全没入 banner。
// 这里给每个滚动容器配一个 fixed 定位的自绘滚动条：其顶端 = 当前 banner 高度，据容器
// scrollTop/scrollHeight 计算 thumb 位置与高度，并支持拖拽与悬停显隐。
function VScroll(pane) {
  const bar = document.createElement("div");
  bar.className = "vscroll";
  const thumb = document.createElement("div");
  thumb.className = "vscroll-thumb";
  bar.appendChild(thumb);
  document.body.appendChild(bar);

  let hideTimer = 0;
  const bannerH = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 150) + 6;

  function layout() {
    const r = pane.getBoundingClientRect();
    const top = bannerH();                                  // 轨道顶：banner 之下
    const trackH = Math.max(0, r.bottom - top - 6);         // 轨道高：到面板底、留 6px
    const sh = pane.scrollHeight, ch = pane.clientHeight;
    if (sh <= ch + 1 || trackH <= 0) { bar.classList.remove("show"); return; } // 无需滚动
    bar.style.top = top + "px";
    bar.style.height = trackH + "px";
    bar.style.left = (r.right - 9 - 2) + "px";              // 贴面板右缘内侧
    const th = Math.max(28, trackH * (ch / sh));            // thumb 高（最小 28）
    const maxScroll = sh - ch;
    const maxThumb = trackH - th;
    const y = maxScroll > 0 ? (pane.scrollTop / maxScroll) * maxThumb : 0;
    thumb.style.height = th + "px";
    thumb.style.top = y + "px";
    bar.classList.add("show");
  }
  function flash() { layout(); clearTimeout(hideTimer); }   // 交互时保持可见

  // 拖拽
  let dragging = false, startY = 0, startScroll = 0;
  thumb.addEventListener("mousedown", (e) => {
    dragging = true; startY = e.clientY; startScroll = pane.scrollTop;
    thumb.classList.add("drag"); e.preventDefault();
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const r = pane.getBoundingClientRect();
    const trackH = Math.max(0, r.bottom - bannerH() - 6);
    const th = parseFloat(thumb.style.height) || 28;
    const maxThumb = trackH - th, maxScroll = pane.scrollHeight - pane.clientHeight;
    if (maxThumb > 0) pane.scrollTop = startScroll + (e.clientY - startY) / maxThumb * maxScroll;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false; thumb.classList.remove("drag"); document.body.style.userSelect = "";
  });

  pane.addEventListener("scroll", flash, { passive: true });
  window.addEventListener("resize", layout);
  if (window.ResizeObserver) { const ro = new ResizeObserver(layout); ro.observe(pane); }
  layout();
  return { layout };
}
let _vscrolls = [];
function refreshScrollbars() { _vscrolls.forEach((v) => v.layout()); }

// ── 初始化 ──
async function initViewer() {
  if (typeof renderHeader === "function") renderHeader("viewer");
  $("month-pick").onclick = openMonthPicker;
  const devPick = $("device-pick");
  if (devPick) devPick.onclick = openDevicePicker;
  const left = $("left");
  if (left) left.addEventListener("scroll", () => { cancelTip(); }, { passive: true });
  const right = $("detail");
  // 自绘滚动条（泳道 + 日志），轨道只在 banner 之下
  _vscrolls = [left, right].filter(Boolean).map((p) => VScroll(p));
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
  if (!ST.month) { renderEmpty(); startPolling(5000); return; }
  await loadMonth(ST.month, true);
  startPolling(5000);   // 启动静默轮询：后端增删改查后自动就地动画更新，无需刷新
}
window.addEventListener("DOMContentLoaded", initViewer);
