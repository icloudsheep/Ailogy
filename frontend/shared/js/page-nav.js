// 左下角页面指示胶囊：标出当前所处页面，可点击导航；仅管理员可见。
// 各页面引入后调 initPageNav('当前页 key')。普通用户不渲染（仅管理员有跨页导航需求）。

const _PAGES = [
  { key: "viewer",   emo: "🌊", label: "瀑布流", href: "/" },
  { key: "platform", emo: "🔑", label: "密钥平台", href: "/platform" },
  { key: "settings", emo: "⚙️", label: "设置", href: "/settings" },
  { key: "about",    emo: "ℹ️", label: "关于", href: "/about" },
];

async function initPageNav(current) {
  if (document.querySelector(".page-nav")) return;  // 已渲染，避免重复
  // 仅管理员可见：查 /api/auth/me
  let me = null;
  try {
    const r = await fetch("/api/auth/me", { credentials: "include" });
    if (r.ok) me = await r.json();
  } catch (_) {}
  if (!me || !me.is_admin) return;  // 非管理员不渲染

  const nav = document.createElement("div");
  nav.className = "page-nav";
  nav.innerHTML = _PAGES.map((p) =>
    `<a class="pagecap${p.key === current ? " on" : ""}" href="${p.href}" data-key="${p.key}">
       <span class="emo">${p.emo}</span>${p.label}</a>`).join("");
  document.body.appendChild(nav);
  // 胶囊右键也弹页面菜单（主题/设置/关于）
  nav.querySelectorAll(".pagecap").forEach((el) => {
    el.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation();
      if (window.openPageMenu) openPageMenu(ev); };
  });
}
