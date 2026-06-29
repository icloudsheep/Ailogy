// 左下角调试标识：半透明小字，标注当前页面所属部分（如 front/viewer），仅供开发调试定位。
// 仅管理员可见（查 /api/auth/me）。这不是导航——跨页跳转走页头 banner。

async function initDebugTag(pathLabel) {
  if (document.querySelector(".debug-tag")) return;
  let me = null;
  try {
    const r = await fetch("/api/auth/me", { credentials: "include" });
    if (r.ok) me = await r.json();
  } catch (_) {}
  if (!me || !me.is_admin) return;  // 非管理员不显示
  const tag = document.createElement("div");
  tag.className = "debug-tag";
  tag.textContent = pathLabel;  // 如 "front/viewer"
  document.body.appendChild(tag);
}
