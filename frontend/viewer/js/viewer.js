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
  mode: "recent",         // "recent"(最近30天，默认) | "month"
  month: null,
  recentDays: 30,
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

// ── 选择器状态固化（localStorage，按“视图键”）──
// 视图键：recent 模式用 "recent"，month 模式用月份串。这样最近30天与各月各自独立记忆。
const SEL_KEY = "ailogy:selection";
const VIEW_KEY = "ailogy:view";        // 记住上次的视图（mode + month），跨刷新恢复
function viewKey() { return ST.mode === "recent" ? "recent" : ST.month; }
function loadSel() { try { return JSON.parse(localStorage.getItem(SEL_KEY) || "{}") || {}; } catch (_) { return {}; } }
function saveSel() {
  const all = loadSel();
  all[viewKey()] = {
    days: [...(ST.selectedDays || [])],
    hidden: [...(ST.hiddenSessions || [])],
    devices: ST.selectedDevices ? [...ST.selectedDevices] : null,
  };
  try { localStorage.setItem(SEL_KEY, JSON.stringify(all)); } catch (_) {}
  // 同时固化“上次视图”，刷新后回到同一模式/月份
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ mode: ST.mode, month: ST.month })); } catch (_) {}
  // 同步写入 URL 查询参数：刷新（含带地址栏跳转）后能原样恢复，且不落库。
  syncUrl();
}
function loadSavedView() { try { return JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); } catch (_) { return null; } }

// ── URL 查询参数固化（不落库，刷新可复原）──
// 形如 ?view=recent 或 ?view=2026-07&dev=A,B。天/会话隐藏集合也随选择变化写入，
// 供直接复制地址栏分享/刷新恢复；解析在 initViewer 早期完成，优先级高于 localStorage。
function syncUrl() {
  try {
    const p = new URLSearchParams();
    p.set("view", ST.mode === "recent" ? "recent" : (ST.month || "recent"));
    if (ST.selectedDevices && ST.selectedDevices.size) p.set("dev", [...ST.selectedDevices].join(","));
    if (ST.hiddenSessions && ST.hiddenSessions.size) p.set("hide", [...ST.hiddenSessions].join(","));
    if (ST.selectedDays && ST.days.length && ST.selectedDays.size < ST.days.length) {
      p.set("days", [...ST.selectedDays].join(","));
    }
    const qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  } catch (_) {}
}
function readUrl() {
  try {
    const p = new URLSearchParams(location.search);
    if (!p.has("view")) return null;
    const view = p.get("view");
    const split = (k) => { const v = p.get(k); return v ? v.split(",").filter(Boolean) : null; };
    return {
      mode: view === "recent" ? "recent" : "month",
      month: view === "recent" ? null : view,
      devices: split("dev"),
      hidden: split("hide"),
      days: split("days"),
    };
  } catch (_) { return null; }
}
let _urlState = null;   // 首载时从 URL 解析出的状态，供 loadView 恢复选择器

