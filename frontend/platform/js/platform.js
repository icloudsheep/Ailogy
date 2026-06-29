// 密钥平台前端：注册/登录、申请、密钥管理、（管理员）审批。纯 fetch + 同源 cookie。
const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => fetch(path, {
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  ...opts,
}).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errText(body.detail) || r.statusText);
  return body;
});

// FastAPI 的 detail 可能是字符串，也可能是校验错误数组；统一转人读文本。
function errText(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg || JSON.stringify(d)).join("；");
  return String(detail);
}

let pane = "login";  // login | register

function showMsg(el, text, ok = false) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "err"); }

// ── 鉴权区切换 ──
function bindTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
    pane = t.dataset.pane;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
    $("handle").hidden = pane !== "register";
    $("submit").textContent = pane === "register" ? "注册" : "登录";
    $("msg").textContent = "";
  });
}

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("email").value.trim(), password = $("password").value;
  const path = pane === "register" ? "/api/auth/register" : "/api/auth/login";
  const payload = pane === "register"
    ? { email, password, handle: $("handle").value.trim() } : { email, password };
  try {
    await api(path, { method: "POST", body: JSON.stringify(payload) });
    await refresh();
  } catch (err) { showMsg($("msg"), err.message); }
};

$("apply-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/applications", { method: "POST", body: JSON.stringify({ reason: $("reason").value.trim() }) });
    await loadApplications();
    // 自己若是管理员，同步刷新待审列表（能立刻看到刚提交的申请）
    if ($("who").textContent.includes("🛡")) await loadAdmin(true);
  } catch (err) { showMsg($("app-state"), err.message); }
};

$("newkey").onclick = async () => {
  try {
    const r = await api("/api/keys", { method: "POST", body: JSON.stringify({ label: "自助创建" }) });
    await loadKeys();
    showToast("已新建密钥，可在列表随时复制", { title: "密钥" });
  } catch (err) { showToast(err.message, { title: "出错", type: "err" }); }
};

$("logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); };

// ── 已登录区数据 ──
async function loadApplications() {
  const mine = await api("/api/applications/mine");
  const latest = mine[0];
  if (!latest) { $("app-state").textContent = "尚未申请"; $("app-state").className = "msg"; return; }
  const label = { pending: "⏳ 待审批", approved: "✅ 已批准", rejected: "❌ 已拒绝" }[latest.status];
  showMsg($("app-state"), `${label}${latest.review_note ? " · " + latest.review_note : ""}`, latest.status === "approved");
}

async function loadKeys() {
  const keys = await api("/api/keys");
  $("keys").innerHTML = keys.length ? keys.map((k) =>
    `<div class="key">
      <code title="${esc(k.secret || k.prefix)}">${esc(k.secret || (k.prefix + "…"))}</code>
      <span class="key-label">${esc(k.label || "")}</span>
      <div class="actions">
        ${k.secret ? `<button class="mini" data-copy="${esc(k.secret)}">复制</button>` : ""}
        <button class="mini danger" data-del="${k.id}">删除</button>
      </div>
    </div>`).join("") : "<div class='msg'>暂无密钥，点「+ 新建密钥」生成。</div>";
  // 复制
  $("keys").querySelectorAll("button[data-copy]").forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); showToast("密钥已复制到剪贴板", { title: "密钥" }); }
    catch { showToast("复制失败，请手动选中", { title: "密钥", type: "err" }); }
  });
  // 删除（不可逆）
  $("keys").querySelectorAll("button[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("删除后不可恢复，确认删除该密钥？")) return;
    await api(`/api/keys/${b.dataset.del}`, { method: "DELETE" });
    await loadKeys(); showToast("密钥已删除", { title: "密钥" });
  });
}

async function loadAdmin(isAdmin) {
  $("admin-card").hidden = !isAdmin;
  if (!isAdmin) return;
  const apps = await api("/api/admin/applications?status=pending");
  $("admin-apps").innerHTML = apps.length ? apps.map((a) =>
    `<div class="app-row" data-id="${a.id}">
      <span>#${a.id} · ${a.reason || "（无理由）"}</span>
      <button class="mini" data-act="approve">批准</button>
      <button class="mini danger" data-act="reject">拒绝</button>
    </div>`).join("") : "<div class='msg'>无待审申请</div>";
  $("admin-apps").querySelectorAll("button[data-act]").forEach((b) => b.onclick = async () => {
    const id = b.closest(".app-row").dataset.id, act = b.dataset.act;
    try {
      if (act === "approve") {
        const r = await api(`/api/admin/applications/${id}/approve`, { method: "POST", body: JSON.stringify({ note: "" }) });
        alert("已批准。明文密钥（请转交申请人，仅此一次）：\n\n" + r.api_key);
      } else {
        const note = prompt("拒绝理由（必填）："); if (!note) return;
        await api(`/api/admin/applications/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) });
      }
      await loadAdmin(true);
      await loadKeys();  // 发放的密钥可能是给自己的，刷新「我的密钥」
    } catch (err) { alert(err.message); }
  });
}

// ── 入口：判断登录态 ──
async function refresh() {
  try {
    const me = await api("/api/auth/me");
    $("auth").hidden = true; $("dash").hidden = false;
    $("who").textContent = `${me.email}${me.is_admin ? " 🛡" : ""}`;
    await Promise.all([loadApplications(), loadKeys(), loadAdmin(me.is_admin)]);
    initPageNav("platform");  // 登录态确定后再渲染导航胶囊（仅管理员可见）
  } catch {
    $("auth").hidden = false; $("dash").hidden = true; $("who").textContent = "";
  }
}

bindTabs();
refresh();
bindGlobalMenu();
