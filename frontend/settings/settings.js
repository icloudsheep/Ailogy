// 设置页：主题/模式选择（复用 ui.js 的 setStyle/setMode），高亮当前项。
// 另含泳道页偏好：自动隐藏灰态会话（写 localStorage，viewer 页读取生效）。
const HIDE_GREY_KEY = "ailogy:hideGrey";
function _hideGrey() { try { return localStorage.getItem(HIDE_GREY_KEY) === "1"; } catch (_) { return false; } }
function _sync() {
  document.querySelectorAll("#style-row .opt").forEach((b) =>
    b.classList.toggle("on", b.dataset.style === curStyle()));
  document.querySelectorAll("#mode-row .opt").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === curMode()));
  document.querySelectorAll("#anim-row .opt").forEach((b) =>
    b.classList.toggle("on", b.dataset.anim === curAnim()));
  const hg = document.getElementById("opt-hide-grey");
  if (hg) hg.classList.toggle("on", _hideGrey());
}
document.querySelectorAll("#style-row .opt").forEach((b) =>
  b.onclick = () => { setStyle(b.dataset.style); _sync(); });
document.querySelectorAll("#mode-row .opt").forEach((b) =>
  b.onclick = () => { setMode(b.dataset.mode); _sync(); });
document.querySelectorAll("#anim-row .opt").forEach((b) =>
  b.onclick = () => { setAnim(b.dataset.anim); _sync(); });
const _hg = document.getElementById("opt-hide-grey");
if (_hg) _hg.onclick = () => {
  try { localStorage.setItem(HIDE_GREY_KEY, _hideGrey() ? "0" : "1"); } catch (_) {}
  _sync();
};
_sync();
renderHeader("settings");
bindGlobalMenu();
initDebugTag("front/settings");

