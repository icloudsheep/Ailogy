// ── mermaid 渲染 ───────────────────────────────────────────────
// 库可能异步到达（本地或 CDN 回退）。就绪前先记一个 pending 标记，
// 到位后初始化并补渲染当前详情面板里的 .mermaid 图。
let _mermaidInited = false, _mermaidPending = false;
// 确保 mermaid 已初始化，返回「现在是否可用于渲染」：
// 已初始化 → 直接 true；未初始化但库已到 → 初始化后 true；库未到 → false。
// 注意：不能写成「if (_mermaidInited) return false」——那会让已就绪的库被误判为不可用，
// 导致除首次外每次渲染都被跳过（首次成功、后续必败、刷新重置的根因）。
function initMermaid() {
  if (_mermaidInited) return true;
  if (typeof window.mermaid === "undefined") return false;
  try {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose",
      theme: "neutral",
      // useMaxWidth:false → svg 保持自然尺寸不被压缩，超宽时由容器横向滚动承载（见 .mermaid CSS）
      flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false }, er: { useMaxWidth: false } });
    _mermaidInited = true;
  } catch (_) { return false; }
  return true;
}
async function renderMermaid(scope) {
  const root = scope || document;
  const nodes = root.querySelectorAll(".mermaid:not([data-done])");
  if (!nodes.length) return;
  if (!initMermaid()) { _mermaidPending = true; return; }  // 库未到，待回调补渲染
  for (const el of nodes) {
    const src = el.getAttribute("data-src") || el.textContent;
    el.setAttribute("data-src", src);                       // 留存源码以便重渲染
    el.setAttribute("data-done", "1");
    el.removeAttribute("data-failed");
    // mermaid v11 的 render 首次偶发抛错（DOM/字体测量时机），重试一次多能成功，
    // 与「刷新后有概率生效」现象吻合。两次都失败才回退源码文本。
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const id = "mmd-" + Math.random().toString(36).slice(2, 9);
        const { svg } = await window.mermaid.render(id, src);
        el.innerHTML = svg;
        ok = true;
      } catch (e) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 60)); continue; }
        el.setAttribute("data-failed", "1");
        el.textContent = "mermaid 渲染失败：\n" + src;
      }
    }
  }
}
// 库（本地或 CDN 回退）加载完成后的回调：补渲染任何挂起的图
window.__mermaidReady = function () { _mermaidPending = false; renderMermaid(); };
window.addEventListener("load", () => { if (_mermaidPending || document.querySelector(".mermaid:not([data-done])")) renderMermaid(); });

