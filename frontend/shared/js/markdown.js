function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function renderMd(src) {
  src = String(src || "").replace(/\r\n/g, "\n");
  // ── 公式预处理：先把 LaTeX 抽成占位符，避免被 markdown 行内解析（_ * \ 等）破坏 ──
  // 先「藏起」代码块与行内代码，使其中的 $（如 shell $VAR）不被误判为公式；抽完公式再还原。
  const math = [], stash = [];
  src = src.replace(/```[\s\S]*?```/g, (m) => { stash.push(m); return ` C${stash.length - 1} `; });
  src = src.replace(/`[^`\n]*`/g, (m) => { stash.push(m); return ` C${stash.length - 1} `; });
  // 块级 $$...$$（可跨行）→ 占位；随后行内 $...$（同行、非空、不与 $$ 冲突）
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (m, c) => { math.push({ display: true, src: c.trim() }); return ` M${math.length - 1} `; });
  src = src.replace(/(^|[^\\$])\$(?!\$)([^\n$]+?)\$(?!\$)/g, (m, pre, c) => { math.push({ display: false, src: c.trim() }); return `${pre} M${math.length - 1} `; });
  // 还原代码区，交给下方行解析器正常处理
  src = src.replace(/ C(\d+) /g, (m, i) => stash[+i]);

  const lines = src.split("\n");
  let html = "", i = 0;
  const st = []; const closeList = () => { while (st.length) html += st.pop() === "ul" ? "</ul>" : "</ol>"; };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      closeList();
      const lang = ln.replace(/^```/, "").trim().toLowerCase();
      i++; let code = "";
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + "\n"; i++; }
      i++;
      // mermaid 代码块 → 交给 mermaid 渲染（保留原始文本，不转义/不当代码）
      if (lang === "mermaid") { html += `<div class="mermaid">${esc(code)}</div>`; continue; }
      html += `<pre><code>${esc(code)}</code></pre>`; continue;
    }
    if (/\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i+1].replace(/[^|:\-\s]/g, ""))) {
      closeList(); const cells = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const head = cells(ln); i += 2;
      html += "<table><thead><tr>" + head.map((c) => `<th>${mdInline(c)}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && /\|/.test(lines[i])) { html += "<tr>" + cells(lines[i]).map((c) => `<td>${mdInline(c)}</td>`).join("") + "</tr>"; i++; }
      html += "</tbody></table>"; continue; }
    let m;
    if ((m = ln.match(/^(#{1,6})\s+(.*)/))) { closeList(); const lv = Math.min(m[1].length, 6); html += `<h${lv}>${mdInline(m[2])}</h${lv}>`; i++; continue; }
    if (/^\s*>\s?/.test(ln)) { closeList(); html += `<blockquote>${mdInline(ln.replace(/^\s*>\s?/, ""))}</blockquote>`; i++; continue; }
    if (/^\s*([-*_])\1{1,}\s*$/.test(ln)) { closeList(); html += "<hr>"; i++; continue; }
    if ((m = ln.match(/^\s*\d+\.\s+(.*)/))) { if (st[st.length-1] !== "ol") { closeList(); html += "<ol>"; st.push("ol"); } html += `<li>${mdInline(m[1])}</li>`; i++; continue; }
    if ((m = ln.match(/^\s*[-*]\s+(.*)/))) { if (st[st.length-1] !== "ul") { closeList(); html += "<ul>"; st.push("ul"); } html += `<li>${mdInline(m[1])}</li>`; i++; continue; }
    if (ln.trim() === "") { closeList(); i++; continue; }
    closeList(); html += `<p>${mdInline(ln)}</p>`; i++;
  }
  closeList();
  // ── 还原公式占位符为容器元素（源码存 data-src，KaTeX 就绪后由 renderMath 填充）──
  const mathEl = (idx) => {
    const it = math[idx];
    return it.display
      ? `<div class="math-block" data-src="${esc(it.src)}"></div>`
      : `<span class="math-inline" data-src="${esc(it.src)}"></span>`;
  };
  // 独占整段的块级公式：剥掉外层 <p>，避免 div 嵌在 p 内导致浏览器自动断开
  html = html.replace(/<p> M(\d+) <\/p>/g, (m, i) => mathEl(+i));
  html = html.replace(/ M(\d+) /g, (m, i) => mathEl(+i));
  return html;
}

