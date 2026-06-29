// ── KaTeX 公式渲染 ─────────────────────────────────────────────
// 与 mermaid 同构：库可能异步到达（本地或 CDN 回退）。renderMath 把详情面板里
// 的 .math-block / .math-inline 占位（data-src 存源码）就地渲染为公式；库未到则挂起，
// __katexReady 回调或 load 后补渲染。失败回退红色源码，不影响其余正文。
let _katexPending = false;
function renderMath(scope) {
  const root = scope || document;
  const nodes = root.querySelectorAll(".math-block:not([data-done]), .math-inline:not([data-done])");
  if (!nodes.length) return;
  if (typeof window.katex === "undefined") { _katexPending = true; return; }  // 库未到，待回调补渲染
  for (const el of nodes) {
    const src = el.getAttribute("data-src") || "";
    el.setAttribute("data-done", "1");
    el.removeAttribute("data-failed");
    try {
      window.katex.render(src, el, {
        displayMode: el.classList.contains("math-block"),
        throwOnError: false, output: "html",
      });
    } catch (e) {
      el.setAttribute("data-failed", "1");
      el.textContent = (el.classList.contains("math-block") ? "$$" : "$") + src + (el.classList.contains("math-block") ? "$$" : "$");
    }
  }
}
window.__katexReady = function () { _katexPending = false; renderMath(); };
window.addEventListener("load", () => { if (_katexPending || document.querySelector(".math-block:not([data-done]), .math-inline:not([data-done])")) renderMath(); });

