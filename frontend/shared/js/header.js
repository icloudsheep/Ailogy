// 公用页头（banner）：所有页面统一使用，含跨页跳转入口（瀑布流/设置/关于）。
const NAV_LINKS = [
  { key: "viewer",   href: "/",         label: "瀑布流", emo: "🌊" },
  { key: "settings", href: "/settings", label: "设置",   emo: "⚙️" },
  { key: "about",    href: "/about",    label: "关于",   emo: "ℹ️" },
];

function renderHeader(current) {
  const el = document.getElementById("app-header");
  if (!el) return;
  const title = el.dataset.title || "🗓️ Ailogy";
  const row2El = el.querySelector("#header-row2");
  const row2HTML = row2El ? row2El.outerHTML : "";
  if (row2El) row2El.remove();
  const slotHTML = el.innerHTML;
  el.classList.add("topbar");
  el.innerHTML =
    `<div class="header-row">`
    + `<a class="brand" href="/">${title}</a>`
    + `<div class="header-slot">${slotHTML}</div>`
    + `<nav class="header-nav">`
    + NAV_LINKS.map((n) =>
        `<a class="hnav${n.key === current ? " on" : ""}" href="${n.href}" title="${n.label}">`
        + `<span class="emo">${n.emo}</span><span class="hnav-label">${n.label}</span></a>`).join("")
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
