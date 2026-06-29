// 瀑布流主逻辑：三视图（全量/按日期/按 session）无限下滑、卡片渲染、详情展开、搜索。
// 复用 shared/js 的纯渲染：renderMd / renderMermaid / renderMath / fmt*。

// ── 会话配色：按 session_code 稳定分配调色板色 ──
const _colorMap = {};
let _colorIdx = 0;
function colorOf(code) {
  if (!(code in _colorMap)) _colorMap[code] = PALETTE[_colorIdx++ % PALETTE.length];
  return _colorMap[code];
}

// ── 视图状态机 ──
const state = {
  view: "all",          // all | day | session
  cursor: null,
  loading: false,
  done: false,
  lastDay: null,        // 按日期视图：插日期分隔头用
  curSession: null,     // 按 session 视图：当前展开的会话；null=显示会话列表
};

const feed = () => document.getElementById("feed");
const sentinel = () => document.getElementById("sentinel");

// ── 一条日志卡片 ──
function entryCard(e) {
  const c = colorOf(e.session_code);
  const title = e.title ? esc(e.title) : esc(e.name || e.session_code);
  const u = e.usage;
  const usageLine = u
    ? `<span class="c-meta">📊 ${fmtTok(u.input)}↓ ${fmtTok(u.output)}↑ · ${u.turns ?? "?"}轮</span>` : "";
  const dur = e.duration ? `<span class="c-meta">⏱ ${fmtDur(e.duration)}</span>` : "";
  const branch = e.branch ? `<span class="c-meta">🌿 ${esc(e.branch)}</span>` : "";
  const carry = e.carryover
    ? `<div class="c-carry">🌙 接续自 ${esc(e.carryover.prev_date)}</div>` : "";
  const rocket = e.mode === "full" ? "🚀 " : "";
  return `<article class="card" data-id="${e.id}" style="--c:${c}">
    <div class="c-head">
      <span class="c-emo">${e.emoji || "📝"}</span>
      <span class="c-title">${rocket}${title}</span>
      <span class="c-seq">#${e.seq}</span>
    </div>
    <div class="c-sub">${esc(e.name || e.session_code)} · ${esc(fmtAt(e.datetime))}</div>
    ${carry}
    <div class="c-body md">${renderMd(e.summary || "")}</div>
    <div class="c-foot">${dur}${branch}${usageLine}
      ${e.project ? `<span class="c-meta">📁 ${esc(e.project)}</span>` : ""}
      ${e.model ? `<span class="c-meta">🤖 ${esc(e.model)}</span>` : ""}
    </div>
  </article>`;
}

// 按日期视图：跨天时插一个日期分隔头
function dayHeader(day) {
  return `<div class="day-sep">🗓️ ${esc(day)}</div>`;
}

// 把一批 items 追加渲染到 feed，并渲染其中的 mermaid/公式
function appendEntries(items) {
  const frag = [];
  for (const e of items) {
    if (state.view === "day" && e.day !== state.lastDay) {
      frag.push(dayHeader(e.day));
      state.lastDay = e.day;
    }
    frag.push(entryCard(e));
  }
  feed().insertAdjacentHTML("beforeend", frag.join(""));
  renderMermaid(feed());
  renderMath(feed());
}

// ── 加载下一页 ──
async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  setStatus("加载中…");
  try {
    if (state.view === "session" && !state.curSession) {
      // 按 session 视图第一层：会话列表
      const r = await API.sessions({ cursor: state.cursor });
      appendSessions(r.items);
      state.cursor = r.next_cursor;
    } else {
      const r = await API.entries({
        view: state.view,
        sessionCode: state.curSession,
        cursor: state.cursor,
      });
      appendEntries(r.items);
      state.cursor = r.next_cursor;
    }
    if (!state.cursor) { state.done = true; setStatus("到底了"); }
    else setStatus("");
  } catch (err) {
    if (err instanceof AuthError) {
      state.done = true;
      feed().innerHTML = `<div class="auth-gate">
        <p>需要登录后查看你的日志。</p>
        <a class="gate-btn" href="/platform">前往登录 / 注册 →</a></div>`;
      setStatus("");
    } else {
      setStatus("加载失败：" + err.message);
    }
  } finally {
    state.loading = false;
  }
}

// 按 session 视图第一层：会话卡片列表，点击进入该会话
function appendSessions(items) {
  const html = items.map((s) => {
    const c = colorOf(s.session_code);
    return `<div class="sess-card" data-code="${esc(s.session_code)}" style="--c:${c}">
      <span class="c-emo">${s.emoji || "📝"}</span>
      <span class="sess-name">${esc(s.name || s.session_code)}</span>
      <span class="sess-cnt">${s.cnt} 条</span>
      <span class="c-meta">最近 ${esc(fmtAt(s.last_activity))}</span>
    </div>`;
  }).join("");
  feed().insertAdjacentHTML("beforeend", html);
  feed().querySelectorAll(".sess-card:not([data-bound])").forEach((el) => {
    el.dataset.bound = "1";
    el.onclick = () => enterSession(el.dataset.code, el.querySelector(".sess-name").textContent);
  });
}

function enterSession(code, name) {
  state.curSession = code;
  resetFeed();
  document.getElementById("sess-crumb").hidden = false;
  document.getElementById("sess-crumb-name").textContent = name;
  loadMore();
}

function leaveSession() {
  state.curSession = null;
  document.getElementById("sess-crumb").hidden = true;
  resetFeed();
  loadMore();
}

// ── 视图切换 ──
function switchView(view) {
  if (view === state.view && !state.curSession) return;
  state.view = view;
  state.curSession = null;
  document.getElementById("sess-crumb").hidden = true;
  document.querySelectorAll(".view-tab").forEach((t) =>
    t.classList.toggle("on", t.dataset.view === view));
  resetFeed();
  loadMore();
}

function resetFeed() {
  state.cursor = null; state.done = false; state.lastDay = null;
  feed().innerHTML = "";
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

// ── 初始化 ──
function initViewer() {
  // 公开分享模式：隐藏视图切换与搜索（只读单一 scope 的全量流）
  if (API.shareMode()) {
    document.querySelector(".views")?.setAttribute("hidden", "");
    document.querySelector(".search-box")?.setAttribute("hidden", "");
    document.querySelector("h1").textContent = "🔗 Ailogy · 分享";
  }
  // 视图切换标签
  document.querySelectorAll(".view-tab").forEach((t) => {
    t.onclick = () => switchView(t.dataset.view);
  });
  document.getElementById("sess-back").onclick = leaveSession;
  // 触底加载
  const io = new IntersectionObserver((ents) => {
    if (ents[0].isIntersecting) loadMore();
  }, { rootMargin: "400px" });
  io.observe(sentinel());
  loadMore();
}

window.addEventListener("DOMContentLoaded", initViewer);
