// 公用页头（banner）：所有页面统一使用，含跨页跳转入口（瀑布流/密钥/设置/关于）。
// 用法：在 <body> 放 <header id="app-header" data-title="🗓️ Ailogy"></header>，引入本脚本后自动填充。
// 额外内容（如搜索框、视图按钮）由各页面在 header 内预置的 [data-slot] 容器里放。

const NAV_LINKS = [
  { key: "viewer",   href: "/",         label: "瀑布流", emo: "🌊" },
  { key: "platform", href: "/platform", label: "密钥",   emo: "🔑" },
  { key: "settings", href: "/settings", label: "设置",   emo: "⚙️" },
  { key: "about",    href: "/about",    label: "关于",   emo: "ℹ️" },
];

function renderHeader(current) {
  const el = document.getElementById("app-header");
  if (!el) return;
  const title = el.dataset.title || "🗓️ Ailogy";
  const slotHTML = el.innerHTML;  // 页面预置的中间槽内容（如搜索框）保留
  el.classList.add("topbar");
  el.innerHTML =
    `<a class="brand" href="/">${title}</a>`
    + `<div class="header-slot">${slotHTML}</div>`
    + `<nav class="header-nav">`
    + NAV_LINKS.map((n) =>
        `<a class="hnav${n.key === current ? " on" : ""}" href="${n.href}" title="${n.label}">`
        + `<span class="emo">${n.emo}</span><span class="hnav-label">${n.label}</span></a>`).join("")
    + `</nav>`;
}
