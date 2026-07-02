// 公用页头（banner）：所有页面统一使用，含跨页跳转入口（日志/设置/关于）。
const NAV_LINKS = [
  { key: "viewer",   href: "/",         label: "日志", ic: "waves" },
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
}
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
