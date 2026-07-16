// 关于页：显示当前版本、GitHub 仓库链接、来自 releases 的更新日志，
// 顶部若有新版本则显示提示条。改用 /api/updates 一次拉取所有信息。

async function loadAbout() {
  // 版本 & 仓库（快渲染，避免"版本 …"停留过久）
  try {
    const v = await fetch("/api/version").then((r) => r.json());
    document.getElementById("ver").textContent = v.version || "未知";
    const repo = document.getElementById("repo");
    repo.href = v.repo || "#";
    repo.textContent = (v.repo || "").replace(/^https?:\/\//, "") || "GitHub 仓库";
  } catch (_) {}

  // Releases（15 分钟服务端缓存；点击刷新按钮不会突破缓存，需要等 TTL）
  await refreshReleases();
}

async function refreshReleases(force) {
  const listEl = document.getElementById("release-list");
  listEl.innerHTML = '<div class="release-loading">正在从 GitHub 拉取更新日志…</div>';
  let data;
  try {
    data = await fetch("/api/updates").then((r) => r.json());
  } catch (e) {
    listEl.innerHTML = '<div class="release-error">拉取失败：' + esc(String(e)) + '</div>';
    return;
  }
  if (data.error) {
    listEl.innerHTML = '<div class="release-error">拉取失败：' + esc(data.error) + '</div>';
  }
  // 提示条
  const banner = document.getElementById("update-banner");
  const latest = data.latest;
  if (data.has_update && latest) {
    banner.hidden = false;
    document.getElementById("update-tag").textContent = latest.tag || "";
    const pub = latest.published_at ? new Date(latest.published_at).toLocaleDateString() : "";
    const sub = [pub && ("发布于 " + pub), (latest.name && latest.name !== latest.tag) ? latest.name : ""].filter(Boolean).join(" · ");
    document.getElementById("update-sub").textContent = sub;
    const link = document.getElementById("update-link");
    link.href = latest.url || "#";
    // 绑定"立即更新"按钮：触发后端安装，之后轮询状态并显示进度
    const installBtn = document.getElementById("update-install-btn");
    installBtn.dataset.tag = latest.tag || "";
    installBtn.onclick = () => startInstall(latest.tag);
    // 标记为"已见"：写本地缓存 + PUT 服务端 prefs（跨设备同步，下次任何端都不再 toast）
    const _tag = latest.tag || "";
    try { localStorage.setItem("ailogy:seenLatestTag", _tag); } catch (_) {}
    try {
      fetch("/api/prefs/" + encodeURIComponent("ailogy:seenLatestTag"), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: _tag }),
      });
    } catch (_) {}
  } else {
    banner.hidden = true;
  }

  const releases = data.releases || [];
  if (!releases.length) {
    listEl.innerHTML = '<div class="release-empty">' + (data.error ? '' : '暂无正式发布。') + '当前版本 <b>' + esc(data.current || "") + '</b>。</div>';
    return;
  }

  const curTag = String(data.current || "").replace(/^v/i, "");
  listEl.innerHTML = releases.map((r) => {
    const tag = r.tag || "";
    const isCur = tag.replace(/^v/i, "") === curTag;
    const isLatest = latest && latest.tag === tag;
    const badges = [
      isLatest && '<span class="release-badge latest">最新</span>',
      isCur && '<span class="release-badge current">已安装</span>',
      r.prerelease && '<span class="release-badge pre">预发布</span>',
    ].filter(Boolean).join("");
    const dateStr = r.published_at ? new Date(r.published_at).toLocaleDateString() : "";
    return '<article class="release-item' + (isLatest ? ' is-latest' : '') + '">'
      + '<div class="release-item-head">'
      +   '<div class="release-item-title">'
      +     '<span class="release-tag">' + esc(tag) + '</span>'
      +     (r.name && r.name !== tag ? '<span class="release-name">' + esc(r.name) + '</span>' : '')
      +     badges
      +   '</div>'
      +   '<div class="release-item-meta">'
      +     (dateStr ? '<span class="release-date">' + esc(dateStr) + '</span>' : '')
      +     (r.url ? ' · <a class="release-link" href="' + esc(r.url) + '" target="_blank" rel="noopener">在 GitHub 上查看</a>' : '')
      +   '</div>'
      + '</div>'
      + '<div class="release-body md">' + renderMd(r.body || "*（无描述）*") + '</div>'
      + '</article>';
  }).join("");
  // 渲染代码块/公式/mermaid（release 描述可能含 markdown 代码）
  listEl.querySelectorAll(".release-body").forEach((el) => { renderMermaid(el); renderMath(el); });
}