// ── 拉取数据并构建（统一处理 recent / month 两种模式）──
// opts: { recent: N }（最近 N 天）或 { month: "YYYY-MM" }；不传则沿用当前 ST.mode/ST.month。
async function loadView(opts, keepSel) {
  // 先根据 opts 落定模式（在拉取前更新 ST.mode/month，使 viewKey 正确）
  if (opts && opts.recent) { ST.mode = "recent"; ST.recentDays = opts.recent; }
  else if (opts && opts.month) { ST.mode = "month"; ST.month = opts.month; }
  try {
    const devs = ST.selectedDevices ? [...ST.selectedDevices] : null;
    const q = ST.mode === "recent" ? { recent: ST.recentDays } : { month: ST.month };
    const r = await API.timeline(q, devs);
    if (r.mode === "month" && r.month) ST.month = r.month;
    ST.entries = r.items;
    _lastSig = _entriesSig(r.items);   // 记录基线指纹，供静默轮询比对
    buildModel();
    // 恢复固化的选择器状态：URL 参数优先（刷新/分享复原），其次 localStorage。
    const urlSel = (_urlState && _urlState.mode === ST.mode
      && (ST.mode === "recent" || _urlState.month === ST.month)) ? _urlState : null;
    const saved = urlSel || loadSel()[viewKey()];
    if (keepSel && saved) {
      const validDays = new Set(ST.days.map((d) => d.day));
      ST.selectedDays = new Set((saved.days || []).filter((d) => validDays.has(d)));
      if (!ST.selectedDays.size) ST.selectedDays = new Set(ST.days.map((d) => d.day));
      ST.hiddenSessions = new Set(saved.hidden || []);
    } else {
      ST.selectedDays = new Set(ST.days.map((d) => d.day));
      ST.hiddenSessions = new Set();
    }
    _urlState = null;   // URL 状态只在首载消费一次，之后以内存状态为准
    if (ST.sessions.length) $("feed").innerHTML = "";
    updateViewLabel();
    saveSel();          // 记住当前视图（mode/month）+ 选择器状态
    closeDetail();      // 重置节点状态
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
// 兼容旧调用：loadMonth(month, keepSel) → 切到 month 模式
async function loadMonth(month, keepSel) { return loadView({ month }, keepSel); }
// 顶部月份/模式按钮文案
function updateViewLabel() {
  const el = $("month-label");
  if (el) el.textContent = ST.mode === "recent" ? "最近30天" : (ST.month || "");
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
    // 库为空/首条未现：探测数据出现则以默认（最近30天）载入
    if (!ST.entries.length && !ST.month && ST.mode === "recent" && !_bootstrapped) {
      // 交由 initViewer 首载；此分支只在极端空态兜底
    }
    // 轮询始终拉「最近30天 + 全部设备」的全量，用于：① 刷新当前视图 ② 侦测视图外的新更新
    const full = await API.timeline({ recent: Math.max(ST.recentDays, 30) }, null);
    const allItems = full.items || [];
    // 探测设备变化（新设备上报）
    detectDeviceChanges(allItems);
    // 当前视图应显示的子集
    const inView = allItems.filter(isInCurrentView);
    const sig = _entriesSig(inView);
    if (sig !== _lastSig) {
      _lastSig = sig;
      ST.entries = inView;
      buildModel();
      const validDays = new Set(ST.days.map((d) => d.day));
      if (ST.selectedDays) {
        ST.selectedDays = new Set([...ST.selectedDays].filter((d) => validDays.has(d)));
        if (!ST.selectedDays.size) ST.selectedDays = new Set(ST.days.map((d) => d.day));
      } else ST.selectedDays = new Set(ST.days.map((d) => d.day));
      if (!ST.hiddenSessions) ST.hiddenSessions = new Set();
      _lastCapsHash = "";
      render();
      if (ST.active && ST.active.dataset) {
        const cur = ST.entries.find((e) => String(e.id) === ST.active.dataset.id);
        const node = document.querySelector(`#stage .node[data-id="${attrEsc(ST.active.dataset.id)}"]`);
        if (cur && node) selectNodeDetail(cur, node); else closeDetail();
      }
      if (typeof refreshScrollbars === "function") refreshScrollbars();
    }
    // 侦测「视图外」的新条目 → 提示 banner
    detectOutOfViewUpdates(allItems);
  } catch (_) { /* 网络抖动忽略，下次再试 */ }
}
// 某条目是否落在当前视图（模式/月份 + 已选设备）内。
// 仅判范围/设备，不含天/会话的显隐——用于轮询构建模型（隐藏的会话仍要作为胶囊载入）。
function isInCurrentView(e) {
  // 设备过滤
  if (ST.selectedDevices && !ST.selectedDevices.has(e.device || "")) return false;
  // 范围过滤
  if (ST.mode === "month") return (e.day || "").slice(0, 7) === ST.month;
  return true;  // recent 模式：全量已是最近30天
}
// 某条目是否「真正对用户可见」：在范围/设备内，且其天已选、其会话未被隐藏。
// 供更新提示 banner 判定——用户隐藏了会话/取消了某天时，新条目虽在该月/设备内也应提示。
function isVisibleToUser(e) {
  if (!isInCurrentView(e)) return false;
  if (ST.selectedDays && !ST.selectedDays.has(e.day)) return false;
  if (ST.hiddenSessions && ST.hiddenSessions.has(e.session_code)) return false;
  return true;
}
function startPolling(ms) {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(pollUpdate, ms || 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollUpdate(); });
}
let _bootstrapped = false;

