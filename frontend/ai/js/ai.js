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
  workerStatus: () => fetch("/api/ai/worker/status").then((r) => r.json()),
  askSearch: (q, topK) => fetch("/api/ai/ask/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, top_k: topK || 6 }) }).then((r) => r.json()),
  // ask/stream 是 SSE，不用 .json()；单独在 handleAsk 里 fetch + reader
  askHistory: () => fetch("/api/ai/ask/history").then((r) => r.json()),
  askHistoryDelete: (id) => fetch("/api/ai/ask/history/" + encodeURIComponent(id), { method: "DELETE" }).then((r) => r.json()),
};

const $ = (id) => document.getElementById(id);
const ns = "http://www.w3.org/2000/svg";   // 共用（爆炸图轨道 & 二级泳道 rails）
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
  let list = [];
  try { list = (await AI.topics(devs)).topics || []; } catch (_) { list = []; }
  // 稳定顺序：老主题按已有顺序保留，新主题追加到末尾。物理引擎下顺序只影响 iteration
  // 顺序，不影响运动状态，但保留顺序仍能让 Object.values 遍历更可预期。
  const oldOrder = (ST.topics || []).map((t) => t.topic);
  const byName = {}; list.forEach((t) => { byName[t.topic] = t; });
  const kept = oldOrder.map((n) => byName[n]).filter(Boolean);
  const keptSet = new Set(kept.map((t) => t.topic));
  const fresh = list.filter((t) => !keptSet.has(t.topic));
  ST.topics = [...kept, ...fresh];
  renderGalaxy();
}

// ══════════ 拟真行星系物理引擎 ══════════════════════════════════════════════
// 每个主题节点是一颗行星，中心「洞察」是恒星（固定不动）。
// 引力：F_grav = -GM · r̂ / (|r|² + ε²)      Plummer 软化，避免奇点
// 斥力：F_rep = k_rep · r̂ / max(d², ε²)      两球相近时启用，只在 d < 1.5·(R₁+R₂) 时算
// 积分：velocity Verlet
//   v_{n+½} = v_n + a_n · dt/2
//   x_{n+1} = x_n + v_{n+½} · dt
//   a_{n+1} = f(x_{n+1})
//   v_{n+1} = v_{n+½} + a_{n+1} · dt/2
// 时间缩放：物理 dt = raw_dt / animK —— 设置里选"优雅"，公转自然变慢。
// 拖尾：Canvas 每帧清屏后重绘每个节点近 TRAIL_LEN 帧位置的渐变短线。
const _galaxyNodes = {};              // topic -> entry
let _rafId = 0;
let _lastFrameTs = 0;
// 每个主题"上次用户见过的 updated_at"：本轮 API 返回值与之不同 → 主题被更新 → 显示红点。
// 用 localStorage 持久化，避免刷新页面就丢红点标记。
const SEEN_KEY = "ailogy:ai:seenTopicUpdatedAt";
const _seenUpdatedAt = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch (_) { return {}; } })();
function saveSeen() { try { localStorage.setItem(SEEN_KEY, JSON.stringify(_seenUpdatedAt)); } catch (_) {} }
function updateNodeDot(entry) {
  if (!entry || !entry.node) return;
  const dot = entry.node.querySelector(".gn-dot");
  if (!dot) return;
  dot.hidden = !entry.__hasUpdate;
}

function animK() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--anim-k"));
  return v > 0 ? v : 1;
}

// 视觉参数（减小以缓解重叠：斥力有效距离与节点半径正相关，缩小节点等于给"社交距离"留空）
const SIZE_MIN = 34, SIZE_MAX = 62;   // 节点直径区间（会话数派生，不影响速度）
const TRAIL_LEN = 140;                // 拖尾保留帧数（约 2.3s @ 60fps，够画大半段弧）
const TRAIL_HEAD_SKIP = 5;            // 跳过头部 N 帧，让拖尾落在节点身后而不被覆盖
// 物理参数（GM 由 refreshScale 根据 stage 尺寸 & 目标周期换算，保证不同屏幕视觉一致）
let _GM = 4e4;                        // 引力参数，动态刷新
let _softEps2 = 400;                  // ε²，Plummer 软化平方（≈ 20px²）
let _repulsion = 5e3;                 // 斥力系数
let _rMinInit = 110, _rMaxInit = 260; // 新主题的初始位置半径区间
let _stageCx = 0, _stageCy = 0;       // stage 中心（世界原点）
// 人造力（辅助势）参数：让轨道稳定、防越界、防坠日 —— 由 refreshScale 一并给值。
let _kOrbit = 0.35;                   // 轨道回归弹性系数（越大越"粘"自己的目标半径）
let _kEdge = 0;                       // 边界阻力峰值加速度
let _kCore = 0;                       // 中心阻力峰值加速度
let _edgeMargin = 80;                 // 边界势阱厚度（越靠近边缘力越大）
let _coreR = 90;                      // 中心势阱半径（越靠近中心力越大）
let _halfW = 400, _halfH = 300;       // stage 半宽/半高（世界坐标：±_halfW, ±_halfH）

// 依据 stage 尺寸重设物理参数：
//   目标 —— 半径 R_inner ≈ 130px 的行星，极速档周期 T ≈ 22s。
//   由 T = 2π·√(R³/GM) → GM = 4π²R³/T².
// 保证换屏幕/缩放窗口后，视觉节奏与主题数量都一致。
function refreshScale(w, h) {
  const minSide = Math.min(w, h);
  const R = Math.max(90, minSide * 0.22);            // 参考轨道半径
  _rMinInit = R * 0.75;
  _rMaxInit = R * 1.9;
  const T = 22;                                       // 极速档周期（秒）
  _GM = (4 * Math.PI * Math.PI * R * R * R) / (T * T);
  _softEps2 = Math.pow(R * 0.15, 2);                  // 软化半径 ≈ 参考轨道 15%
  _repulsion = _GM * 0.35;                            // 斥力量级：显著大于引力，保证不重叠
  // 人造力：跟引力加速度量级挂钩，保证在参考轨道处仍不喧宾夺主。
  // 引力加速度 @ R ≈ GM/R²。三个"势阱"取其 0.6~1.2 倍，位置略偏离才显效。
  const gAtR = _GM / (R * R);
  _kOrbit = gAtR * 0.7;                               // 径向回归：越远离目标轨道越强，让引力弹弓自动衰减
  _kEdge = gAtR * 6;                                  // 边界墙：峰值远大于引力，接近边缘时立刻回推
  _kCore = gAtR * 5;                                  // 中心墙：防止穿过洞察核
  _edgeMargin = Math.max(60, minSide * 0.12);         // 势阱厚度：屏幕越大墙越厚
  _coreR = Math.max(70, R * 0.55);                    // 中心势阱半径：略大于参考轨道近日点
  _halfW = w * 0.5; _halfH = h * 0.5;
}

