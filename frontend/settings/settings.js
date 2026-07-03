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
