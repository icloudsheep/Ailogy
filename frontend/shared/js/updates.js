// 全局版本更新检测：拉一次 /api/updates，
//   - 若 has_update=true 给 header 的"关于"链接加 .has-update 类（CSS 显示红点）
//   - 首次访问时如果新版本比记录的高，触发一次 toast 提示（用户已见的不再提示）
// 各页面公用，只需要引入这个 js（header.js 里在 renderHeader 后自动调用）。

(function () {
  // 已见的 latest tag：跨设备/浏览器共享（服务端 prefs 为真源，localStorage 作同步缓存）。
  // 场景：设备 A 已在关于页看过 tag=X 的说明；设备 B 打开时不应再弹"新版本 X"toast。
  const SEEN_KEY = "ailogy:seenLatestTag";

  async function _fetchSeen() {
    // 先本地缓存兜底，再拉服务端覆盖
    let seen = "";
    try { seen = localStorage.getItem(SEEN_KEY) || ""; } catch (_) {}
    try {
      const r = await fetch("/api/prefs/" + encodeURIComponent(SEEN_KEY));
      if (r.ok) {
        const j = await r.json();
        const v = j && typeof j.value === "string" ? j.value : "";
        if (v) {
          seen = v;
          try { localStorage.setItem(SEEN_KEY, v); } catch (_) {}
        }
      }
    } catch (_) {}
    return seen;
  }
  function _markSeen(tag) {
    try { localStorage.setItem(SEEN_KEY, tag); } catch (_) {}
    try {
      fetch("/api/prefs/" + encodeURIComponent(SEEN_KEY), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: tag }),
      });
    } catch (_) {}
  }

  window.checkUpdates = async function () {
    let data;
    try {
      const r = await fetch("/api/updates");
      data = await r.json();
    } catch (_) { return; }
    if (!data || data.error) return;
    const latestTag = data.latest && data.latest.tag ? data.latest.tag : "";
    const hasUpd = !!data.has_update;
    // 把结果挂到 window，供 about 页读取（不用二次请求）
    window.__updatesData = data;

    // header 里的"关于"链接加红点
    if (hasUpd) {
      // renderHeader 是异步生成 DOM 的，这里稍等再打标记
      const tag = () => {
        const links = document.querySelectorAll('#app-header a.hnav[href$="/about"]');
        links.forEach((a) => a.classList.add("has-update"));
      };
      tag();
      setTimeout(tag, 100);
      setTimeout(tag, 500);
    }

    // 新版本 toast：只在服务端记录的 seen 与当前 latest 不同时提示一次
    const seen = await _fetchSeen();
    if (hasUpd && latestTag && latestTag !== seen && typeof showToast === "function") {
      showToast(`新版本 ${latestTag} 可用`, { type: "ok", title: "🆕 更新" });
      // 一旦显示过就记下——写 prefs 让其他设备也不再重复弹
      _markSeen(latestTag);
    }
  };
})();