// ── 视图外更新提示 banner ──
// 轮询发现「当前未选设备 / 当前范围之外」出现新条目时，在顶栏下方弹出浅绿提示条：
// 一行概要（省略号截断）+ 查看 / 忽略。查看 = 跳转到该条（同搜索结果点击）。
let _knownIds = null;              // 已知条目 id 全集（首轮建立基线，不提示历史）
let _pendingNotice = null;         // 当前待提示的新条目（取最新一条作代表）
let _dismissedIds = new Set();     // 用户点“忽略”过的 id，不再提示
function detectDeviceChanges(allItems) {
  const devs = [...new Set(allItems.map((e) => e.device || ""))];
  // 合并进 ST.devices（保持已有 + 新增），供设备选择器展示
  let changed = false;
  devs.forEach((d) => { if (!ST.devices.includes(d)) { ST.devices.push(d); changed = true; } });
  if (changed) updateDeviceLabel();
}
function detectOutOfViewUpdates(allItems) {
  if (_knownIds === null) {          // 首轮：建立基线，不把已有数据当“新更新”
    _knownIds = new Set(allItems.map((e) => String(e.id)));
    return;
  }
  // 新出现（id 未见过）且当前对用户不可见（范围/设备外，或所在天未选、会话被隐藏）、未被忽略的条目
  const fresh = allItems.filter((e) => {
    const id = String(e.id);
    return !_knownIds.has(id) && !isVisibleToUser(e) && !_dismissedIds.has(id);
  });
  // 更新已知集合（把所有当前 id 记入，避免下轮重复提示）
  allItems.forEach((e) => _knownIds.add(String(e.id)));
  if (!fresh.length) return;
  // 取最新一条作代表（按 datetime）
  fresh.sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
  showUpdateNotice(fresh, fresh[0]);
}
function showUpdateNotice(freshList, rep) {
  _pendingNotice = rep;
  const bar = $("update-notice");
  if (!bar) return;
  const dev = rep.device || "未标注设备";
  const where = ST.mode === "month" ? "其它范围" : (ST.selectedDevices ? "未选设备" : "其它范围");
  const extra = freshList.length > 1 ? ` 等 ${freshList.length} 条` : "";
  const title = rep.title || sessDisplay(rep.session_code, rep.name) || "新日志";
  $("update-notice-text").textContent = `${dev} · ${title}${extra}`;
  bar.classList.add("show");
  // 提示条占位高度写入 --notice-h：toast 容器 top 据此下移避让（带过渡）
  document.documentElement.style.setProperty("--notice-h", "56px");
}
function hideUpdateNotice() {
  const bar = $("update-notice");
  if (bar) bar.classList.remove("show");
  document.documentElement.style.setProperty("--notice-h", "0px");
  _pendingNotice = null;
}
function viewUpdateNotice() {
  const e = _pendingNotice;
  hideUpdateNotice();
  if (!e) return;
  // 若该条属于某设备而当前把它过滤掉了，先把设备并入可见集合
  if (ST.selectedDevices && !ST.selectedDevices.has(e.device || "")) {
    ST.selectedDevices.add(e.device || "");
    if (ST.selectedDevices.size >= ST.devices.length) ST.selectedDevices = null;
    updateDeviceLabel(); saveSel();
  }
  focusEntry(e);   // 与搜索结果点击一致：切范围/天/会话 + 定位 + 展开
}
function dismissUpdateNotice() {
  if (_pendingNotice) _dismissedIds.add(String(_pendingNotice.id));
  hideUpdateNotice();
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
  updateViewLabel();
  if (!hasSessions) { renderEmpty(); return; }
  const capHash = _capsHash();
  if (capHash !== _lastCapsHash) { _lastCapsHash = capHash; renderCapsules(); }
  renderStage();
}

function _capsHash() {
  // 含别名：重命名后 hash 变化才会触发 renderCapsules 热更新（无需刷新页面）。
  // 折叠态/自动隐藏灰态不入 hash——它们只切换 .cap-hidden 类走 CSS 动画，不重建 DOM（重建会打断动画）。
  return ST.sessions.map((s) => `${s.code}:${aliasOf(s.code)||""}:${s.color}:${sessAppearsInVisibleDays(s.code)?1:0}:${ST.hiddenSessions.has(s.code)?1:0}`).join("|")
    + "|" + ST.days.map((d) => `${d.day}:${isDaySelected(d.day)?1:0}`).join("|");
}

function renderEmpty() {
  $("stage").innerHTML = "";
  $("detail").innerHTML = "";
  $("feed").innerHTML = '<div class="empty-center"><div class="empty-main">无任何内容</div></div>';
}

// 会话选择器折叠：会话多时占大片空间，折叠后只留「显示中」的会话胶囊。
// 纯 UI 视图态、不落库（不影响任何会话的显隐/选择），刷新回到展开态。
// 动画用 FLIP（First-Last-Invert-Play）：布局塌缩瞬时完成，位移改由 transform 补间——
// CSS 过渡无法动画 flex 换行（3 行↔2 行），只有 FLIP 能让胶囊跨行平滑滑动、消除闪烁。
let _sessCollapsed = false;
// 「自动隐藏灰态会话」偏好（设置页开关，localStorage 固化）：灰态=当前无可显示天的会话。
const HIDE_GREY_KEY = "ailogy:hideGrey";
function autoHideGrey() { try { return localStorage.getItem(HIDE_GREY_KEY) === "1"; } catch (_) { return false; } }
// 某会话胶囊是否应被折叠隐藏：折叠态下藏所有「非显示中」；或开了自动隐藏灰态时藏灰态。
function sessCapFolded(code) {
  const grey = !sessAppearsInVisibleDays(code);
  if (autoHideGrey() && grey) return true;
  if (_sessCollapsed && !isSessVisible(code)) return true;
  return false;
}
function toggleSessCollapse() { _sessCollapsed = !_sessCollapsed; refreshCapFold(); }