// ── 智能（AI）配置：接口/密钥/模型/提示词/RAG，走服务端 prefs（/api/ai/config）──
const AICfg = {
  get: () => fetch("/api/ai/config").then((r) => r.json()),
  put: (patch) => fetch("/api/ai/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) => r.json()),
  resetPrompt: (scene) => fetch("/api/ai/config/reset-prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene }) }).then((r) => r.json()),
  test: () => fetch("/api/ai/test", { method: "POST" }).then((r) => r.json()),
  ragStats: () => fetch("/api/ai/rag/stats").then((r) => r.json()),
};
let _defaultPrompts = {};
const _q = (id) => document.getElementById(id);

function fillAIConfig(cfg) {
  if (!cfg) return;
  _q("ai-base-url").value = cfg.base_url || "";
  _q("ai-chat-model").value = cfg.chat_model || "";
  _q("ai-embed-model").value = cfg.embed_model || "";
  _q("ai-embed-base-url").value = cfg.embed_base_url || "";
  // 密钥输入框留空，仅用 placeholder 提示是否已配置（脱敏值不回填输入框，避免误存掩码）
  const keyEl = _q("ai-api-key");
  keyEl.value = "";
  keyEl.placeholder = cfg.has_key ? `已配置（${cfg.api_key}）· 留空表示不修改` : "sk-…（留空表示不修改）";
  const ekeyEl = _q("ai-embed-api-key");
  ekeyEl.value = "";
  ekeyEl.placeholder = cfg.has_embed_key ? `已配置（${cfg.embed_api_key}）· 留空表示不修改` : "sk-…（留空表示不修改）";
  // 向量入口：复用对话 or 独立
  const useChat = cfg.embed_use_chat !== false;
  _q("ai-embed-use-chat").checked = useChat;
  toggleEmbedShared(useChat);
  const p = cfg.prompts || {};
  document.querySelectorAll(".ai-textarea").forEach((t) => { t.value = p[t.dataset.scene] || ""; });
  if (cfg.default_prompts) _defaultPrompts = cfg.default_prompts;
  if (typeof fillRunParams === "function") fillRunParams(cfg);
}

function toggleEmbedShared(useChat) {
  const card = _q("ai-embed-use-chat") && _q("ai-embed-use-chat").closest(".ai-card");
  if (card) card.classList.toggle("embed-shared", !!useChat);
}

async function loadAIConfig() {
  try { fillAIConfig(await AICfg.get()); } catch (_) {}
  refreshRag();
}
async function refreshRag() {
  try {
    const s = await AICfg.ragStats();
    if (_q("rag-count")) _q("rag-count").textContent = s.count ?? 0;
    if (_q("rag-dim")) _q("rag-dim").textContent = s.dim || "—";
  } catch (_) {}
}

// 复用对话入口开关：即时切显隐（不落库，保存时随配置一起提交）
if (_q("ai-embed-use-chat")) _q("ai-embed-use-chat").onchange = (e) => toggleEmbedShared(e.target.checked);

if (_q("ai-save")) _q("ai-save").onclick = async () => {
  const patch = {
    base_url: _q("ai-base-url").value.trim(),
    chat_model: _q("ai-chat-model").value.trim(),
    embed_model: _q("ai-embed-model").value.trim(),
    embed_use_chat: _q("ai-embed-use-chat").checked,
    embed_base_url: _q("ai-embed-base-url").value.trim(),
  };
  const key = _q("ai-api-key").value;
  if (key) patch.api_key = key;   // 空则不改
  const ekey = _q("ai-embed-api-key").value;
  if (ekey) patch.embed_api_key = ekey;
  try { fillAIConfig(await AICfg.put(patch)); showToast("已保存 AI 配置", { title: "智能" }); }
  catch (err) { showToast("保存失败：" + err.message, { type: "err" }); }
};

// 终端窗口：逐行打印测试回传，命令行风格
function consoleReset() {
  const box = _q("ai-console"), body = _q("ai-console-body");
  if (body) body.innerHTML = "";
  if (box) box.classList.add("open");   // 触发展开动画（grid-rows 0fr→1fr）
}
function consoleLine(tag, msg) {
  const body = _q("ai-console-body");
  if (!body) return;
  const prefix = { cmd: "$ ", ok: "✓ ", err: "✗ ", info: "", dim: "  ", done: "» " }[tag] || "";
  const el = document.createElement("span");
  el.className = "cl cl-" + tag;
  el.textContent = prefix + msg + "\n";
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}
if (_q("ai-console-close")) _q("ai-console-close").onclick = () => { _q("ai-console").classList.remove("open"); };

if (_q("ai-test")) _q("ai-test").onclick = async () => {
  const st = _q("ai-status");
  const btn = _q("ai-test");
  st.textContent = ""; st.className = "ai-status";
  btn.disabled = true;
  consoleReset();
  consoleLine("dim", "正在发起真实探测请求…");
  try {
    const r = await AICfg.test();
    // 逐行动画打印后端返回的日志
    const lines = r.log || [];
    for (let i = 0; i < lines.length; i++) {
      await new Promise((res) => setTimeout(res, 90));
      consoleLine(lines[i].tag, lines[i].msg);
    }
    st.textContent = r.ok ? "连接正常 ✓" : "存在失败项 ✗";
    st.classList.add(r.ok ? "ok" : "err");
    refreshRag();   // 探测可能回填了维度
  } catch (err) {
    consoleLine("err", "请求失败：" + err.message);
    st.textContent = "测试失败"; st.classList.add("err");
  } finally { btn.disabled = false; }
};

if (_q("ai-save-prompts")) _q("ai-save-prompts").onclick = async () => {
  const prompts = {};
  document.querySelectorAll(".ai-textarea").forEach((t) => { prompts[t.dataset.scene] = t.value; });
  try { fillAIConfig(await AICfg.put({ prompts })); showToast("已保存系统提示词", { title: "智能" }); }
  catch (err) { showToast("保存失败：" + err.message, { type: "err" }); }
};

document.querySelectorAll(".ai-reset").forEach((btn) => {
  btn.onclick = async () => {
    const scene = btn.dataset.scene;
    try { fillAIConfig(await AICfg.resetPrompt(scene)); showToast("已恢复默认提示词", { title: "智能" }); }
    catch (err) { showToast("恢复失败：" + err.message, { type: "err" }); }
  };
});

loadAIConfig();

// ── iPad 式主从导航：左侧大类切换右侧面板；选中项固化到 localStorage，刷新保持 ──
const CAT_KEY = "ailogy:settingsCat";
function showCat(cat) {
  document.querySelectorAll("#settings-nav .snav").forEach((b) =>
    b.classList.toggle("on", b.dataset.cat === cat));
  document.querySelectorAll(".settings-panel").forEach((p) =>
    p.classList.toggle("on", p.dataset.cat === cat));
  try { localStorage.setItem(CAT_KEY, cat); } catch (_) {}
}
document.querySelectorAll("#settings-nav .snav").forEach((b) =>
  b.onclick = () => showCat(b.dataset.cat));
{
  let cat = "style";
  try { cat = localStorage.getItem(CAT_KEY) || "style"; } catch (_) {}
  if (!document.querySelector(`.settings-panel[data-cat="${cat}"]`)) cat = "style";
  showCat(cat);
}

// ── 智能子类二级导航：模型 / 提示词 / 知识库 ──
const SUB_KEY = "ailogy:aiSub";
function showSub(sub) {
  document.querySelectorAll("#ai-subnav .ai-subtab").forEach((b) =>
    b.classList.toggle("on", b.dataset.sub === sub));
  document.querySelectorAll(".ai-sub").forEach((p) =>
    p.classList.toggle("on", p.dataset.sub === sub));
  try { localStorage.setItem(SUB_KEY, sub); } catch (_) {}
}
document.querySelectorAll("#ai-subnav .ai-subtab").forEach((b) =>
  b.onclick = () => showSub(b.dataset.sub));
{
  let sub = "model";
  try { sub = localStorage.getItem(SUB_KEY) || "model"; } catch (_) {}
  if (!document.querySelector(`.ai-sub[data-sub="${sub}"]`)) sub = "model";
  showSub(sub);
}

// ══════════ 运行子类：参数 / 实时状态 / 失败重试 / 重置 ══════════
const RunAPI = {
  status: (after) => fetch("/api/ai/worker/status?log_after=" + (after || 0)).then((r) => r.json()),
  retry: (client_id) => fetch("/api/ai/worker/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id }) }).then((r) => r.json()),
  resetCls: () => fetch("/api/ai/reset/classification", { method: "POST" }).then((r) => r.json()),
  resetEmb: () => fetch("/api/ai/reset/embeddings", { method: "POST" }).then((r) => r.json()),
};

// 把运行参数填进表单（从 /api/ai/config 已取到的 cfg）
function fillRunParams(cfg) {
  if (!cfg) return;
  if (_q("ai-worker-enabled")) _q("ai-worker-enabled").checked = cfg.worker_enabled !== false;
  if (_q("ai-batch-size")) _q("ai-batch-size").value = cfg.batch_size || 20;
  if (_q("ai-poll-interval")) _q("ai-poll-interval").value = cfg.poll_interval || 20;
  if (_q("ai-retry-limit")) _q("ai-retry-limit").value = cfg.retry_limit != null ? cfg.retry_limit : 1;
  if (_q("ai-recompute")) _q("ai-recompute").value = cfg.recompute_on_update || "embed";
}

if (_q("ai-save-run")) _q("ai-save-run").onclick = async () => {
  const patch = {
    worker_enabled: _q("ai-worker-enabled").checked,
    batch_size: parseInt(_q("ai-batch-size").value, 10) || 20,
    poll_interval: parseInt(_q("ai-poll-interval").value, 10) || 20,
    retry_limit: parseInt(_q("ai-retry-limit").value, 10) || 0,
    recompute_on_update: _q("ai-recompute").value,
  };
  try { await AICfg.put(patch); showToast("已保存运行参数", { title: "智能" }); }
  catch (err) { showToast("保存失败：" + err.message, { type: "err" }); }
};

// 折叠终端
if (_q("run-console-toggle")) _q("run-console-toggle").onclick = () => {
  _q("run-console").classList.toggle("open");
};
function runConsoleLine(tag, msg) {
  const body = _q("run-console-body"); if (!body) return;
  const prefix = { ok: "✓ ", err: "✗ ", info: "» ", done: "✔ ", cmd: "$ " }[tag] || "  ";
  const el = document.createElement("span"); el.className = "cl cl-" + tag;
  el.textContent = prefix + msg + "\n"; body.appendChild(el);
  while (body.childElementCount > 300) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

// 每秒轮询 worker 状态：更新徽标/进度/token/终端/失败列表；忙时弹无限加载 toast 并每秒刷新 token
let _runLogAfter = 0, _runToast = null, _runTimer = 0;
const _tok = (n) => fmtTok(n || 0) || "0";   // 复用 utils.js 的 fmtTok，空值兜底为 "0"
async function pollWorker() {
  let r;
  try { r = await RunAPI.status(_runLogAfter); } catch (_) { return; }
  const s = r.status || {}, q = r.queue || {}, failed = r.failed || [];
  // 队列 + token 概况
  if (_q("run-pending")) _q("run-pending").textContent = q.pending || 0;
  if (_q("run-paused")) _q("run-paused").textContent = q.paused || 0;
  if (_q("run-tok-in")) _q("run-tok-in").textContent = _tok(s.tokens_in);
  if (_q("run-tok-out")) _q("run-tok-out").textContent = _tok(s.tokens_out);
  // 徽标 + 进度
  const badge = _q("ai-run-badge"), prog = _q("ai-run-progress");
  const PHASE = { embed: "向量化", classify: "分类", summarize: "主题综述", delete: "清理", starting: "启动", idle: "空闲" };
  if (badge) { badge.textContent = s.busy ? (PHASE[s.phase] || "运行中") : "空闲"; badge.classList.toggle("busy", !!s.busy); }
  if (prog) {
    prog.hidden = !s.busy;
    if (s.busy) {
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      _q("ai-run-bar").style.width = pct + "%";
      _q("ai-run-phase").textContent = `${PHASE[s.phase] || s.phase} · ${s.done}/${s.total}` + (s.current ? ` · ${s.current}` : "");
    }
  }
  // 增量日志入终端
  (s.log || []).forEach((ln) => { runConsoleLine(ln.tag, ln.msg); _runLogAfter = Math.max(_runLogAfter, ln.ts); });
  if ((s.log || []).length && !_q("run-console").classList.contains("open")) _q("run-console").classList.add("open");
  // 失败列表
  const fcard = _q("ai-failed-card");
  if (fcard) {
    fcard.hidden = failed.length === 0;
    const list = _q("ai-failed-list");
    if (list) list.innerHTML = failed.map((f) => `<div class="ai-failed-item">
      <div class="ai-failed-info"><span class="ai-failed-title">${esc(f.title || f.client_id)}</span>
        <span class="ai-failed-err">${esc((f.last_error || "").slice(0, 80))}</span></div>
      <button class="ai-reset ai-retry-one" data-cid="${esc(f.client_id)}">重试</button></div>`).join("");
    if (list) list.querySelectorAll(".ai-retry-one").forEach((b) => b.onclick = async () => {
      await RunAPI.retry(b.dataset.cid); showToast("已重试", { title: "智能" }); });
  }
  // 忙时无限加载 toast，每秒刷新 token；空闲则收起
  if (s.busy) {
    const body = `处理中 ${s.done}/${s.total} · ↑${_tok(s.tokens_in)} ↓${_tok(s.tokens_out)} token`;
    if (!_runToast || _runToast._dismissed) _runToast = showToast(body, { title: "AI 处理中", loading: true });
    else _runToast.update(body, "AI 处理中·" + (PHASE[s.phase] || s.phase));
  } else if (_runToast && !_runToast._dismissed) {
    _runToast.update(`本轮完成 · 累计 ↑${_tok(s.tokens_in)} ↓${_tok(s.tokens_out)} token`, "AI 处理完成");
    setTimeout(() => { if (_runToast) _runToast.dismiss(); _runToast = null; }, 1500);
  }
}

if (_q("ai-retry-all")) _q("ai-retry-all").onclick = async () => {
  try { const r = await RunAPI.retry(null); showToast(`已重试 ${r.retried} 项`, { title: "智能" }); }
  catch (err) { showToast("重试失败：" + err.message, { type: "err" }); }
};
if (_q("ai-reset-cls")) _q("ai-reset-cls").onclick = async () => {
  const v = await promptModal({ title: "重置主题分类 + 综述", desc: "将清空所有主题分类与综述，并按当前模型/提示词<b>全量重跑</b>。<br>输入 <b>重置</b> 确认：", placeholder: "重置" });
  if (v === null) return;
  if (v.trim() !== "重置") { showToast("已取消（未输入“重置”）", { title: "智能" }); return; }
  try { const r = await RunAPI.resetCls(); showToast(`已重置，${r.enqueued} 条待重新分类`, { title: "智能" }); }
  catch (err) { showToast("重置失败：" + err.message, { type: "err" }); }
};
if (_q("ai-reset-emb")) _q("ai-reset-emb").onclick = async () => {
  const v = await promptModal({ title: "重置向量知识库", desc: "将清空全部向量，并按当前向量模型<b>全量重新嵌入</b>。<br>输入 <b>重置</b> 确认：", placeholder: "重置" });
  if (v === null) return;
  if (v.trim() !== "重置") { showToast("已取消（未输入“重置”）", { title: "智能" }); return; }
  try { const r = await RunAPI.resetEmb(); showToast(`已重置，${r.enqueued} 条待重新嵌入`, { title: "智能" }); }
  catch (err) { showToast("重置失败：" + err.message, { type: "err" }); }
};

// 启动每秒轮询（全程运行，以便 worker 忙时随处都能弹加载 toast）
_runTimer = setInterval(pollWorker, 1000);
pollWorker();

// ═════════ 关于（版本 & 自动更新）═════════
const UpdAPI = {
  info: () => fetch("/api/updates").then((r) => r.json()),
  settingsGet: () => fetch("/api/updates/settings").then((r) => r.json()),
  settingsPut: (autoUpdate) => fetch("/api/updates/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auto_update: !!autoUpdate }),
  }).then((r) => r.json()),
  install: (tag) => fetch("/api/updates/install", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tag ? { tag } : {}),
  }).then((r) => r.json()),
  status: () => fetch("/api/updates/status").then((r) => r.json()),
};

let _updInstallTimer = 0;

async function loadUpdatesTab() {
  try {
    const info = await UpdAPI.info();
    document.getElementById("upd-current").textContent = info.current || "未知";
    const auto = !!info.auto_update;
    document.getElementById("upd-auto").checked = auto;
    const latestEl = document.getElementById("upd-latest");
    const metaEl = document.getElementById("upd-latest-meta");
    const installBtn = document.getElementById("upd-install");
    if (info.latest && info.latest.tag) {
      latestEl.textContent = info.latest.tag + (info.has_update ? "（可更新）" : "（已是最新）");
      const pub = info.latest.published_at ? new Date(info.latest.published_at).toLocaleDateString() : "";
      metaEl.textContent = [pub && "发布于 " + pub, info.latest.name].filter(Boolean).join(" · ");
      installBtn.hidden = !info.has_update;
    } else {
      latestEl.textContent = "暂无正式发布";
      metaEl.textContent = info.error || "";
      installBtn.hidden = true;
    }
  } catch (e) {
    document.getElementById("upd-latest").textContent = "检查失败：" + String(e);
  }
}

document.getElementById("upd-check").onclick = () => {
  document.getElementById("upd-latest").textContent = "检查中…";
  loadUpdatesTab();
};

document.getElementById("upd-auto").addEventListener("change", async (ev) => {
  const on = ev.target.checked;
  try {
    await UpdAPI.settingsPut(on);
    showToast(on ? "已开启自动更新" : "已关闭自动更新", { type: "ok" });
  } catch (e) {
    ev.target.checked = !on;
    showToast("保存失败：" + String(e), { type: "err" });
  }
});

document.getElementById("upd-install").onclick = async () => {
  const ok = confirm("立即从 GitHub 下载最新版本并覆盖本地文件？服务会自动尝试重启。");
  if (!ok) return;
  const r = await UpdAPI.install();
  if (!r.ok) { showToast(r.error || "触发失败", { type: "err" }); return; }
  showToast("开始更新：" + r.target, { type: "ok" });
  pollUpdInstall();
};

function pollUpdInstall() {
  clearInterval(_updInstallTimer);
  const box = document.getElementById("upd-progress");
  const fill = document.getElementById("upd-progress-fill");
  const text = document.getElementById("upd-progress-text");
  box.hidden = false;
  const tick = async () => {
    let s;
    try { s = await UpdAPI.status(); } catch (_) { return; }
    fill.style.width = (s.progress || 0) + "%";
    const label = { idle: "空闲", downloading: "下载中", extracting: "解压中",
      applying: "应用文件", done: "重启中…", needs_restart: "需手动重启", error: "失败" }[s.phase] || s.phase;
    text.textContent = label + (s.message ? " · " + s.message : "") + (s.error ? " · " + s.error : "");
    if (s.phase === "done") {
      // 服务可能任何一秒 exec 重启；轮询状态失败即视为重启成功
      setTimeout(() => location.reload(), 3000);
    }
    if (s.phase === "error" || s.phase === "needs_restart") {
      clearInterval(_updInstallTimer);
    }
  };
  _updInstallTimer = setInterval(tick, 1000);
  tick();
}

// 切到"关于"分类时自动加载
const _origShowCat = showCat;
showCat = function (cat) {
  _origShowCat(cat);
  if (cat === "about") loadUpdatesTab();
};
