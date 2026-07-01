// 全文搜索：搜全部日志（后端 FTS），结果浮层（固定在搜索框正下方）；点结果跳到该条所在月份并只显该天该会话。
let _searchTimer = 0;

function positionSearchBox(box) {
  const input = document.getElementById("search-input");
  if (!input) return;
  const r = input.getBoundingClientRect();
  box.style.top = (r.bottom + 6) + "px";
  box.style.left = r.left + "px";
  box.style.width = Math.max(r.width, 280) + "px";
}

function initSearch() {
  const input = document.getElementById("search-input");
  const box = document.getElementById("search-results");
  if (!input || !box) return;
  const close = () => { box.hidden = true; box.innerHTML = ""; };
  input.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    const q = input.value.trim();
    if (!q) { close(); return; }
    _searchTimer = setTimeout(() => { positionSearchBox(box); runSearch(q, box); }, 250);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; close(); } });
  document.addEventListener("click", (e) => {
    if (!box.contains(e.target) && e.target !== input) close();
  }, true);
  // 重定位：每次重新取元素并校验仍在 DOM，避免持有失效引用
  const reposition = () => {
    const b = document.getElementById("search-results");
    if (b && !b.hidden && document.body.contains(b)) positionSearchBox(b);
  };
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition, { passive: true });
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
    box.querySelectorAll(".sr-item").forEach((el, i) => {
      el.onclick = () => { box.hidden = true; focusEntry(r.items[i]); document.getElementById("search-input").value = ""; };
    });
  } catch (err) {
    box.hidden = false;
    box.innerHTML = `<div class="sr-empty">搜索失败：${esc(err.message)}</div>`;
  }
}

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
