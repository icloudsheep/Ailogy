// 公用页头（banner）：所有页面统一使用，含跨页跳转入口（日志/设置/关于）。
const NAV_LINKS = [
  { key: "viewer",   href: "/",         label: "日志", ic: "waves" },
  { key: "ai",       href: "/ai",       label: "智能", ic: "sparkles" },
  { key: "settings", href: "/settings", label: "设置", ic: "gear" },
  { key: "about",    href: "/about",    label: "关于", ic: "info" },
];

function renderHeader(current) {
  const el = document.getElementById("app-header");
  if (!el) return;
  const title = el.dataset.title || "Ailogy";
  const brandIcon = el.dataset.icon ? icon(el.dataset.icon) : "";
  const row2El = el.querySelector("#header-row2");
  const row2HTML = row2El ? row2El.outerHTML : "";
  if (row2El) row2El.remove();
  const slotHTML = el.innerHTML;
  el.classList.add("topbar");
  el.innerHTML =
    `<div class="header-row">`
    + `<a class="brand" href="/">${brandIcon}${title}</a>`
    + `<div class="header-slot">${slotHTML}</div>`
    + `<nav class="header-nav">`
    + NAV_LINKS.map((n) =>
        `<a class="hnav${n.key === current ? " on" : ""}" href="${n.href}" title="${n.label}">`
        + `<span class="emo">${icon(n.ic)}</span><span class="hnav-label">${n.label}</span></a>`).join("")
    + `</nav></div>`
    + row2HTML;
  syncTopbar();
  bindNavTransition();
  // 全局版本更新检测：给"关于"入口加红点 + 首次 toast 提示（updates.js 定义）。
  // updates.js 未被引入时静默跳过；引入了就异步执行。
  if (typeof checkUpdates === "function") checkUpdates();
}

function bindNavTransition() {
  document.querySelectorAll("#app-header a[href]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("http") || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      document.body.classList.add("leaving");
      setTimeout(() => { location.href = href; }, 200);
    });
  });
}

function syncTopbar() {
  const el = document.getElementById("app-header");
  if (!el) return;
  document.documentElement.style.setProperty("--topbar-h", el.offsetHeight + "px");
  // 首次测量落定后再开启「顶栏高度联动」的过渡（padding-top / notice.top / toast.top），
  // 避免 --topbar-h 从默认 150px 校正为实测值时触发一次不必要的抖动动画。
  if (!_tbReady) { _tbReady = true; requestAnimationFrame(() =>
    requestAnimationFrame(() => document.documentElement.classList.add("tb-ready"))); }
}
let _tbReady = false;
window.addEventListener("resize", syncTopbar);
window.addEventListener("scroll", syncTopbar, { passive: true });
// 顶栏高度会随内容（如天/会话胶囊行的出现与换行）变化；用 ResizeObserver 实时回填 --topbar-h，
// 保证 viewer 页「内容滚到 banner 之下」时的顶部留白始终等于当前 banner 高度。
if (window.ResizeObserver) {
  const _ro = new ResizeObserver(() => syncTopbar());
  const _startRO = () => { const el = document.getElementById("app-header"); if (el) _ro.observe(el); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _startRO);
  else _startRO();
}
