// 搜索：调后端 /api/search（FTS），结果浮层展示命中条目，点击在弹层显示该条详情。
// 与瀑布流解耦——搜索结果可能不在当前已加载页内，故点击走详情接口单独取。

let _searchTimer = 0;

function initSearch() {
  const input = document.getElementById("search-input");
  const box = document.getElementById("search-results");
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
    const r = await API.search({ q, limit: 30 });
    if (!r.items.length) {
      box.hidden = false;
      box.innerHTML = `<div class="sr-empty">未找到「${esc(q)}」</div>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = `<div class="sr-count">${r.items.length} 条匹配${r.next_cursor ? "+" : ""}</div>`
      + r.items.map((e) => {
          const c = colorOf(e.session_code);
          const title = e.title ? esc(e.title) : esc(e.name || e.session_code);
          const snip = snippet(e.summary || "", q);
          return `<div class="sr-item" data-id="${e.id}" style="--c:${c}">
            <div class="sr-head"><span>${e.emoji || "📝"}</span>
              <span class="sr-title">${title}</span><span class="sr-seq">#${e.seq}</span></div>
            <div class="sr-meta">${esc(e.name || e.session_code)} · ${esc(fmtAt(e.datetime))}</div>
            ${snip ? `<div class="sr-snip">${snip}</div>` : ""}
          </div>`;
        }).join("");
    box.querySelectorAll(".sr-item").forEach((el) => {
      el.onclick = () => openDetail(+el.dataset.id);
    });
  } catch (err) {
    box.hidden = false;
    box.innerHTML = `<div class="sr-empty">搜索失败：${esc(err.message)}</div>`;
  }
}

// 命中片段：找到关键词位置，截取上下文，关键词高亮（大小写不敏感）
function snippet(text, q) {
  const flat = text.replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - 30), end = Math.min(flat.length, i + q.length + 40);
  const pre = (start > 0 ? "…" : "") + flat.slice(start, i);
  const mid = flat.slice(i, i + q.length);
  const post = flat.slice(i + q.length, end) + (end < flat.length ? "…" : "");
  return esc(pre) + `<mark>${esc(mid)}</mark>` + esc(post);
}

// 详情弹层：从后端取完整条目，渲染 markdown/mermaid/公式
async function openDetail(id) {
  try {
    const e = await API.entry(id);
    const ov = document.createElement("div");
    ov.className = "detail-overlay";
    ov.innerHTML = `<div class="detail-modal" style="--c:${colorOf(e.session_code)}">
      <button class="detail-close">✕</button>
      <div class="d-title">${e.title ? esc(e.title) : esc(e.name)}</div>
      <div class="d-sub">${e.emoji || "📝"} ${esc(e.name || e.session_code)} · #${e.seq} · ${esc(fmtAt(e.datetime))}</div>
      <div class="d-body md">${renderMd(e.summary || "")}</div>
    </div>`;
    document.body.appendChild(ov);
    renderMermaid(ov); renderMath(ov);
    const close = () => ov.remove();
    ov.querySelector(".detail-close").onclick = close;
    ov.onclick = (ev) => { if (ev.target === ov) close(); };
    document.addEventListener("keydown", function esc2(ev) {
      if (ev.key === "Escape") { close(); document.removeEventListener("keydown", esc2); }
    });
  } catch (err) {
    alert("加载详情失败：" + err.message);
  }
}

window.addEventListener("DOMContentLoaded", initSearch);
