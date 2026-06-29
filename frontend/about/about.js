// 关于页：拉版本信息 + 烟花背景特效（复用本地 ai-log 的烟花思路）。
fetch("/api/version").then((r) => r.json()).then((v) => {
  document.getElementById("ver").textContent = v.version || "未知";
  const repo = document.getElementById("repo");
  repo.href = v.repo || "#";
  repo.textContent = (v.repo || "").replace(/^https?:\/\//, "") || "GitHub 仓库";
}).catch(() => {});

// Canvas 烟花：升空 + 爆炸粒子（低透明度，不遮挡文字）
function startFireworks(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let raf = 0, W = 0, H = 0, last = 0, spawnAcc = 0;
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
  new ResizeObserver(resize).observe(canvas);
  function launch() {
    rockets.push({ x: rand(W * .2, W * .8), y: H, vx: rand(-.4, .4), vy: rand(-7.5, -6),
                   color: COLORS[(Math.random() * COLORS.length) | 0], ty: rand(H * .15, H * .5) });
  }
  function burst(x, y, color) {
    const n = 24 + (Math.random() * 16 | 0);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n, sp = rand(1.2, 3.4);
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color, size: rand(1.4, 2.4) });
    }
  }
  function frame(t) {
    const dt = (Math.min((t - last) || 16, 40) / 16) * 0.35; last = t;
    ctx.clearRect(0, 0, W, H);
    spawnAcc += dt;
    if (spawnAcc > 24 && rockets.length < 5) { launch(); spawnAcc = 0; }
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i]; r.x += r.vx * dt; r.y += r.vy * dt; r.vy += .06 * dt;
      ctx.globalAlpha = 1; ctx.fillStyle = r.color;
      ctx.beginPath(); ctx.arc(r.x, r.y, 2.2, 0, 7); ctx.fill();
      if (r.vy >= -1 || r.y <= r.ty) { burst(r.x, r.y, r.color); rockets.splice(i, 1); }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += .04 * dt; s.vx *= .985; s.life -= .012 * dt;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  launch();
  raf = requestAnimationFrame(frame);
}

startFireworks(document.querySelector(".fireworks"));
renderHeader("about");
bindGlobalMenu();
initDebugTag("front/about");