// ── FLIP 动画助手（按 data-code / __btn__ 键匹配新旧元素）──
const CAP_EASE = "cubic-bezier(.22,1,.36,1)";   // 自适应非线性补间：快出慢入，末端平滑收敛
const CAP_FLIP_BASE = 0.42;                     // FLIP 位移基准时长（秒，极速档）；实际 ×--anim-k
// 读取全站动画速率系数（设置页三档：优雅/默认/极速），使 JS 动画与 CSS 同步伸缩
function animK() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--anim-k"));
  return Number.isFinite(v) && v > 0 ? v : 1;
}
// 参与 FLIP 的左侧「天/会话」标签：会话行换行使其高度变化时，标签会整体上下移动，
// 纳入 FLIP 才能让它们随之平滑滑动（此前是瞬跳，见 issue #6「其他问题」）。
function capTagEls() {
  return [...document.querySelectorAll("#header-row2 .cap-tag")];
}
// First：记录当前各胶囊/按钮/标签的视口坐标（在 DOM 变更之前调用）
function captureCapRects() {
  const row = $("cap-sessions"), btn = $("sess-collapse");
  const m = new Map();
  if (row) row.querySelectorAll(".sess-cap").forEach((el) => m.set(el.dataset.code, el.getBoundingClientRect()));
  if (btn && !btn.classList.contains("cap-toggle-off")) m.set("__btn__", btn.getBoundingClientRect());
  capTagEls().forEach((el, i) => m.set("__tag" + i + "__", el.getBoundingClientRect()));
  return m;
}
// Last+Invert+Play：变更后按旧坐标反相，再用 transform 过渡回位（不触发重排、跨行也平滑）
function flipFromRects(firstMap) {
  const row = $("cap-sessions"), btn = $("sess-collapse");
  if (!row || !firstMap) return;
  const pairs = [];
  row.querySelectorAll(".sess-cap").forEach((el) => {
    const f = firstMap.get(el.dataset.code); if (f) pairs.push([el, f]);
  });
  if (btn && firstMap.get("__btn__")) pairs.push([btn, firstMap.get("__btn__")]);
  capTagEls().forEach((el, i) => { const f = firstMap.get("__tag" + i + "__"); if (f) pairs.push([el, f]); });
  const active = [];
  pairs.forEach(([el, f]) => {
    // 正在收起的胶囊/按钮：不做位移补间，仅靠 opacity 原地淡出（避免飞向塌缩点）
    if (el.classList.contains("cap-hidden") || el.classList.contains("cap-toggle-off")) return;
    const l = el.getBoundingClientRect();
    const dx = f.left - l.left, dy = f.top - l.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    active.push(el);
  });
  if (!active.length) return;
  const dur = CAP_FLIP_BASE * animK();   // 随速率档伸缩
  void document.body.offsetWidth;   // 强制重排，使反相位生效
  requestAnimationFrame(() => {
    active.forEach((el) => {
      el.style.transition = `transform ${dur}s ${CAP_EASE}`;
      el.style.transform = "";
    });
    setTimeout(() => active.forEach((el) => { el.style.transition = ""; el.style.transform = ""; }), dur * 1000 + 60);
  });
}
// 折叠按钮显隐 + 文案：仅当存在「显示中却被手动隐藏（off 态）」的非灰态会话时才出现。
// 灰态会话不计入——它们由设置页「自动隐藏灰态」管理。全非灰态均显示时按钮渐隐消失。
function refreshCapButton() {
  const btn = $("sess-collapse");
  if (!btn) return;
  const off = ST.sessions.filter((s) => sessAppearsInVisibleDays(s.code) && ST.hiddenSessions.has(s.code)).length;
  if (!off) { _sessCollapsed = false; btn.classList.add("cap-toggle-off"); return; }
  btn.innerHTML = _sessCollapsed
    ? `${icon("eye")}<span>展开全部（${ST.sessions.length}）</span>`
    : `${icon("eyeOff")}<span>只看显示中</span>`;
  btn.title = _sessCollapsed ? "展开全部会话胶囊" : `折叠隐藏 ${off} 个已隐藏的会话`;
  btn.onclick = toggleSessCollapse;
  btn.classList.remove("cap-toggle-off");
}
// 给每个会话胶囊切 .cap-hidden（布局塌缩），button 状态同步刷新
function applyCapFoldClasses() {
  const row = $("cap-sessions");
  if (row) row.querySelectorAll(".sess-cap").forEach((el) =>
    el.classList.toggle("cap-hidden", sessCapFolded(el.dataset.code)));
}
// 折叠态/自动隐藏态变化时：先记坐标，改类，再 FLIP 播位移动画（不重建 DOM）
function refreshCapFold() {
  const first = captureCapRects();
  refreshCapButton();
  applyCapFoldClasses();
  flipFromRects(first);
}

