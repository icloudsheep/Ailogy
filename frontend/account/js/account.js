// 账户页：注册 / 登录 / 退出 / 个人信息（不含密钥——密钥在 /platform）。
const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => fetch(path, {
  credentials: "include", headers: { "Content-Type": "application/json" }, ...opts,
}).then(async (r) => {
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errText(b.detail) || r.statusText);
  return b;
});
function errText(d) {
  if (!d) return ""; if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join("；");
  return String(d);
}
function showMsg(t, ok) { const e = $("msg"); e.textContent = t; e.className = "msg " + (ok ? "ok" : "err"); }

let pane = "login";
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
  try { await api(path, { method: "POST", body: JSON.stringify(payload) }); await refresh(); }
  catch (err) { showMsg(err.message, false); }
};

$("logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); };

async function refresh() {
  try {
    const me = await api("/api/auth/me");
    $("auth").hidden = true; $("profile").hidden = false;
    $("p-email").textContent = me.email;
    $("p-handle").textContent = me.handle;
    $("p-role").textContent = me.is_admin ? "🛡 管理员" : "普通用户";
    const page = $("p-page"); page.textContent = `/u/${me.handle}`; page.href = `/u/${me.handle}`;
    initDebugTag("front/account");
  } catch {
    $("auth").hidden = false; $("profile").hidden = true;
  }
}

renderHeader("account");
bindTabs();
refresh();
bindGlobalMenu();