// 烟花保留原样：从这里开始
function startFireworks(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let raf = 0, W = 0, H = 0, last = 0, spawnAcc = 0, stopped = false;
  const rockets = [], sparks = [];
  const COLORS = ["#ff9eb3", "#ffd17a", "#9ee6c4", "#8ec5ff", "#c5a3ff", "#ff9ed6", "#7ee787"];
  const rand = (a, b) => a + Math.random() * (b - a);
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  // 全屏烟花：数量少、有大有小；大烟花密度更高。
  //   - 每支火箭随机分为 small / medium / big 三档，粒子数与尺寸不同
  //   - big 档 20% 概率触发，一朵直径明显更大更密
  //   - 同屏最多 10 支火箭；发射间隔 14 帧一次，每次 1~3 枚同时升空，同批不在同一位置
  const MAX_ROCKETS = 10;
  const SPAWN_INTERVAL = 14;
  const SPAWN_BATCH_MIN = 1;
  const SPAWN_BATCH_MAX = 3;
  const BATCH_MIN_DIST_X = 0.15;   // 同批 x 位置最小间距，占屏宽的比例
  function pickSize() {
    const r = Math.random();
    if (r < 0.20) return "big";      // 20% 大
    if (r < 0.60) return "med";      // 40% 中
    return "small";                   // 40% 小
  }
  function launch(xOverride) {
    const kind = pickSize();
    const vyRange = kind === "big" ? [-10, -8] : kind === "med" ? [-11, -9] : [-12, -10];
    const tyRange = kind === "big" ? [H * .08, H * .35] : kind === "med" ? [H * .15, H * .5] : [H * .25, H * .6];
    rockets.push({
      x: Number.isFinite(xOverride) ? xOverride : rand(W * .05, W * .95),
      y: H + rand(0, 20),
      vx: rand(-.6, .6), vy: rand(vyRange[0], vyRange[1]),
      color: COLORS[(Math.random() * COLORS.length) | 0],
      ty: rand(tyRange[0], tyRange[1]),
      kind,
    });
  }
  // 绽放外形随机：让每朵烟花看起来不一样
  //   ring    经典均匀球形（等角 + 一致速度）
  //   messy   混乱球形（角度和速度都加抖动 → 花瓣状）
  //   double  双环嵌套（外环快、内环慢）
  //   burst2  双色副爆（一半粒子颜色替换为随机 palette）
  //   comet   拖尾流星（每粒有独立衰减，看起来像洒下）
  //   heart   心形（角度分布压扁）
  const SHAPES = ["ring", "messy", "double", "burst2", "comet", "heart"];
  function burst(x, y, color, kind) {
    const cfg = kind === "big" ? { n: [70, 100], sp: [3.5, 7.2], sz: [2.8, 4.6] }
              : kind === "med" ? { n: [36, 56],  sp: [2.2, 5.0], sz: [2.0, 3.2] }
              :                    { n: [18, 28],  sp: [1.4, 3.4], sz: [1.4, 2.2] };
    const n = cfg.n[0] + (Math.random() * (cfg.n[1] - cfg.n[0]) | 0);
    const shape = SHAPES[(Math.random() * SHAPES.length) | 0];
    const altColor = COLORS[(Math.random() * COLORS.length) | 0];

    const push = (sx, sy, vx, vy, life, size, c) => sparks.push({
      x: sx, y: sy, vx, vy, life, color: c, size,
    });

    if (shape === "ring") {
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n, sp = rand(cfg.sp[0], cfg.sp[1]);
        push(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 1, rand(cfg.sz[0], cfg.sz[1]), color);
      }
    } else if (shape === "messy") {
      // 角度带随机偏移、速度大范围抖动 → 不规则外扩
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + rand(-0.4, 0.4);
        const sp = rand(cfg.sp[0] * 0.55, cfg.sp[1] * 1.15);
        push(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
             rand(0.7, 1.1), rand(cfg.sz[0], cfg.sz[1]), color);
      }
    } else if (shape === "double") {
      // 内外两环：外环大速度、内环小速度
      const half = n >> 1;
      for (let i = 0; i < half; i++) {
        const a = (Math.PI * 2 * i) / half;
        push(x, y, Math.cos(a) * cfg.sp[1], Math.sin(a) * cfg.sp[1], 1,
             rand(cfg.sz[0], cfg.sz[1]), color);
      }
      for (let i = 0; i < half; i++) {
        const a = (Math.PI * 2 * i) / half + Math.PI / half;   // 交错半角
        const sp = cfg.sp[0] * 0.9;
        push(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 1,
             rand(cfg.sz[0], cfg.sz[1]), color);
      }
    } else if (shape === "burst2") {
      // 主色 + 副色（约一半粒子换色）
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n, sp = rand(cfg.sp[0], cfg.sp[1]);
        push(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 1,
             rand(cfg.sz[0], cfg.sz[1]), (i & 1) ? altColor : color);
      }
    } else if (shape === "comet") {
      // 拖尾流星：每粒 life 差别更大 → 有的很快消失、有的持续拖尾
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + rand(-0.2, 0.2);
        const sp = rand(cfg.sp[0], cfg.sp[1] * 1.3);
        push(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
             rand(0.6, 1.6), rand(cfg.sz[0], cfg.sz[1]), color);
      }
    } else {
      // heart：角度分布不均，压扁 y 轴 → 视觉近似心形/水滴
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n;
        const sp = rand(cfg.sp[0], cfg.sp[1]);
        push(x, y, Math.cos(a) * sp * 1.1, Math.sin(a) * sp * 0.75 - 0.6, 1,
             rand(cfg.sz[0], cfg.sz[1]), color);
      }
    }
  }
  function frame(t) {
    if (stopped) return;
    const dt = (Math.min((t - last) || 16, 40) / 16) * 0.55; last = t;
    ctx.clearRect(0, 0, W, H);
    spawnAcc += dt;
    if (spawnAcc > SPAWN_INTERVAL && rockets.length < MAX_ROCKETS) {
      // 每次发射 1~3 枚（受同屏上限约束），x 位置互相隔开至少 BATCH_MIN_DIST_X × 屏宽
      const wanted = SPAWN_BATCH_MIN + (Math.random() * (SPAWN_BATCH_MAX - SPAWN_BATCH_MIN + 1) | 0);
      const canSpawn = Math.min(wanted, MAX_ROCKETS - rockets.length);
      const usedX = [];
      const minDist = W * BATCH_MIN_DIST_X;
      for (let k = 0; k < canSpawn; k++) {
        let x, tries = 12;
        while (tries-- > 0) {
          x = rand(W * .05, W * .95);
          if (!usedX.some((u) => Math.abs(u - x) < minDist)) break;
        }
        usedX.push(x);
        launch(x);
      }
      spawnAcc = 0;
    }
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i]; r.x += r.vx * dt; r.y += r.vy * dt; r.vy += .08 * dt;
      ctx.globalAlpha = 1; ctx.fillStyle = r.color;
      const trackSize = r.kind === "big" ? 3.4 : r.kind === "med" ? 2.8 : 2.2;
      ctx.beginPath(); ctx.arc(r.x, r.y, trackSize, 0, 7); ctx.fill();
      if (r.vy >= -1 || r.y <= r.ty) { burst(r.x, r.y, r.color, r.kind); rockets.splice(i, 1); }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]; s.x += s.vx * dt; s.y += s.vy * dt;
      s.vy += .05 * dt; s.vx *= .985; s.life -= .010 * dt;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  function start() { if (stopped || raf) return; last = 0; raf = requestAnimationFrame(frame); }
  function pause() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  launch();
  start();
  const onVis = () => { if (document.hidden) pause(); else start(); };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", () => {
    stopped = true; pause(); ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
  }, { once: true });
}