// 拖尾 Canvas（一次性创建，铺满 stage 层）
let _trailCanvas = null;
let _trailCtx = null;
function ensureTrailCanvas(stage, w, h) {
  if (!_trailCanvas) {
    _trailCanvas = document.createElement("canvas");
    _trailCanvas.className = "orbit-trail";
    stage.insertBefore(_trailCanvas, stage.firstChild);
    _trailCtx = _trailCanvas.getContext("2d");
  }
  // devicePixelRatio 缩放，避免拖尾发糊
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(w), cssH = Math.round(h);
  if (_trailCanvas.width !== cssW * dpr || _trailCanvas.height !== cssH * dpr) {
    _trailCanvas.width = cssW * dpr; _trailCanvas.height = cssH * dpr;
    _trailCanvas.style.width = cssW + "px"; _trailCanvas.style.height = cssH + "px";
    _trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

// 给新主题分配初始条件：随机半径 + 切向速度（略偏离圆速度 → 得到偏心小椭圆）。
// 位置角度也随机；后续物理演化会自然形成不同椭圆形状。
function seedNewTopic(entry) {
  const r = _rMinInit + Math.random() * (_rMaxInit - _rMinInit);
  const ang = Math.random() * Math.PI * 2;
  entry.x = Math.cos(ang) * r;
  entry.y = Math.sin(ang) * r;
  // 圆速度 v_circ = √(GM/r)，加 ±15% 抖动
  const vCirc = Math.sqrt(_GM / r);
  const kSpeed = 0.95 + Math.random() * 0.15;        // [0.95, 1.10]，缩窄抖动确保切向为主，同向
  // 所有节点同向（逆时针）：切向单位向量 = (-sin, cos)，正系数即逆时针
  entry.vx = -Math.sin(ang) * vCirc * kSpeed;
  entry.vy = Math.cos(ang) * vCirc * kSpeed;
  entry.ax = 0; entry.ay = 0;
  entry.trail = [];
  entry.rTarget = r;   // 目标轨道半径：轨道回归力会把该节点拉回这个半径附近
}

// 关闭综述时，为被选中节点重新入轨：找一个"当前系统压力最小"的方位放它，
// 半径取参考轨道，切向速度取圆速度 → 无缝汇入。
function reseedReleased(entry) {
  // 采样 24 个方位，选距离所有其他行星最远的那个方位
  const others = Object.values(_galaxyNodes).filter((e) => e !== entry && Number.isFinite(e.x));
  let bestAng = 0, bestScore = -Infinity;
  const targetR = (_rMinInit + _rMaxInit) / 2;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const px = Math.cos(a) * targetR, py = Math.sin(a) * targetR;
    // 得分 = 到最近其他行星的距离
    let minD = Infinity;
    for (const o of others) {
      const dx = o.x - px, dy = o.y - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minD) minD = d;
    }
    if (minD > bestScore) { bestScore = minD; bestAng = a; }
  }
  entry.x = Math.cos(bestAng) * targetR;
  entry.y = Math.sin(bestAng) * targetR;
  const vCirc = Math.sqrt(_GM / targetR);
  entry.vx = -Math.sin(bestAng) * vCirc;
  entry.vy = Math.cos(bestAng) * vCirc;
  entry.ax = 0; entry.ay = 0;
  entry.trail = [];
  entry.rTarget = targetR;   // 更新目标轨道半径
}

// 计算并累加节点 e 上所有力对应的加速度到 (ax, ay)。
// 组成：
//   ① 中心引力 F_grav = -GM·r̂/(|r|²+ε²)
//   ② 节点两两斥力（近场剪枝）：防重叠
//   ③ 轨道回归弹性 F_orbit = -k_orb·(|r|-r_target)·r̂：把节点粘回自己的目标半径，
//      抑制引力弹弓造成的椭圆越拉越长
//   ④ 边界势阱 F_edge：距离 stage 边缘 < margin 时施加向内推力（1-d/margin)² 分布
//   ⑤ 中心势阱 F_core：距离中心 < coreR 时施加径向外推力，防坠日
function accumForces(e, all) {
  const rx = e.x, ry = e.y;
  const rr2 = rx * rx + ry * ry;
  const rMag = Math.sqrt(rr2) || 0.001;
  const rHatX = rx / rMag, rHatY = ry / rMag;

  // ① 引力
  const r2Soft = rr2 + _softEps2;
  const invR3 = 1 / (r2Soft * Math.sqrt(r2Soft));
  let ax = -_GM * rx * invR3;
  let ay = -_GM * ry * invR3;

  // ② 斥力（近场）
  const eR = e.size * 0.5;
  for (const o of all) {
    if (o === e || !Number.isFinite(o.x) || o.__selected) continue;
    const dx = rx - o.x, dy = ry - o.y;
    const d2 = dx * dx + dy * dy;
    const oR = o.size * 0.5;
    const contact = eR + oR;
    const cutoff = contact * 2.5;
    if (d2 > cutoff * cutoff) continue;
    const d2s = Math.max(d2, contact * contact * 0.25);
    const invD3 = 1 / (d2s * Math.sqrt(d2s));
    ax += _repulsion * dx * invD3;
    ay += _repulsion * dy * invD3;
  }

  // ③ 轨道回归弹性 + 径向阻尼：把节点拉回 rTarget，同时消除径向速度分量。
  //   弹力 F_spring = -k_orb·(r-r_target)·r̂
  //   阻尼 F_damp   = -c·(v · r̂)·r̂    只作用在径向分量上，保留切向速度（不影响公转）
  //   c 取 √(4·k_orb) 附近 → 临界阻尼，无过冲
  if (Number.isFinite(e.rTarget)) {
    const dr = rMag - e.rTarget;
    const vRadial = e.vx * rHatX + e.vy * rHatY;      // 速度在 r̂ 方向的投影
    const damp = 2 * Math.sqrt(_kOrbit);
    const aRadial = -_kOrbit * dr - damp * vRadial;
    ax += aRadial * rHatX;
    ay += aRadial * rHatY;
  }

  // ④ 边界势阱：距离左/右/上/下边缘 < margin 时施加向内推力
  //   用平方衰减 (1 - d/margin)² × 单位法向量，越靠近墙力越大
  const leftD  = _halfW + rx - eR;        // 到左墙距离
  const rightD = _halfW - rx - eR;
  const topD   = _halfH + ry - eR;
  const botD   = _halfH - ry - eR;
  const m = _edgeMargin;
  if (leftD  < m) { const p = 1 - Math.max(0, leftD)  / m; ax += _kEdge * p * p; }
  if (rightD < m) { const p = 1 - Math.max(0, rightD) / m; ax -= _kEdge * p * p; }
  if (topD   < m) { const p = 1 - Math.max(0, topD)   / m; ay += _kEdge * p * p; }
  if (botD   < m) { const p = 1 - Math.max(0, botD)   / m; ay -= _kEdge * p * p; }

  // ⑤ 中心势阱：距离中心 < coreR 时施加径向外推
  if (rMag < _coreR) {
    const p = 1 - rMag / _coreR;
    const push = _kCore * p * p;
    ax += push * rHatX;
    ay += push * rHatY;
  }

  return [ax, ay];
}

