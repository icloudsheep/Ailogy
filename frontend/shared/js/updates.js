// 全局版本更新检测：拉一次 /api/updates，
//   - 若 has_update=true 给 header 的"关于"链接加 .has-update 类（CSS 显示红点）
//   - 首次访问时如果新版本比记录的高，触发一次 toast 提示（用户已见的不再提示）
// 各页面公用，只需要引入这个 js（header.js 里在 renderHeader 后自动调用）。

(function () {
  const SEEN_KEY = "ailogy:seenLatestTag";

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

    // 新版本 toast：只在本地存的 seenTag 与当前 latestTag 不同时提示一次
    let seen = ""; try { seen = localStorage.getItem(SEEN_KEY) || ""; } catch (_) {}
    if (hasUpd && latestTag && latestTag !== seen && typeof showToast === "function") {
      showToast(`新版本 ${latestTag} 可用`, { type: "ok", title: "🆕 更新" });
      // 一旦显示过就记下（用户到 about 页看过更新日志会再次覆盖记录）
      try { localStorage.setItem(SEEN_KEY, latestTag); } catch (_) {}
    }
  };
})();
