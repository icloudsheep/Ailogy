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