// 硬约束：物理步进后扫一遍，若两节点距离 < contact，沿连线各推一半直到相离。
// 这是"无法穿透"的最后防线，防止极端情况（大 dt / 数值误差）造成瞬时重叠。
function separateOverlaps(nodes) {
  for (let iter = 0; iter < 3; iter++) {
    let touched = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const contact = (a.size + b.size) * 0.5;
        if (d2 >= contact * contact) continue;
        const d = Math.sqrt(d2) || 0.001;
        const overlap = (contact - d) * 0.5 + 0.5;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;
        touched = true;
      }
    }
    if (!touched) break;
  }
}

// 一次物理步进（velocity Verlet）。dt 为已经按 animK 缩放后的物理时间步长（秒）。
function physicsStep(dt, activeNodes) {
  // 半步速度 + 位置推进
  for (const e of activeNodes) {
    e.vx += 0.5 * e.ax * dt;
    e.vy += 0.5 * e.ay * dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
  }
  // 新位置下重算加速度
  for (const e of activeNodes) {
    const [ax, ay] = accumForces(e, activeNodes);
    e.ax = ax; e.ay = ay;
  }
  // 后半步速度
  for (const e of activeNodes) {
    e.vx += 0.5 * e.ax * dt;
    e.vy += 0.5 * e.ay * dt;
  }
  // 硬约束：兜底位置分离，绝不重叠
  separateOverlaps(activeNodes);
  // 追加拖尾采样（世界坐标）
  for (const e of activeNodes) {
    e.trail.push(e.x, e.y);
    const maxLen = TRAIL_LEN * 2;
    if (e.trail.length > maxLen) e.trail.splice(0, e.trail.length - maxLen);
  }
}

// 拖尾绘制：跳过最新 TRAIL_HEAD_SKIP 帧（这些点会被节点圆球遮住），从更早的位置开始画。
// 线段越老越淡越细；宽度按节点直径 × 0.55 起步，视觉与球对齐。
function drawTrails(w, h) {
  if (!_trailCtx) return;
  _trailCtx.clearRect(0, 0, w, h);
  _trailCtx.lineCap = "round";
  _trailCtx.lineJoin = "round";
  // 选中节点存在时（打开了主题综述），所有其他节点的拖尾整体更淡（× 0.35）→
  // 呼应 CSS 里 topic-focus 时其他行星整体退居次要，视觉聚焦在选中的那颗上。
  const hasSelection = Object.values(_galaxyNodes).some((e) => e.__selected);
  const trailAlphaFactor = hasSelection ? 0.35 : 1;
  for (const e of Object.values(_galaxyNodes)) {
    if (!e.trail || e.trail.length < (TRAIL_HEAD_SKIP + 2) * 2) continue;
    if (e.__selected) continue;                        // 选中态自身不画拖尾（它停在中心）
    const color = e.__color || "#6ea8fe";
    const total = e.trail.length / 2 | 0;
    const drawFrom = Math.max(0, total - TRAIL_LEN);
    const drawTo = total - TRAIL_HEAD_SKIP;
    if (drawTo - drawFrom < 2) continue;
    const wBase = Math.max(1.4, e.size * 0.18);
    for (let i = drawFrom + 1; i < drawTo; i++) {
      const t = (i - drawFrom) / (drawTo - drawFrom);
      const alpha = t * t * 0.45 * trailAlphaFactor;   // 选中态时整体乘 0.35
      const width = wBase * (0.35 + t * 0.65);
      _trailCtx.strokeStyle = withAlpha(color, alpha);
      _trailCtx.lineWidth = width;
      _trailCtx.beginPath();
      _trailCtx.moveTo(_stageCx + e.trail[(i - 1) * 2], _stageCy + e.trail[(i - 1) * 2 + 1]);
      _trailCtx.lineTo(_stageCx + e.trail[i * 2], _stageCy + e.trail[i * 2 + 1]);
      _trailCtx.stroke();
    }
  }
}