function renderCapsules() {
  const sessRow = $("cap-sessions");
  const btn = $("sess-collapse");        // 折叠按钮在 #cap-sessions 内、位于胶囊之后——重建胶囊时勿删它
  const first = captureCapRects();   // 重建前记录旧坐标，供 FLIP 平滑过渡（改名/显隐等）
  // 只清除旧胶囊、保留折叠按钮；折叠/自动隐藏只通过 .cap-hidden 类切换，让 FLIP 播动画。
  sessRow.querySelectorAll(".sess-cap").forEach((el) => el.remove());
  const capsHTML = ST.sessions.map((s) => {
    const appears = sessAppearsInVisibleDays(s.code);
    const grey = !appears;
    const on = appears && !ST.hiddenSessions.has(s.code);
    const cls = grey ? "grey" : (on ? "on" : "off");
    const fold = sessCapFolded(s.code) ? " cap-hidden" : "";
    return `<div class="cap sess-cap ${cls}${fold}" data-code="${esc(s.code)}" style="--c:${s.color}">
      <span class="cap-dot"></span><span class="emo">${s.emoji}</span>
      <span class="cap-name">${sessDisplayHtml(s.code, s.name)}</span></div>`;
  }).join("");
  // 胶囊插到按钮之前（按钮始终排在末尾），无按钮时直接填充
  if (btn) btn.insertAdjacentHTML("beforebegin", capsHTML);
  else sessRow.innerHTML = capsHTML;
  sessRow.querySelectorAll(".sess-cap").forEach((el) => {
    el.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); sessionMenu(ev, el.dataset.code, el.classList.contains("grey")); };
    if (!el.classList.contains("grey")) {
      el.onclick = () => toggleSession(el.dataset.code);
    }
  });
  refreshCapButton();
  flipFromRects(first);   // 重建后按旧坐标 FLIP，改名/显隐/折叠都平滑过渡

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
      // 若右侧详情正展示该会话的条目，同步刷新其展示名（含旧名括号）
      if (ST.active && ST.active.dataset && ST.active.dataset.id) {
        const cur = ST.entries.find((e) => String(e.id) === ST.active.dataset.id);
        if (cur && cur.session_code === code) selectNodeDetail(cur, ST.active);
      }
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
const LEAVE_BASE_MS = 340;   // 离场动画基准时长(≈.34s)；实际按速率档 ×animK

// 取消某元素待执行的离场（在它被复用/重新出现时调用）：清定时器 + 抹掉离场内联样式，
// 让它恢复由 CSS / 后续 render 决定的常态 transform/opacity。
function cancelLeave(el) {
  if (!el) return;
  if (el._leaveTimer) { clearTimeout(el._leaveTimer); el._leaveTimer = 0; }
  el.dataset.leaving = "";
  el.classList.remove("leaving");
  el.style.transition = "";
  el.style.opacity = "";
  el.style.transform = "";
  el.style.pointerEvents = "";
  el.style.animation = "";   // 恢复被 leaveEl 关掉的入场动画能力（复用时可再次播 pop 等）
}

// 协调离场：让「整条泳道 / 整天」作为一个整体一起收拢消失，而非各元素各播各的。
//   base : 元素定位用的基础 transform（须保留，否则会跳位）
//   axis : 'x' 横向收拢（整条泳道整列一起向竖轴合拢）
//          'y' 纵向收拢（整天整行一起向横轴合拢）
//          'fade' 仅淡出（细延伸线，SVG 不便缩放）
//          null 原地缩为 0（单条增删的兜底）
// 同一批离场元素用相同时长与缓动，同帧启动 → 视觉上作为一个整体消失。
function leaveEl(el, base, axis) {
  if (!el || el.dataset.leaving === "1") return;
  el.dataset.leaving = "1";
  el.style.pointerEvents = "none";
  // 关键：清掉尚未结束的入场 pop 动画（.enter/animation）。CSS animation 会覆盖内联 transform，
  // 快速点击时节点常仍在 pop 中，若不清除，离场的 scaleX/Y(0) 会被 pop 压住 → 不播缩小、直接被摘除。
  el.classList.remove("enter");
  el.style.animation = "none";
  const dur = Math.round(LEAVE_BASE_MS * animK());
  el.style.transition = `transform ${dur}ms cubic-bezier(.4,0,.6,1), opacity ${dur}ms ease`;
  void el.offsetWidth;   // 触发过渡起点（用当前 transform 作为起始帧）
  const b = base || "";
  if (axis === "x") el.style.transform = `${b} scaleX(0)`;
  else if (axis === "y") el.style.transform = `${b} scaleY(0)`;
  else if (axis == null) el.style.transform = `${b} scale(0)`;
  // axis === 'fade'：不动 transform，仅靠 opacity 淡出
  el.style.opacity = "0";
  el._leaveTimer = setTimeout(() => el.remove(), dur + 60);
}

