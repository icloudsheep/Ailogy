// 全文搜索：搜全部日志（后端 FTS），结果浮层；点结果跳到该条所在月份并只显该天该会话。
let _searchTimer = 0;

function initSearch() {
  const input = document.getElementById("search-input");
  const box = document.getElementById("search-results");
  if (!input || !box) return;
  const close = () => { box.hidden = true; box.innerHTML = ""; };
  input.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    const q = input.value.trim();
    if (!q) { close(); return; }
    _searchTimer = setTimeout(() => runSearch(q, box), 250);  // 防抖
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; close(); } });
  document.addEventListener("click", (e) => {
    if (!box.contains(e.target) && e.target !== input) close();
  }, true);
}

async function runSearch(q, box) {
  try {
    const r = await API.search({ q, limit: 40 });
    if (!r.items.length) {
      box.hidden = false;
      box.innerHTML = `<div class="sr-empty">未找到「${esc(q)}」</div>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = `<div class="sr-count">${r.items.length} 条匹配${r.next_cursor ? "+" : ""}</div>`
      + r.items.map((e) => {
          const c = colorOf(e.session_code);
          const title = e.title ? esc(e.title) : esc(sessDisplay(e.session_code, e.name));
          const snip = snippet(e.summary || "", q);
          return `<div class="sr-item" data-id="${e.id}" style="--c:${c}">
            <div class="sr-head"><span>${e.emoji || "📝"}</span>
              <span class="sr-title">${title}</span><span class="sr-seq">${esc(e.day)} #${e.seq}</span></div>
            ${snip ? `<div class="sr-snip">${snip}</div>` : ""}</div>`;
        }).join("");
    // 点结果 → 聚焦该条（focusEntry 在 viewer.js）
    box.querySelectorAll(".sr-item").forEach((el, i) => {
      el.onclick = () => { box.hidden = true; focusEntry(r.items[i]); document.getElementById("search-input").value = ""; };
    });
  } catch (err) {
    box.hidden = false;
    box.innerHTML = `<div class="sr-empty">搜索失败：${esc(err.message)}</div>`;
  }
}

// 命中片段：关键词上下文 + 高亮（大小写不敏感）
function snippet(text, q) {
  const flat = text.replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - 28), end = Math.min(flat.length, i + q.length + 40);
  return (start > 0 ? "…" : "") + esc(flat.slice(start, i))
    + `<mark>${esc(flat.slice(i, i + q.length))}</mark>`
    + esc(flat.slice(i + q.length, end)) + (end < flat.length ? "…" : "");
}

window.addEventListener("DOMContentLoaded", initSearch);