// 将 #rrggbb 转成 rgba(...) 带自定 alpha
function withAlpha(hex, alpha) {
  if (!hex || hex[0] !== "#") return "rgba(110,168,254," + alpha + ")";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

// renderGalaxy 的新职责：只维护 DOM 与物理属性（size/color），
// 位置全交给 RAF 里的 physicsStep + 位置提交步骤。
function renderGalaxy() {
  const stage = $("galaxy-stage");
  const empty = $("galaxy-empty");
  const topics = ST.topics;
  if (empty) empty.hidden = topics.length > 0;

  const rect = stage.getBoundingClientRect();
  // 首帧 layout 可能还没完成（父容器尺寸为 0），此时算出来的 cx/cy 都是 0。
  // 直接跳过，等 ResizeObserver 拿到真实尺寸后再触发一次。
  if (rect.width < 50 || rect.height < 50) return;
  _stageCx = rect.width / 2; _stageCy = rect.height / 2;
  refreshScale(rect.width, rect.height);
  ensureTrailCanvas(stage, rect.width, rect.height);

  // 会话数区间用于 size 映射
  const sVals = topics.map((t) => Math.max(1, t.session_count || t.entry_count || 1));
  const sMin = sVals.length ? Math.min(...sVals) : 1;
  const sMax = sVals.length ? Math.max(...sVals) : 1;

  const seen = new Set();
  topics.forEach((t) => {
    const color = t.color || colorOf(t.topic);
    seen.add(t.topic);
    let entry = _galaxyNodes[t.topic];
    const isNew = !entry;
    if (isNew) {
      const node = document.createElement("div");
      node.className = "galaxy-node enter";
      // 结构：emoji + 对号（选中态）+ 日志数角标 + 更新红点（有更新时出现）
      node.innerHTML = '<span class="gn-emo"></span>'
        + '<span class="gn-check">' + icon("check") + '</span>'
        + '<span class="gn-count"></span>'
        + '<span class="gn-dot" hidden></span>';
      const name = document.createElement("div");
      name.className = "galaxy-name-cap";
      node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
      // 先给 DOM 一个初始位置 = stage 中心，让 gn-burst 从中心迸发（视觉上"新星诞生"）
      node.style.left = _stageCx + "px"; node.style.top = _stageCy + "px";
      name.style.left = _stageCx + "px"; name.style.top = _stageCy + "px";
      stage.appendChild(node); stage.appendChild(name);
      entry = _galaxyNodes[t.topic] = { node, name };
      seedNewTopic(entry);
    }
    const { node, name } = entry;
    // 尺寸：会话数派生。size 只影响直径与视觉，不参与速度计算（真实行星质量对绕日速度无影响）。
    const s = Math.max(1, t.session_count || t.entry_count || 1);
    const norm = sMax === sMin ? 0.6 : (s - sMin) / (sMax - sMin);
    const size = SIZE_MIN + norm * (SIZE_MAX - SIZE_MIN);
    entry.size = size;
    entry.__color = color;
    node.dataset.topic = t.topic;
    node.style.setProperty("--c", color);
    node.style.setProperty("--ring-alpha", 1);   // 拟真：所有行星同等清晰（不再有环号透明度）
    if (name) name.style.setProperty("--ring-alpha", 1);
    node.querySelector(".gn-emo").textContent = (t.emoji || "").trim() || topicEmoji(t.topic);
    node.querySelector(".gn-count").textContent = String(t.entry_count || 0);
    // 更新红点：本轮 API 返回的 updated_at 比上一次记录的新 → 显示红点。
    // 用户点击查看后（openTopicCard），红点消失并把 updated_at 存入 _seenUpdatedAt。
    const upd = t.updated_at || "";
    if (isNew) {
      // 新主题：首次入场不算"有更新"，直接把当前 updated_at 记为已见
      _seenUpdatedAt[t.topic] = upd;
      saveSeen();
    } else if (upd && upd !== _seenUpdatedAt[t.topic]) {
      entry.__hasUpdate = true;
    }
    updateNodeDot(entry);
    name.textContent = t.topic;
    name.style.setProperty("--c", color);
    node.onclick = () => {
      if (_paused && !node.classList.contains("selected")) return;
      // 点击即"已见"：消红点、更新 _seenUpdatedAt
      _seenUpdatedAt[t.topic] = t.updated_at || _seenUpdatedAt[t.topic] || "";
      saveSeen();
      entry.__hasUpdate = false;
      updateNodeDot(entry);
      openTopicCard(t, node);
    };
    // 右键：弹出上下文菜单（"提问" / "查看综述"）；点"提问"才展开面板并附加该主题所有会话。
    node.oncontextmenu = (ev) => {
      ev.preventDefault();
      openMenu(ev, {
        head: `主题「${t.topic}」`,
        items: [
          { label: icon("msg") + " 就此主题提问",
            act: () => askAboutTopic(t.topic, t.color || colorOf(t.topic)) },
          { label: icon("note") + " 查看综述",
            act: () => openTopicCard(t, node) },
        ],
      });
    };
    if (node.classList.contains("selected")) return;
    node.style.width = size + "px"; node.style.height = size + "px";
    // 位置由 RAF 提交；这里给个初始点，避免首帧闪在 (0,0)
    node.style.left = (_stageCx + entry.x) + "px";
    node.style.top = (_stageCy + entry.y) + "px";
    name.style.left = (_stageCx + entry.x) + "px";
    name.style.top = (_stageCy + entry.y + size / 2 + 10) + "px";
  });
  // 移除已消失主题（缩回中心淡出）
  Object.keys(_galaxyNodes).forEach((tp) => {
    if (!seen.has(tp)) {
      const { node, name } = _galaxyNodes[tp];
      node.classList.add("leaving");
      if (name) name.remove();
      setTimeout(() => node.remove(), 500);
      delete _galaxyNodes[tp];
    }
  });
}

// 主 RAF：velocity Verlet 积分 + Canvas 拖尾 + 位置提交。
// dt 用 raw_dt / animK 缩放：设置改动画速率档，物理时间流速跟着变。
// 长帧限幅到 50ms，避免切 tab 回来后一步跳半圈。
// 选中节点 / .moving 中的节点不参与物理，但仍随 DOM 变化保持其位置（选中态在中心）。
function startOrbit() {
  cancelAnimationFrame(_rafId);
  const stage = $("galaxy-stage");
  const tick = (ts) => {
    const raw = _lastFrameTs ? (ts - _lastFrameTs) / 1000 : 1 / 60;
    _lastFrameTs = ts;
    const rawDt = Math.max(0, Math.min(raw, 0.05));
    if (ST.level !== 1 || document.hidden || rawDt <= 0) {
      _rafId = requestAnimationFrame(tick);
      return;
    }
    const rect = stage ? stage.getBoundingClientRect() : { width: 0, height: 0 };
    if (rect.width >= 50 && rect.height >= 50) {
      _stageCx = rect.width / 2; _stageCy = rect.height / 2;
      ensureTrailCanvas(stage, rect.width, rect.height);
    }

    const dt = rawDt / animK();                     // 物理时间步
    const all = Object.values(_galaxyNodes);
    // 选中/过渡中的节点不参与物理：它们的位置由 openTopicCard / closeTopicCard 控制
    const active = all.filter((e) => e.node && !e.__selected && !e.node.classList.contains("moving"));

    // 数值积分：dt 大时分子步以提升稳定性（近日点速度快，误差敏感）
    const substeps = dt > 0.02 ? 2 : 1;
    const sdt = dt / substeps;
    for (let s = 0; s < substeps; s++) physicsStep(sdt, active);

    // Canvas 拖尾
    drawTrails(rect.width, rect.height);

    // 提交位置到 DOM
    for (const e of active) {
      const x = _stageCx + e.x;
      const y = _stageCy + e.y;
      e.node.style.left = x + "px"; e.node.style.top = y + "px";
      if (e.name) { e.name.style.left = x + "px"; e.name.style.top = (y + e.size / 2 + 10) + "px"; }
    }
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

// 主题 emoji：用主题名派生一个稳定 emoji（无语义，仅点缀）
const _EMOJI_POOL = ["🌱","⚙️","🔧","📦","🚀","🧭","🧩","📊","🔬","🎯","🗂️","💡","🛠️","🔭","📐","🧪"];
function topicEmoji(topic) {
  let h = 0; for (const ch of (topic || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return _EMOJI_POOL[h % _EMOJI_POOL.length];
}

// ── 主题综述面板（右侧滑出，日志样式，无背景模糊；打开时选中节点放大+对号、暂停刷新）──
let _paused = false;                 // 打开综述后暂停一级刷新
// 中心节点直径（与 .galaxy-core 的 CSS width/height 保持一致）——被点节点会扩到这个尺寸
const CORE_SIZE = 108;

function openTopicCard(t, node) {
  const card = $("topic-card");
  Object.values(_galaxyNodes).forEach((e) => {
    e.node.classList.remove("selected");
    e.__selected = false;
  });
  if (node) {
    node.classList.add("selected");
    const entry = _galaxyNodes[t.topic];
    if (entry) {
      entry.__selected = true;             // 物理引擎跳过此节点，其他节点不受影响 → 无卡顿
      if (entry.name) entry.name.classList.add("hide-on-select");
      // 独立 RAF 动画：先缩小（脱离轨道）再快速非线性位移到中心并回弹放大。
      // 只影响这个节点自己，不给其他节点加 .moving → 主 RAF 全部正常物理
      flyToCenter(entry, node);
    }
  }
  $("ai-galaxy").classList.add("card-open", "topic-focus");
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
  $("ai-galaxy").classList.remove("card-open", "topic-focus");
  // 找到被选中的那颗，让它独立 RAF 飞回入轨点；其他节点不动，物理引擎照常。
  const sel = Object.values(_galaxyNodes).find((e) => e.__selected);
  ST.selectedTopic = null; _paused = false;
  if (!sel) return;
  reseedReleased(sel);                        // 决定入轨目标 (sel.x, sel.y)
  const node = sel.node;
  node.classList.remove("selected");
  flyBackToOrbit(sel, node);
}

// 独立 RAF 动画：选中节点从原位置缩小、快速非线性弹向中心并放大回弹。
//   Phase A (0-140ms): scale 1 → 0.55（脱轨"跃起"感）
//   Phase B (140-620ms): 沿 easeOutBack 从起点飞到中心，size 从 sel.size 到 CORE_SIZE
// 用 requestAnimationFrame，不改 CSS transition，也不给其他节点加 .moving。
function flyToCenter(entry, node) {
  cancelFlyAnim(entry);
  // 禁用节点自身的 width/height/left/top CSS transition，让 RAF 逐帧写值即时生效
  node.style.transition = "box-shadow .3s ease, filter .3s ease";
  const startX = _stageCx + entry.x, startY = _stageCy + entry.y;
  const endX = _stageCx, endY = _stageCy;
  const startSize = entry.size, endSize = CORE_SIZE;
  const shrinkMs = 140 * animK();
  const flyMs = 480 * animK();
  const total = shrinkMs + flyMs;
  const t0 = performance.now();
  entry.__flyAnim = requestAnimationFrame(function tick() {
    if (!entry.__selected) { cancelFlyAnim(entry); node.style.transition = ""; return; }
    const elapsed = performance.now() - t0;
    if (elapsed >= total) {
      node.style.left = endX + "px"; node.style.top = endY + "px";
      node.style.width = endSize + "px"; node.style.height = endSize + "px";
      cancelFlyAnim(entry);
      // 保持 inline transition 关闭 —— 直到 closeTopicCard 恢复
      return;
    }
    if (elapsed < shrinkMs) {
      // Phase A：仅缩小（先蓄力再飞）
      const p = elapsed / shrinkMs;
      const s = startSize * (1 - p * 0.45);
      node.style.width = s + "px"; node.style.height = s + "px";
      node.style.left = startX + "px"; node.style.top = startY + "px";
    } else {
      // Phase B：位移 + 放大到中心，easeOutBack 得到"回弹"感
      const p = (elapsed - shrinkMs) / flyMs;
      const e = easeOutBack(p);
      const midSize = startSize * 0.55;
      node.style.left = (startX + (endX - startX) * e) + "px";
      node.style.top = (startY + (endY - startY) * e) + "px";
      node.style.width = (midSize + (endSize - midSize) * e) + "px";
      node.style.height = (midSize + (endSize - midSize) * e) + "px";
    }
    entry.__flyAnim = requestAnimationFrame(tick);
  });
}

// 关闭时独立 RAF：从中心 CORE_SIZE 快速弹到入轨点 (sel.x, sel.y)，回原尺寸。
// 结束后清 __selected → 物理引擎立即接管此节点。
function flyBackToOrbit(entry, node) {
  cancelFlyAnim(entry);
  // 保持 transition 关闭直到动画结束 → RAF 逐帧写值不被 CSS 补间稀释
  node.style.transition = "box-shadow .3s ease, filter .3s ease";
  const rect = node.getBoundingClientRect();
  const stageRect = $("galaxy-stage").getBoundingClientRect();
  const startX = rect.left + rect.width / 2 - stageRect.left;
  const startY = rect.top + rect.height / 2 - stageRect.top;
  const startSize = rect.width || CORE_SIZE;
  const endX = _stageCx + entry.x, endY = _stageCy + entry.y;
  const endSize = entry.size;
  const dur = 520 * animK();
  const t0 = performance.now();
  // 恢复期间恢复名字胶囊显示
  if (entry.name) entry.name.classList.remove("hide-on-select");
  entry.__flyAnim = requestAnimationFrame(function tick() {
    const elapsed = performance.now() - t0;
    const p = Math.min(1, elapsed / dur);
    // easeOutCubic：快出慢入，无回弹（回轨不需要 back，避免超出目标位置撞到别人）
    const e = 1 - Math.pow(1 - p, 3);
    const x = startX + (endX - startX) * e;
    const y = startY + (endY - startY) * e;
    const s = startSize + (endSize - startSize) * e;
    node.style.left = x + "px"; node.style.top = y + "px";
    node.style.width = s + "px"; node.style.height = s + "px";
    if (entry.name) {
      entry.name.style.left = x + "px";
      entry.name.style.top = (y + s / 2 + 10) + "px";
    }
    if (p >= 1) {
      entry.__selected = false;   // 物理接管
      node.style.transition = ""; // 恢复默认 CSS transition
      cancelFlyAnim(entry); return;
    }
    entry.__flyAnim = requestAnimationFrame(tick);
  });
}

function cancelFlyAnim(entry) {
  if (entry.__flyAnim) { cancelAnimationFrame(entry.__flyAnim); entry.__flyAnim = 0; }
}
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ══════════ 二级：主题内泳道 ══════════
const ROW_H = 64, COL_W = 60, COL_X0 = 30, TOP_PAD = 24;
const NODE_HALF = 17, RIGHT_PAD = 8;

async function enterTopic(t) {
  ST.level = 2; ST.topic = t.topic;
  document.body.dataset.aiLevel = "2";
  // 综述面板向右缩放关闭
  const card = $("topic-card");
  card.classList.remove("on"); card.classList.add("closing-right");
  setTimeout(() => { card.hidden = true; card.classList.remove("closing-right"); }, 340);
  // 爆炸图最小化消失（缩小淡出）——先去掉平移态，避免与 minimized 的 scale 叠加。
  // 关键：必须同时移除 topic-focus，否则返回一级页面时 CSS 让非选中节点半透明 + pointer-events:none。
  const galaxy = $("ai-galaxy");
  galaxy.classList.remove("card-open", "topic-focus");
  galaxy.classList.add("minimized");
  setTimeout(() => { galaxy.hidden = true; galaxy.classList.remove("minimized"); }, 400);
  Object.values(_galaxyNodes).forEach((e) => {
    e.node.classList.remove("selected");
    if (e.name) e.name.classList.remove("hide-on-select");
    e.__selected = false;   // 物理引擎接管
  });
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
  document.body.dataset.aiLevel = "1";
  // 泳道向左缩小消失、详情向右缩小消失
  const lane = $("ai-lane");
  lane.classList.add("leaving");
  setTimeout(() => { lane.hidden = true; lane.classList.remove("leaving"); }, 360);
  $("ai-back").hidden = true;
  $("header-row2").hidden = true;
  // 爆炸图居中放大回归。兜底：确保没有残留的 topic-focus / card-open 让节点半透明。
  const galaxy = $("ai-galaxy");
  galaxy.classList.remove("card-open", "topic-focus");
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
  document.body.dataset.aiLevel = "1";
  if (typeof renderHeader === "function") renderHeader("ai");
  const devPick = $("device-pick"); if (devPick) devPick.onclick = openDevicePicker;
  $("ai-back").onclick = backToGalaxy;
  $("topic-card-close").onclick = closeTopicCard;
  bindGlobalMenu();
  if (typeof initDebugTag === "function") initDebugTag("front/ai");
  try { const dr = await AI.devices(); ST.devices = dr.devices || []; } catch (_) {}
  updateDeviceLabel();
  // 监听 stage 尺寸：首帧拿到真实尺寸后补一次布局；后续窗口缩放也自动重排。
  // 一级页面才需要，二级页面（hidden）不会触发 observer。
  const stage = $("galaxy-stage");
  if (stage && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { if (ST.level === 1 && !_paused) renderGalaxy(); }).observe(stage);
  }
  // 公转 RAF 只启动一次，之后由 tick 内部判定"是否推进"，不会因 renderGalaxy 重复调用而重置
  startOrbit();
  bindAskWidget();
  await loadGalaxy();
  // 轻量轮询：主题/综述由后台 worker 异步产出，定时刷新一级图（补间过渡）。
  // 打开综述（_paused）或在二级页面时不刷新，避免打断查看。
  setInterval(() => { if (ST.level === 1 && !_paused && !document.hidden) loadGalaxy(); }, 8000);
  // Worker 状态轮询：busy 时给洞察核加 .core-busy 播放脉动波纹（AI 正在处理提示）。
  pollWorkerBusy();
  // 中心洞察节点颜色渐变轮换（用现存主题色做变化源，视觉上"星芒色相在流动"）
  schedulePulseCoreColor();
}

// 中心节点渐变色轮换：JS 逐帧插值 RGB 通道 → 平滑过渡到目标色。
// 每 8s 挑一对新目标色（从现有主题色池里选），过渡时长 4s（easeInOutCubic）。
// 用逐帧插值而非 CSS transition —— radial-gradient/box-shadow 里的 color-mix()
// 在多数浏览器里不做插值（视作离散值），只能靠 JS 每帧 setProperty 才能真平滑。
const _coreColorState = { curA: null, curB: null, fromA: null, fromB: null, toA: null, toB: null, t0: 0, dur: 4000 };
function hexToRgb(hex) {
  if (!hex || hex[0] !== "#") return null;
  const s = hex.length === 4
    ? "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex;
  const r = parseInt(s.slice(1, 3), 16), g = parseInt(s.slice(3, 5), 16), b = parseInt(s.slice(5, 7), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}
function rgbToHex({ r, g, b }) {
  const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
function lerpRgb(a, b, k) {
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

function schedulePulseCoreColor() {
  const core = document.querySelector(".galaxy-core");
  if (!core) return;
  // 初始色对：默认 #9d7bff / #6ea8fe（与 CSS initial-value 一致）
  _coreColorState.curA = hexToRgb("#9d7bff");
  _coreColorState.curB = hexToRgb("#6ea8fe");
  _coreColorState.fromA = _coreColorState.curA;
  _coreColorState.fromB = _coreColorState.curB;
  _coreColorState.toA = _coreColorState.curA;
  _coreColorState.toB = _coreColorState.curB;
  _coreColorState.t0 = performance.now();

  // 每 8s 选新目标（RAF 会自动过渡到它）
  const pickNextTargets = () => {
    if (ST.level !== 1 || document.hidden) return;
    const pool = Object.values(_galaxyNodes).map((e) => e.__color).filter(Boolean);
    if (pool.length < 2) return;
    const a = pool[(Math.random() * pool.length) | 0];
    let b = pool[(Math.random() * pool.length) | 0];
    let tries = 4;
    while (b === a && tries-- > 0) b = pool[(Math.random() * pool.length) | 0];
    const rgbA = hexToRgb(a), rgbB = hexToRgb(b);
    if (!rgbA || !rgbB) return;
    _coreColorState.fromA = { ..._coreColorState.curA };
    _coreColorState.fromB = { ..._coreColorState.curB };
    _coreColorState.toA = rgbA;
    _coreColorState.toB = rgbB;
    _coreColorState.t0 = performance.now();
  };
  setInterval(pickNextTargets, 8000);
  setTimeout(pickNextTargets, 800);   // 首次尽快开始变化

  // RAF：每帧插值 curA/curB → setProperty 到 core 上
  const tick = () => {
    const s = _coreColorState;
    const elapsed = performance.now() - s.t0;
    const raw = Math.min(1, elapsed / s.dur);
    // easeInOutCubic：过渡起止慢、中间快，观感优雅
    const k = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    s.curA = lerpRgb(s.fromA, s.toA, k);
    s.curB = lerpRgb(s.fromB, s.toB, k);
    core.style.setProperty("--core-a", rgbToHex(s.curA));
    core.style.setProperty("--core-b", rgbToHex(s.curB));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 5s 轮询 /worker/status，把 busy 反映到中心「洞察」核上（.core-busy 类）。
async function pollWorkerBusy() {
  const core = document.querySelector(".galaxy-core");
  const tick = async () => {
    try {
      const s = await AI.workerStatus();
      const busy = !!(s && s.busy);
      if (core) core.classList.toggle("core-busy", busy);
    } catch (_) { /* 静默：网络抖动不影响主流程 */ }
  };
  tick();
  setInterval(tick, 5000);
}
// ══════════════════ 左上"提问"按钮：RAG 问答 ══════════════════
// 交互流程：
//   1) 点按钮 → 展开输入面板；输入问题 → 回车/点发送 → 调 /ai/ask/search 拉引用
//   2) 展示引用列表（可勾选/取消，默认全选）→ 点"回答"进入流式阶段
//   3) fetch /ai/ask/stream 用 body 读 SSE，逐 chunk 拼进 markdown 渲染
//   4) 结束后展示复制按钮 + 追加到历史；历史项可复制/删除
function bindAskWidget() {
  const btn = document.getElementById("ask-btn");
  const panel = document.getElementById("ask-panel");
  const input = document.getElementById("ask-input");
  const sendBtn = document.getElementById("ask-send");
  const closeBtn = document.getElementById("ask-close");
  if (!btn || !panel) return;

  function openAsk() {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("on"));
    setTimeout(() => input && input.focus(), 40);
    loadAskHistory();
  }
  function closeAsk() {
    panel.classList.remove("on");
    setTimeout(() => { panel.hidden = true; }, 240);
    cancelStream();
    // 清除 topic-scope（下次点开是通用问答）
    if (input) {
      input.dataset.topicScope = "";
      input.placeholder = "向 AI 提问（会检索历史日志作为参考）…";
    }
  }
  btn.onclick = () => (panel.hidden ? openAsk() : closeAsk());
  closeBtn.onclick = closeAsk;
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); triggerSearch(); }
    else if (ev.key === "Escape") { closeAsk(); }
  });
  sendBtn.onclick = triggerSearch;
}

let _askAbort = null;             // 中断当前流式请求
let _lastQuestion = "";
let _lastRefs = [];               // 从 /ask/search 拿到的 refs

async function triggerSearch() {
  const input = document.getElementById("ask-input");
  const refsBox = document.getElementById("ask-refs");
  const answerBox = document.getElementById("ask-answer");
  const q = (input.value || "").trim();
  if (!q) return;
  _lastQuestion = q;

  // topic-scope：右键触发的主题问答，跳过搜索预览、直接走 stream 传 topic 字段
  const topicScope = input.dataset.topicScope;
  if (topicScope) {
    refsBox.hidden = true;
    startStream(q, null, topicScope);
    return;
  }

  refsBox.hidden = false;
  refsBox.innerHTML = '<div class="ask-refs-loading">正在检索相关日志…</div>';
  answerBox.hidden = true;
  answerBox.querySelector(".ask-answer-body").innerHTML = "";
  answerBox.querySelector(".ask-answer-tools").hidden = true;
  try {
    const r = await AI.askSearch(q, 6);
    if (!r.ok) { refsBox.innerHTML = '<div class="ask-refs-error">' + esc(r.error || "检索失败") + '</div>'; return; }
    _lastRefs = r.refs || [];
    renderRefsPreview(_lastRefs);
  } catch (e) {
    refsBox.innerHTML = '<div class="ask-refs-error">检索失败：' + esc(String(e)) + '</div>';
  }
}

function renderRefsPreview(refs) {
  const refsBox = document.getElementById("ask-refs");
  if (!refs.length) {
    refsBox.innerHTML = '<div class="ask-refs-empty">未找到相关日志（可能是知识库还没建好）。仍可直接生成回答。</div>'
      + '<div class="ask-refs-foot"><button class="ask-mini-btn primary" id="ask-run">直接回答 →</button></div>';
    document.getElementById("ask-run").onclick = () => startStream(_lastQuestion, []);
    return;
  }
  const rows = refs.map((r, i) => {
    const title = esc(r.title || r.source_id || ("引用 " + (i + 1)));
    const meta = [r.topic && "主题《" + r.topic + "》", r.day, r.device].filter(Boolean).join(" · ");
    const preview = esc((r.text || "").slice(0, 180));
    return '<label class="ask-ref-item">'
      + '<input type="checkbox" data-id="' + esc(r.source_id || "") + '" checked>'
      + '<div class="ask-ref-body">'
      +   '<div class="ask-ref-title">' + title + ' <span class="ask-ref-score">' + (r.score || 0).toFixed(2) + '</span></div>'
      +   (meta ? '<div class="ask-ref-meta">' + esc(meta) + '</div>' : '')
      +   '<div class="ask-ref-preview">' + preview + '</div>'
      + '</div></label>';
  }).join("");
  refsBox.innerHTML =
    '<div class="ask-refs-head">找到 ' + refs.length + ' 条相关日志，勾选后作为回答依据：</div>'
    + '<div class="ask-refs-list">' + rows + '</div>'
    + '<div class="ask-refs-foot">'
    +   '<button class="ask-mini-btn primary" id="ask-run">开始回答 →</button>'
    + '</div>';
  document.getElementById("ask-run").onclick = () => {
    const ids = [...refsBox.querySelectorAll('input[type=checkbox]:checked')]
      .map((c) => c.dataset.id).filter(Boolean);
    startStream(_lastQuestion, ids);
  };
}

// 就此主题提问：打开 ask 面板，输入框加上主题上下文占位符，
// 用户输入问题后按 Enter → 调 stream 传 topic 字段（后端会自动装入该主题所有日志）。
function askAboutTopic(topic, color) {
  const btn = document.getElementById("ask-btn");
  const panel = document.getElementById("ask-panel");
  const input = document.getElementById("ask-input");
  if (!panel || !input) return;
  if (panel.hidden) {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("on"));
  }
  input.value = "";
  input.placeholder = `就主题「${topic}」提问…（该主题所有日志会作为上下文）`;
  input.dataset.topicScope = topic;
  input.dataset.topicColor = color || "";
  setTimeout(() => input.focus(), 40);
  // 隐藏搜索预览与旧回答，等用户按回车后 startStream(topic-mode)
  document.getElementById("ask-refs").hidden = true;
  document.getElementById("ask-answer").hidden = true;
  loadAskHistory();
}

async function startStream(question, refIds, topicScope) {
  const answerBox = document.getElementById("ask-answer");
  const body = answerBox.querySelector(".ask-answer-body");
  const tools = answerBox.querySelector(".ask-answer-tools");
  answerBox.hidden = false;
  body.innerHTML = '<div class="ask-answer-typing">生成中…</div>';
  tools.hidden = true;
  cancelStream();
  const ctrl = new AbortController();
  _askAbort = ctrl;
  let full = "";
  try {
    const resp = await fetch("/api/ai/ask/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, ref_ids: refIds, topic: topicScope || null, save: true }),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) {
      body.innerHTML = '<div class="ask-refs-error">请求失败：HTTP ' + resp.status + '</div>';
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 按 SSE 帧分割：以 "\n\n" 分帧，每帧以 "data: " 开头
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = frame.replace(/^data:\s*/m, "").trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.error) { body.innerHTML = '<div class="ask-refs-error">' + esc(obj.error) + '</div>'; return; }
          if (obj.delta) {
            full += obj.delta;
            body.innerHTML = renderMd(full);
          }
          if (obj.done) {
            tools.hidden = false;
            tools.dataset.answer = full;
            renderMermaid(body); renderMath(body);
            loadAskHistory();   // 刷新历史列表
          }
        } catch (_) { /* 忽略解析失败的帧 */ }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    body.innerHTML = '<div class="ask-refs-error">请求异常：' + esc(String(e)) + '</div>';
  } finally {
    _askAbort = null;
  }
}
function cancelStream() { if (_askAbort) { try { _askAbort.abort(); } catch (_) {} _askAbort = null; } }

// 复制当前回答 & 单条历史复制/删除通过事件委托
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-act]"); if (!t) return;
  const act = t.dataset.act;
  if (act === "copy") {
    const src = t.closest(".ask-answer-tools") || t.closest(".ask-history-item");
    const text = src ? (src.dataset.answer || "") : "";
    if (text) { navigator.clipboard.writeText(text).then(() => showToast("已复制", { type: "ok" })); }
  } else if (act === "del") {
    const id = t.dataset.id;
    if (!id) return;
    AI.askHistoryDelete(id).then(() => loadAskHistory());
  }
});