// ── 「天分组」离场：整组（日期标识 + 该天所有节点 + 节点间加粗连线）作为一个整体，
//    以左上角为原点缩放 + 透明度淡出/淡入。用真实包裹容器 .day-group 实现，天生同步。──
// 分组是覆盖整个 stage 的透明层（inset:0），只装某一天的元素；子元素仍用 stage 像素坐标，
// 故缩放原点设成「该天左上角的像素点」(0, dayTop)，scale 就从该天左上角展开/收拢。
function groupEnter(group) {
  group.style.transformOrigin = `0px ${group._dayTop || 0}px`;
  group.style.transform = "scale(0)";
  group.style.opacity = "0";
  requestAnimationFrame(() => {
    const dur = Math.round(LEAVE_BASE_MS * animK());
    // 出现用不过冲的 ease-out（末端不超过 1），避免回弹
    group.style.transition = `transform ${dur}ms cubic-bezier(.2,.8,.2,1), opacity ${dur}ms ease`;
    group.style.transform = "scale(1)";
    group.style.opacity = "1";
  });
}
function leaveGroup(group) {
  if (!group || group.dataset.leaving === "1") return;
  group.dataset.leaving = "1";
  group.style.pointerEvents = "none";
  const dur = Math.round(LEAVE_BASE_MS * animK());
  group.style.transition = `transform ${dur}ms cubic-bezier(.4,0,.6,1), opacity ${dur}ms ease`;
  group.style.transformOrigin = `0px ${group._dayTop || 0}px`;
  void group.offsetWidth;
  group.style.transform = "scale(0)";
  group.style.opacity = "0";
  group._leaveTimer = setTimeout(() => group.remove(), dur + 60);
}
function cancelGroupLeave(group) {
  if (!group) return;
  if (group._leaveTimer) { clearTimeout(group._leaveTimer); group._leaveTimer = 0; }
  group.dataset.leaving = "";
  group.style.pointerEvents = "";
  group.style.transform = "scale(1)";
  group.style.opacity = "1";
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

  // 本次「可见」的泳道 / 天集合——用于判定被移除元素是「整条泳道走」还是「整天走」，
  // 从而让同批元素以一致方向（泳道→横向收拢 scaleX0，天→纵向收拢 scaleY0）作为整体消失。
  const visLaneCodes = new Set(visSessions.map((s) => s.code));
  const visDaySet = new Set(vis.map((e) => e.day));

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

  // ── 天分组容器：每天一个覆盖整个 stage 的透明层（.day-group），装该天的
  //    日期标识 + 全部节点 + 节点间加粗连线。整组以「该天左上角」为原点做缩放+透明度动画，
  //    出现/消失时作为一个整体。泳道竖线与火箭轨道不入组、仍是 stage 直接子元素（保持现状）。
  const dayTopOf = {};
  dayMarks.forEach((m) => { dayTopOf[m.day] = m.top - 6; });
  const groupOf = {};   // day -> .day-group 元素
  const seenGroup = new Set();
  const ensureGroup = (day) => {
    if (groupOf[day]) return groupOf[day];
    let g = stage.querySelector(`:scope > .day-group[data-day="${attrEsc(day)}"]`);
    const fresh = !g;
    if (fresh) {
      g = document.createElement("div");
      g.className = "day-group";
      g.dataset.day = day;
      stage.appendChild(g);
    }
    g._dayTop = dayTopOf[day] != null ? dayTopOf[day] : 0;
    if (fresh) groupEnter(g);
    else cancelGroupLeave(g);
    groupOf[day] = g; seenGroup.add(day);
    return g;
  };
  dayMarks.forEach((m) => ensureGroup(m.day));

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
    if (!fresh) cancelLeave(ln);   // 若正在离场又被复用：清定时器与离场内联样式
    ln.setAttribute("y2", H);
    ln.setAttribute("stroke", s.color);
    ln.style.transform = `translateX(${x}px)`;
    if (fresh) requestAnimationFrame(() => ln.style.opacity = "");
    seenRail.add(s.code);
  });
  svg.querySelectorAll("line.rail-ext[data-code]").forEach((ln) => {
    if (!seenRail.has(ln.dataset.code)) {
      // 细延伸线：SVG line 不便缩放，随泳道整体淡出（transform 保留其平移，避免跳位）
      leaveEl(ln, ln.style.transform, "fade");
    }
  });

  // 加粗实色段：按 (泳道, 天) 聚合首末节点 y。
  // 用 HTML div（top/height/left 都是可动画的 CSS 属性）而非 SVG line——
  // SVG <line> 的 y1/y2 是 presentation 属性、CSS transition 无效，节点滑动时连线不会跟随、
  // 只能生硬淡入淡出；改用 div 后连线与节点同一套 transition，始终严丝合缝相连。
  // key 用 "::" 连接（不用 \x00：null 字符写进 DOM 属性会被浏览器丢弃/改写，导致复用/清理都匹配不到）。
  const segMap = {};   // key: code::day -> {code, day, minY, maxY}
  vis.forEach((e, i) => {
    const k = e.session_code + "::" + e.day;
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
    const grp = groupOf[g.day];     // 加粗连线归入其所在天的分组
    let seg = stage.querySelector(`.rail-seg[data-seg="${attrEsc(k)}"]`);
    const fresh = !seg;
    if (fresh) {
      seg = document.createElement("div");
      seg.className = "rail-seg";
      seg.dataset.seg = k;
      seg.style.opacity = "0";
    }
    if (!fresh) cancelLeave(seg);
    if (grp && seg.parentNode !== grp) grp.appendChild(seg);   // 确保挂在正确的天分组内
    // top=首节点中心 y，height=首→末节点中心距，left+translateX(-50%) 居中于泳道列
    seg.style.top = g.minY + "px";
    seg.style.height = (g.maxY - g.minY) + "px";
    seg.style.left = x + "px";
    seg.style.background = s ? s.color : "#8ea0c8";
    if (fresh) requestAnimationFrame(() => seg.style.opacity = "");
    seenSeg.add(k);
  });
  // 清理：整天走的连线随分组一起消失（不单独动画）；仅「泳道走 / 单段自消」时单独离场
  stage.querySelectorAll(".rail-seg[data-seg]").forEach((seg) => {
    if (!seenSeg.has(seg.dataset.seg)) {
      const [code, day] = (seg.dataset.seg || "").split("::");
      if (!visDaySet.has(day)) { /* 整天走：交给 leaveGroup 整体处理，这里不重复动画 */ return; }
      // 整条泳道走→横向收拢；单段自消→原地缩小
      const axis = !visLaneCodes.has(code) ? "x" : null;
      leaveEl(seg, "translateX(-50%)", axis);
    }
  });

  // ── 2) 日期标识：归入所在天的分组；solo/multi 切换时改 class + 内容，尺寸/位置走 transition ──
  dayMarks.forEach((m) => {
    const dd = ST.days.find((x) => x.day === m.day);
    const grp = groupOf[m.day];
    let band = stage.querySelector(`.day-band[data-day="${attrEsc(m.day)}"]`);
    const fresh = !band;
    if (fresh) {
      band = document.createElement("div");
      band.dataset.day = m.day;
    }
    if (grp && band.parentNode !== grp) grp.appendChild(band);
    if (dd) band.style.setProperty("--day-c", dd.color);
    const wantSolo = solo ? "solo" : "multi";
    if (band.dataset.shape !== wantSolo) {
      band.dataset.shape = wantSolo;
      band.className = "day-band" + (solo ? " solo" : "");
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
  });
  // 日期标识随其所在天分组一起出现/消失，无需在此单独处理离场（整天走时 leaveGroup 会移除整组）

  // ── 3) 节点：归入所在天的分组，按 entry id 复用；left/top 变化走 transition；新增播 pop ──
  const seenNode = new Set();
  vis.forEach((e, i) => {
    const s = ST.sessions.find((x) => x.code === e.session_code);
    const x = COL_X0 + laneOf[e.session_code] * COL_W, ny = nodeY[i];
    const grp = groupOf[e.day];
    let node = stage.querySelector(`.node[data-id="${attrEsc(String(e.id))}"]`);
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
    } else {
      cancelLeave(node);
    }
    if (grp && node.parentNode !== grp) grp.appendChild(node);   // 挂到（或迁到）正确的天分组
    node.dataset.code = e.session_code;   // 供离场时判定「整条泳道走 or 整天走」
    node.dataset.day = e.day;
    node.style.setProperty("--c", s.color);
    node.style.left = x + "px";
    node.style.top = ny + "px";
    node.dataset.tip = e.title || sessDisplay(e.session_code, s.name);
    seenNode.add(String(e.id));
  });
  stage.querySelectorAll(".node[data-id]").forEach((node) => {
    if (!seenNode.has(node.dataset.id)) {
      if (node === ST.active) { ST.active = null; closeDetail(); }
      // 整天走：随分组整体消失，节点不单独动画。否则：泳道走→横向收拢；单条自消→原地缩小。
      if (!visDaySet.has(node.dataset.day)) return;
      const axis = !visLaneCodes.has(node.dataset.code) ? "x" : null;
      leaveEl(node, "translate(-50%,-50%)", axis);
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
  // 节点现居于各天分组内，查询不再用 :scope > 直接子选择器。
  stage.querySelectorAll(".node.in-rocket").forEach((n) => n.classList.remove("in-rocket"));
  const rocketIds = new Set();
  runs.forEach((r) => r.ids.forEach((id) => rocketIds.add(String(id))));
  rocketIds.forEach((id) => {
    const n = stage.querySelector(`.node[data-id="${attrEsc(id)}"]`);
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
    if (!fresh) cancelLeave(el);
    const ent0 = vis.find((v) => v.id === r.id);
    if (ent0) { el.dataset.code = ent0.session_code; el.dataset.day = ent0.day; }
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
    if (!seenRun.has(el.dataset.run)) {
      // 火箭轨道不入分组、保持现状：泳道走→横向收拢；天走→纵向收拢；单条自消→缩小
      const axis = !visLaneCodes.has(el.dataset.code) ? "x"
        : !visDaySet.has(el.dataset.day) ? "y" : null;
      leaveEl(el, "translateX(-50%)", axis);
    }
  });

  // ── 天分组清理：本次不再出现的天，整组（日期标识+节点+加粗连线）一起缩小淡出 ──
  stage.querySelectorAll(":scope > .day-group[data-day]").forEach((g) => {
    if (!seenGroup.has(g.dataset.day)) leaveGroup(g);
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
  // 若该条已在当前视图内则不切范围；否则切到其所在月
  const already = ST.entries.some((x) => String(x.id) === String(e.id));
  if (!already) {
    const month = (e.day || e.datetime || "").slice(0, 7);
    if (month) await loadView({ month }, false);
  }
  ST.selectedDays = new Set([e.day]);
  ST.hiddenSessions = new Set(
    ST.sessions.map((s) => s.code).filter((c) => c !== e.session_code));
  saveSel();
  render();
  const node = document.querySelector(`#stage .node[data-id="${attrEsc(String(e.id))}"]`);
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
        <span class="d-who">${sessDisplayHtml(ef.session_code, s.name)}</span>
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

// ── 月份 / 模式选择 ──
async function openMonthPicker(ev) {
  let months = [];
  try { months = (await API.months()).months; } catch (_) {}
  const items = [
    // 最近30天：置顶、默认模式
    { label: "最近 30 天", check: ST.mode === "recent",
      act: () => { if (ST.mode === "recent") { closeMenu(); return; } loadView({ recent: 30 }, true); } },
  ];
  if (months.length) {
    items.push({ sep: true });
    months.forEach((m) => items.push({
      label: m, check: ST.mode === "month" && m === ST.month,
      act: () => { if (ST.mode === "month" && m === ST.month) { closeMenu(); return; } loadView({ month: m }, true); },
    }));
  }
  openMenu(ev, { head: "选择范围", items });
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
function reloadKeepMonth() {
  closeMenu();
  loadView(ST.mode === "recent" ? { recent: ST.recentDays } : { month: ST.month }, true);
  updateDeviceLabel();
}
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
  // 更新提示 banner 的查看/忽略
  const nv = $("update-notice-view"), nd = $("update-notice-dismiss");
  if (nv) nv.onclick = viewUpdateNotice;
  if (nd) nd.onclick = dismissUpdateNotice;
  // 设置页切换「自动隐藏灰态会话」→ 跨标签页 storage 事件，就地切类走动画（不重建、不刷新）
  window.addEventListener("storage", (ev) => {
    if (ev.key === HIDE_GREY_KEY) refreshCapFold();
  });
  const left = $("left");
  if (left) left.addEventListener("scroll", () => { cancelTip(); }, { passive: true });
  const right = $("detail");
  // 自绘滚动条（泳道 + 日志），轨道只在 banner 之下
  _vscrolls = [left, right].filter(Boolean).map((p) => VScroll(p));
  bindGlobalMenu();
  initDebugTag("front/viewer");
  try {
    const dr = await API.devices();
    ST.devices = dr.devices || [];
  } catch (_) {}
  // 恢复视图：URL 查询参数优先（刷新/分享复原，不落库），其次 localStorage 上次视图，默认最近30天
  _urlState = readUrl();
  const v = _urlState || loadSavedView();
  if (v && v.mode === "month" && v.month) { ST.mode = "month"; ST.month = v.month; }
  else { ST.mode = "recent"; ST.recentDays = 30; }
  // 恢复该视图的设备筛选：URL 优先，其次 localStorage
  const savedSel = (_urlState && Array.isArray(_urlState.devices)) ? _urlState : loadSel()[viewKey()];
  if (savedSel && Array.isArray(savedSel.devices)) {
    ST.selectedDevices = new Set(savedSel.devices.filter((d) => ST.devices.includes(d)));
    if (!ST.selectedDevices.size || ST.selectedDevices.size === ST.devices.length) ST.selectedDevices = null;
  }
  updateDeviceLabel();
  _bootstrapped = true;
  await loadView(ST.mode === "recent" ? { recent: ST.recentDays } : { month: ST.month }, true);
  startPolling(5000);   // 静默轮询：就地动画更新 + 视图外更新提示
}
window.addEventListener("DOMContentLoaded", initViewer);
