// 设置页：主题/模式选择（复用 ui.js 的 setStyle/setMode），高亮当前项。
function _sync() {
  document.querySelectorAll("#style-row .opt").forEach((b) =>
    b.classList.toggle("on", b.dataset.style === curStyle()));
  document.querySelectorAll("#mode-row .opt").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === curMode()));
}
document.querySelectorAll("#style-row .opt").forEach((b) =>
  b.onclick = () => { setStyle(b.dataset.style); _sync(); });
document.querySelectorAll("#mode-row .opt").forEach((b) =>
  b.onclick = () => { setMode(b.dataset.mode); _sync(); });
_sync();
bindGlobalMenu();
initPageNav("settings");
