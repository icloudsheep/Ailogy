// 共享 UI 基建：主题系统、上下文菜单、页面右键菜单、toast、模态输入框。
// 与数据无关，viewer / platform / settings / about 各页面复用。

// ── 主题：style(玻璃/拟态/报纸) × mode(光明/黑暗)，各存 localStorage ──
const STYLE_KEY = "ailogy:style", MODE_KEY = "ailogy:mode";
const _ls = (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } };
const curStyle = () => _ls(STYLE_KEY, "glass");
const curMode = () => _ls(MODE_KEY, "light");
const STYLE_LABEL = { glass: "玻璃", neumorphism: "拟态", newspaper: "报纸" };
const MODE_LABEL = { light: "光明", dark: "黑暗" };

function applyTheme() {
  document.documentElement.setAttribute("data-style", curStyle());
  document.documentElement.setAttribute("data-mode", curMode());
}
function setStyle(key) {
  if (key === curStyle()) return;  // 无变动：不写入、不重绘、不提示
  try { localStorage.setItem(STYLE_KEY, key); } catch (_) {}
  applyTheme();
  showToast(`已切换为「${STYLE_LABEL[key]}」风格`, { title: "主题" });
}
function setMode(key) {
  if (key === curMode()) return;   // 无变动：不写入、不重绘、不提示
  try { localStorage.setItem(MODE_KEY, key); } catch (_) {}
  applyTheme();
  showToast(`已切换为「${MODE_LABEL[key]}」模式`, { title: "主题" });
}

// ── 通用上下文菜单 ──
function closeMenu() { const m = document.getElementById("ctxmenu"); if (m) m.remove(); }
function openMenu(ev, { head, items }) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "ctxmenu"; menu.id = "ctxmenu";
  menu.innerHTML = (head ? `<div class="ctx-head">${head}</div>` : "")
    + items.map((it, i) => it.sep
        ? `<div class="ctx-sep"></div>`
        : `<div class="ctx-item" data-i="${i}">${it.label}${it.check ? '<span class="ck">' + icon("check") + '</span>' : ""}</div>`).join("");
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = ev.clientX, y = ev.clientY;
  if (x + mw + 8 > innerWidth) x = innerWidth - mw - 8;
  if (y + mh + 8 > innerHeight) y = innerHeight - mh - 8;
  menu.style.left = x + "px"; menu.style.top = y + "px";
  menu.style.transformOrigin = `${ev.clientX - x}px ${ev.clientY - y}px`;
  requestAnimationFrame(() => menu.classList.add("on"));
  menu.querySelectorAll(".ctx-item").forEach((el) => {
    el.onclick = () => { const it = items[+el.dataset.i]; closeMenu(); it.act && it.act(); };
  });
}
// 页面级右键菜单：刷新 / 主题切换 / 设置 / 关于（导航 hook 可由各页面覆盖 window.__nav）
function openPageMenu(ev) {
  const st = curStyle(), md = curMode();
  const styleItem = (k, l) => ({ label: l, check: st === k, act: () => setStyle(k) });
  const modeItem = (k, l) => ({ label: l, check: md === k, act: () => setMode(k) });
  const nav = (window.__nav || {});
  const items = [
    { label: icon("refresh") + " 刷新", act: () => location.reload() },
    { sep: true },
    styleItem("glass", icon("glass") + " 玻璃"), styleItem("neumorphism", icon("cube") + " 拟态"), styleItem("newspaper", icon("newspaper") + " 报纸"),
    { sep: true },
    modeItem("light", icon("sun") + " 光明"), modeItem("dark", icon("moon") + " 黑暗"),
    { sep: true },
    { label: icon("gear") + " 设置", act: () => location.href = "/settings" },
    { label: icon("info") + " 关于", act: () => (window.showAbout ? showAbout() : location.href = "/about") },
  ];
  openMenu(ev, { items });
}
// 全局：空白处右键弹页面菜单；点击/Esc/滚动关菜单
function bindGlobalMenu() {
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".chip") || e.target.closest("#stage .node")) return;  // 这些由各自处理
    e.preventDefault(); openPageMenu(e);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".ctxmenu")) closeMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  window.addEventListener("scroll", closeMenu, { passive: true });
}

// ── toast 通知 ──
function showToast(msg, opts) {
  opts = opts || {};
  let wrap = document.getElementById("toast-wrap");
  if (!wrap) { wrap = document.createElement("div"); wrap.id = "toast-wrap"; document.body.appendChild(wrap); }
  const t = document.createElement("div");
  t.className = "toast" + (opts.type === "err" ? " err" : "") + (opts.onClick ? " clickable" : "");
  const title = opts.title || (opts.type === "err" ? "出错了" : "提示");
  t.innerHTML = `<div class="t-title">${esc(title)}</div><div class="t-body">${esc(msg)}</div>`;
  wrap.appendChild(t);
  void t.offsetWidth;
  requestAnimationFrame(() => t.classList.add("on"));
  const dismiss = () => {
    if (t._dismissed) return; t._dismissed = true;
    clearTimeout(t._timer);
    t.classList.remove("on"); t.classList.add("out");
    t.addEventListener("transitionend", (e) => { if (e.propertyName === "max-height") t.remove(); });
    setTimeout(() => t.remove(), 1100);
  };
  if (opts.onClick) t.onclick = () => { opts.onClick(); dismiss(); };
  const dur = opts.duration != null ? opts.duration : 5200;
  if (dur > 0) t._timer = setTimeout(dismiss, dur);
  return t;
}

// ── 居中模态输入框：返回 Promise<string|null> ──
function promptModal({ title, desc, value = "", placeholder = "", okText = "确定", cancelText = "取消" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(title)}</div>
        ${desc ? `<div class="modal-desc">${desc}</div>` : ""}
        <input class="modal-input" type="text" placeholder="${esc(placeholder)}" />
        <div class="modal-actions">
          <button class="modal-btn cancel">${esc(cancelText)}</button>
          <button class="modal-btn ok">${esc(okText)}</button>
        </div></div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".modal-input");
    input.value = value;
    requestAnimationFrame(() => overlay.classList.add("on"));
    setTimeout(() => { input.focus(); input.select(); }, 60);
    let done = false;
    const close = (val) => {
      if (done) return; done = true;
      overlay.classList.remove("on");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => overlay.remove(), 260);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); close(input.value.trim()); }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.querySelector(".ok").onclick = () => close(input.value.trim());
    overlay.querySelector(".cancel").onclick = () => close(null);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
  });
}

// 早期应用主题，避免首屏闪烁（各页面 <head> 里也可内联一份）
applyTheme();

// 页首入场动画播完后立刻清除 body 的 animation，释放 transform 包含块，
// 让所有 position:fixed 子元素（ctxmenu / modal / search / tip）回归相对视口定位
document.body.addEventListener("animationend", function onBodyAnimEnd() {
  document.body.classList.add("page-ready");
  document.body.removeEventListener("animationend", onBodyAnimEnd);
}, { once: true });
// 兜底：万一 animationend 不触发，200ms 后强制清除
setTimeout(() => { document.body.classList.add("page-ready"); }, 400);