// 触发一次安装并轮询状态；进度条 & 文字实时更新。
// 后端 os.execv 成功重启后本轮询会陆续报错 → 视为"重启成功"，3s 后 reload 页面。
let _installTimer = 0;
async function startInstall(tag) {
  if (!confirm("立即从 GitHub 下载新版本并覆盖本地文件？服务会自动尝试重启。")) return;
  const btn = document.getElementById("update-install-btn");
  btn.disabled = true; btn.textContent = "更新中…";
  const boxProgress = document.getElementById("update-progress");
  const fill = document.getElementById("update-progress-fill");
  const text = document.getElementById("update-progress-text");
  boxProgress.hidden = false;
  try {
    const r = await fetch("/api/updates/install", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tag ? { tag } : {}),
    }).then((r) => r.json());
    if (!r.ok) { text.textContent = "触发失败：" + r.error; btn.disabled = false; btn.textContent = "重试"; return; }
  } catch (e) {
    text.textContent = "触发失败：" + e; btn.disabled = false; btn.textContent = "重试"; return;
  }
  clearInterval(_installTimer);
  let errCount = 0;
  const tick = async () => {
    let s;
    try {
      s = await fetch("/api/updates/status").then((r) => r.json());
      errCount = 0;
    } catch (_) {
      // 请求失败 = 服务可能正在 exec 重启
      errCount++;
      if (errCount > 4) {
        text.textContent = "服务正在重启，即将刷新页面…";
        clearInterval(_installTimer);
        setTimeout(() => location.reload(), 2500);
      }
      return;
    }
    fill.style.width = (s.progress || 0) + "%";
    const labels = { idle: "空闲", downloading: "下载中", extracting: "解压中",
      applying: "应用文件", done: "重启中…", needs_restart: "需手动重启", error: "失败" };
    text.textContent = (labels[s.phase] || s.phase)
      + (s.message ? " · " + s.message : "")
      + (s.error ? " · " + s.error : "");
    if (s.phase === "done") {
      setTimeout(() => location.reload(), 3000);
    } else if (s.phase === "error" || s.phase === "needs_restart") {
      clearInterval(_installTimer);
      btn.disabled = false; btn.textContent = "重试";
    }
  };
  _installTimer = setInterval(tick, 1000);
  tick();
}

startFireworks(document.querySelector(".fireworks"));
renderHeader("about");
bindGlobalMenu();
initDebugTag("front/about");
loadAbout();
document.getElementById("release-refresh").addEventListener("click", () => refreshReleases(true));
