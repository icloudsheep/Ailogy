// 公用页头（banner）：所有页面统一使用，含跨页跳转入口（瀑布流/密钥/设置/关于）。
// 用法：在 <body> 放 <header id="app-header" data-title="🗓️ Ailogy"></header>，引入本脚本后自动填充。
// 额外内容（如搜索框、视图按钮）由各页面在 header 内预置的 [data-slot] 容器里放。

const NAV_LINKS = [
  { key: "viewer",   href: "/",         label: "瀑布流", emo: "🌊" },
  { key: "account",  href: "/account",  label: "账户",   emo: "👤" },
  { key: "platform", href: "/platform", label: "密钥",   emo: "🔑" },
  { key: "settings", href: "/settings", label: "设置",   emo: "⚙️" },
  { key: "about",    href: "/about",    label: "关于",   emo: "ℹ️" },
];

function renderHeader(current) {
  const el = document.getElementById("app-header");
  if (!el) return;
  const title = el.dataset.title || "🗓️ Ailogy";
  // 第二行：页面可预置 <div id="header-row2">（如天/会话选择器），整体保留并置于顶行下方
  const row2El = el.querySelector("#header-row2");
  const row2HTML = row2El ? row2El.outerHTML : "";
  if (row2El) row2El.remove();
  const slotHTML = el.innerHTML;  // 顶行中部槽内容（如月份/搜索）
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
  window.addEventListener("resize", syncTopbar);
  bindNavTransition();
}

// 同源页面跳转加离场动画：拦截 .hnav / brand 点击，body 淡出后再跳
function bindNavTransition() {
  document.querySelectorAll("#app-header a[href]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("http") || e.metaKey || e.ctrlKey) return;  // 外链/新标签不拦
      e.preventDefault();
      document.body.classList.add("leaving");
      setTimeout(() => { location.href = href; }, 200);  // 与 .leaving 过渡同长
    });
  });
}

// 把页头实际高度写入 --topbar-h，供 .caps / .left 等 sticky 元素精确贴合（避免硬编码间隔）
function syncTopbar() {
  const el = document.getElementById("app-header");
  if (!el) return;
  document.documentElement.style.setProperty("--topbar-h", el.offsetHeight + "px");
}