async function loadAskHistory() {
  const box = document.getElementById("ask-history");
  if (!box) return;
  try {
    const r = await AI.askHistory();
    const items = (r.items || []);
    if (!items.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = '<div class="ask-history-head">历史提问（' + items.length + '）</div>'
      + items.map((it) => {
        const time = new Date((it.ts || 0) * 1000).toLocaleString();
        return '<div class="ask-history-item" data-answer="' + esc(it.answer || "") + '">'
          + '<div class="ask-history-q">' + esc(it.question || "") + '</div>'
          + '<div class="ask-history-a md">' + renderMd(it.answer || "") + '</div>'
          + '<div class="ask-history-foot">'
          +   '<span class="ask-history-time">' + esc(time) + '</span>'
          +   '<button class="ask-mini-btn" data-act="copy"><svg class="icon"><use href="#i-copy"></use></svg>复制</button>'
          +   '<button class="ask-mini-btn danger" data-act="del" data-id="' + esc(it.id || "") + '"><svg class="icon"><use href="#i-trash"></use></svg>删除</button>'
          + '</div></div>';
      }).join("");
    box.querySelectorAll(".ask-history-a").forEach((el) => { renderMermaid(el); renderMath(el); });
  } catch (_) {}
}

window.addEventListener("DOMContentLoaded", initAI);
