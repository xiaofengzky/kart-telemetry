/* ================================================================
   _core_ext.js —— 手工维护的公共扩展（由 split_core.js 合并进 core.js）
   内容：遥测通道定义 / 单圈曲线采样 / 多圈 Delta / 极限圈速 /
        跨页会话管理 / 导航 / 通用曲线绘图引擎
   ================================================================ */

/* ---------- 遥测通道 ----------
   X 轴统一用「圈内进度 %」重采样（Garage61 用的是距离，本质一样）：
   不同圈走线不同、总里程不同，按进度%才能让所有圈在同一根轴上对齐。
   VBO 没有踏板传感器，油门/刹车用纵向 G 推导（已在 UI 上标注量纲）。 */
/* 时间显示：≥1 分钟用 mm:ss.mmm，不足 1 分钟直接秒（用户觉得"147.883s"很怪）。
   差值（可捡时间/标准差等）请继续用秒，别套这个函数。 */
function fmtTime(sec, dec = 3) {
  if (sec == null || !isFinite(sec)) return '—';
  if (sec < 60) return sec.toFixed(dec) + 's';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return m + ':' + s.toFixed(dec).padStart(dec + 3, '0');
}
const CHANNELS = {
  speed: { name: '速度', unit: 'km/h', color: '#3b9eff', axis: 'left', dec: 0 },
  thr: { name: '油门', unit: '%', color: '#2ecc71', axis: 'left', dec: 0 },
  brk: { name: '刹车', unit: '%', color: '#e10600', axis: 'left', dec: 0 },
  steer: { name: '转向', unit: '°', color: '#16d6c9', axis: 'left', dec: 0 },
  gear: { name: '档位', unit: '', color: '#f5a623', axis: 'left', dec: 0 },
  rpm: { name: '转速', unit: 'rpm', color: '#a259ff', axis: 'left', dec: 0 },
  latg: { name: '横向G', unit: 'G', color: '#ff7ac6', axis: 'left', dec: 2 },
  long: { name: '纵向G', unit: 'G', color: '#ffd23f', axis: 'left', dec: 2 }
};
function channelValue(s, i, ch) {
  const p = s.points[i], a = s.analysis;
  switch (ch) {
    case 'speed': return p.vel;
    case 'thr': return a.isIR ? (p.thr || 0) * 100 : Math.max(0, a.driveG[i] || 0);
    case 'brk': return a.isIR ? (p.brk || 0) * 100 : Math.max(0, -(a.driveG[i] || 0));
    case 'steer': return a.isIR ? (p.steer || 0) / RAD : 0;
    case 'gear': return a.isIR ? (p.gear || 0) : 0;
    case 'rpm': return p.rpm || 0;
    case 'latg': return Math.abs(a.latg[i] || 0);
    case 'long': return a.driveG[i] || 0;
    default: return 0;
  }
}
/* 单圈曲线：按圈内进度 0→100% 等距采样 N+1 点
   返回 [{pct, d(圈内距离m), t(圈内时间s), v(通道值)}]
   用增量指针推进，避免 O(N×M) */
function lapTrace(s, lap, ch, N = 1000) {
  const cum = s.analysis.cum, A = lap.startIdx, B = lap.endIdx, D = lap.distance_m;
  const t0 = s.points[A].t, d0 = cum[A];
  const out = [];
  let ti = A;
  for (let k = 0; k <= N; k++) {
    const target = d0 + k / N * D;
    while (ti < B && cum[ti] < target) ti++;
    out.push({
      pct: k / N * 100,
      d: cum[ti] - d0,
      t: s.points[ti].t - t0,
      v: channelValue(s, ti, ch),
      lat: s.points[ti].lat + (s.offset ? s.offset.dLat : 0),
      lon: s.points[ti].lon + (s.offset ? s.offset.dLon : 0)
    });
  }
  // 收尾对齐：末点强制为圈末，避免采样误差让总时长对不上
  if (out.length) { out[out.length - 1].d = cum[B] - d0; out[out.length - 1].t = s.points[B].t - t0; }
  return out;
}

/* ---------- 把「圈内进度区间」翻译成人能看懂的赛道位置 ----------
   用户看不懂"第 37 段"，但看得懂"S2 · T5 → T6 之间"。
   返回 { sector:'S2', sectorIdx:1, label:'T5 → T6', cornerIds:[], distFrom, distTo } */
function segLocation(s, fromPct, toPct) {
  const a = s.analysis;
  const cs = (a.corners || []).slice().sort((x, y) => x.progress_pct - y.progress_pct);
  const si = Math.max(0, Math.min(2, Math.floor(fromPct / (100 / 3))));
  const inside = cs.filter(c => c.progress_pct >= fromPct && c.progress_pct < toPct);
  let label;
  if (inside.length === 1) label = 'T' + inside[0].id;
  else if (inside.length > 1) label = `T${inside[0].id} → T${inside[inside.length - 1].id}`;
  else {
    const prev = cs.slice().reverse().find(c => c.progress_pct < fromPct);
    const next = cs.find(c => c.progress_pct >= toPct);
    if (prev && next) label = `T${prev.id} → T${next.id} 之间`;
    else if (prev) label = `T${prev.id} 之后`;
    else if (next) label = `T${next.id} 之前`;
    else label = '直路段';
  }
  const D = a.best ? a.best.distance_m : 0;
  return {
    sector: 'S' + (si + 1), sectorIdx: si,
    label, cornerIds: inside.map(c => c.id),
    distFrom: Math.round(D * fromPct / 100), distTo: Math.round(D * toPct / 100)
  };
}

/* 某一段区间内，某一圈的实际数据（用原始点算，比 segCount 分辨率高得多）。
   段的耗时请仍用 idl.perLap[].times，口径和"极限圈速"一致；
   这里只用来看速度细节（最低/最高/入段/出段速度）。 */
function segStats(s, lap, fromPct, toPct) {
  const cum = s.analysis.cum, A = lap.startIdx, B = lap.endIdx, D = lap.distance_m, P = s.points;
  const d0 = cum[A];
  const da = d0 + fromPct / 100 * D, db = d0 + toPct / 100 * D;
  let i0 = A, i1 = B;
  while (i0 < B && cum[i0] < da) i0++;
  while (i1 > A && cum[i1] > db) i1--;
  if (i1 < i0) i1 = i0;
  let vmin = Infinity, vmax = -Infinity, sum = 0, n = 0;
  for (let i = i0; i <= i1; i++) { const v = P[i].vel; if (v < vmin) vmin = v; if (v > vmax) vmax = v; sum += v; n++; }
  return {
    time: P[i1].t - P[i0].t,
    vmin: n ? vmin : 0, vmax: n ? vmax : 0, vavg: n ? sum / n : 0,
    vStart: P[i0].vel, vEnd: P[i1].vel, n
  };
}

/* ---------- 赛道小地图（纯 canvas，不依赖 Leaflet） ----------
   用于在极限圈速/对比页就地高亮"某一段在赛道哪儿"，避免为了看一段位置跳页。
   用法：trackSketch(cv, s, { highlights:[{from,to,color,width}], corners:true, onPick:pct=>{} })
   返回 { X, Y, pts, pickClostest(px,py) } 便于调用方做交互。 */
function trackSketch(cv, s, opts = {}) {
  const b = s.analysis.best;
  if (!b) return null;
  const N = opts.N || 400;
  const pts = lapTrace(s, b, 'speed', N);
  const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const W = cv.clientWidth || 420, H = cv.clientHeight || 260;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const pad = 18;
  const spanLat = (maxLat - minLat) || 1e-9, spanLon = (maxLon - minLon) || 1e-9;
  const k = Math.min((W - pad * 2) / spanLon, (H - pad * 2) / spanLat);
  const ox = pad + ((W - pad * 2) - spanLon * k) / 2;
  const oy = pad + ((H - pad * 2) - spanLat * k) / 2;
  const X = p => ox + (p.lon - minLon) * k;
  const Y = p => oy + (maxLat - p.lat) * k;      // 纬度越大越靠上，所以 y 取反

  const vmin = s.analysis.vmin, vmax = s.analysis.vmax, vspan = (vmax - vmin) || 1;
  const stroke = (i0, i1, color, width, alpha) => {
    g.beginPath();
    for (let i = i0; i <= i1 && i < pts.length; i++) {
      const x = X(pts[i]), y = Y(pts[i]);
      i === i0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = color; g.lineWidth = width; g.globalAlpha = alpha == null ? 1 : alpha;
    g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(); g.globalAlpha = 1;
  };
  // 底图：默认按速度着色（蓝=慢 → 红=快），base:'dark' 则只画轨道轮廓（多圈走线对比时用）
  const base = opts.base || 'speed';
  if (base === 'dark') {
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = X(pts[i]), y = Y(pts[i]);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(232,236,244,.30)'; g.lineWidth = 2.2;
    g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
  } else {
    for (let i = 1; i < pts.length; i++) {
      stroke(i - 1, i, speedColor((pts[i].v - vmin) / vspan), opts.thin ? 2 : 3, .9);
    }
  }
  // 多圈走线叠加：每圈一条线，颜色=圈号，线越乱说明走线越不稳定
  const laps = opts.laps || [];
  if (laps.length) {
    const al = laps.length > 6 ? .42 : .68;
    const lw = laps.length > 8 ? 1.3 : 1.7;
    for (const li of laps) {
      const l = s.analysis.full.find(x => x.index === li);
      if (!l) continue;
      const tr = lapTrace(s, l, 'speed', Math.min(N, 260));
      g.beginPath();
      for (let i = 0; i < tr.length; i++) {
        const x = X(tr[i]), y = Y(tr[i]);
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.strokeStyle = cmpColor(li); g.lineWidth = lw; g.globalAlpha = al;
      g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
    }
    g.globalAlpha = 1;
  }
  // 位置标记（如刹车点）：圆点 + 白边 + 小标签
  const mks = opts.markers || [];
  for (const mk of mks) {
    const i = Math.min(pts.length - 1, Math.max(0, Math.round(mk.pct / 100 * N)));
    const x = X(pts[i]), y = Y(pts[i]);
    const r = mk.r || 4.5;
    g.beginPath(); g.arc(x, y, r, 0, 7);
    g.fillStyle = mk.color || '#e10600'; g.fill();
    g.strokeStyle = 'rgba(255,255,255,.92)'; g.lineWidth = 1.3; g.stroke();
    if (mk.label) {
      g.font = '600 10px system-ui,sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'bottom';
      const tw = g.measureText(mk.label).width;
      const lx = x + r + 3, ly = y - r - 2;
      g.fillStyle = 'rgba(11,13,18,.88)';
      g.fillRect(lx - 2, ly - 10, tw + 4, 13);
      g.fillStyle = '#fff'; g.fillText(mk.label, lx, ly + .5);
    }
  }
  // 起终点
  if (pts.length) {
    g.beginPath(); g.arc(X(pts[0]), Y(pts[0]), 3.2, 0, 7);
    g.fillStyle = '#e8ecf4'; g.fill();
    g.strokeStyle = '#0b0d12'; g.lineWidth = 1.4; g.stroke();
  }
  // 高亮区间（进度%）
  const hi = opts.highlights || [];
  for (const h of hi) {
    const i0 = Math.max(0, Math.round(h.from / 100 * N));
    const i1 = Math.min(pts.length - 1, Math.round(h.to / 100 * N));
    if (i1 <= i0) continue;
    stroke(i0, i1, h.color || '#e10600', h.width || 7, .45);
    stroke(i0, i1, h.color || '#e10600', h.width ? h.width * .45 : 3, 1);
  }
  // 弯号标注
  if (opts.corners !== false && hi.length <= 3) {
    const cs = s.analysis.corners || [];
    g.font = '600 10px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const c of cs) {
      const i = Math.min(pts.length - 1, Math.round(c.progress_pct / 100 * N));
      const x = X(pts[i]), y = Y(pts[i]);
      g.beginPath(); g.arc(x, y, 7.5, 0, 7);
      g.fillStyle = 'rgba(11,13,18,.85)'; g.fill();
      g.strokeStyle = 'rgba(232,236,244,.5)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = '#e8ecf4'; g.fillText('T' + c.id, x, y + .5);
    }
  }
  const pickClosest = (px, py) => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = X(pts[i]) - px, dy = Y(pts[i]) - py, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? null : pts[best].pct;
  };
  if (opts.onPick) {
    cv.onclick = e => {
      const r = cv.getBoundingClientRect();
      const pct = pickClosest(e.clientX - r.left, e.clientY - r.top);
      if (pct != null) opts.onPick(pct);
    };
    cv.style.cursor = 'pointer';
  }
  return { X, Y, pts, N, pickClosest };
}

/* ---------- 多圈对比：累积时间 Delta ----------
   Delta 直接用数据里的时间戳算（不用速度积分），
   这样 delta 末值必然等于两圈真实圈速差，不会有累积漂移。
   delta[k] = B 的圈内时间 − A 的圈内时间
     → 曲线往上走 = B 在这段丢时间；往下走 = B 在这段捡时间 */
function compareLaps(s, lapA, lapB, N = 1000) {
  const A = lapTrace(s, lapA, 'speed', N);
  const B = lapTrace(s, lapB, 'speed', N);
  const delta = [], dist = [], spdDiff = [];
  for (let k = 0; k <= N; k++) {
    delta.push(B[k].t - A[k].t);            // 秒，正 = B 慢
    dist.push(A[k].d);                       // X 轴用参考圈的圈内距离
    spdDiff.push(B[k].v - A[k].v);           // 速度差 km/h，负 = B 慢
  }
  // 速度差做一点平滑，避免逐点抖动看不出趋势
  const sm = k => {
    let sum = 0, c = 0;
    for (let j = Math.max(0, k - 8); j <= Math.min(N, k + 8); j++) { sum += spdDiff[j]; c++; }
    return sum / c;
  };
  const spdDiffS = spdDiff.map((_, k) => sm(k));
  // 按每 5% 统计一段里的 delta 增量，找出丢/捡时间最多的区间
  const zoneN = 20, zones = [];
  for (let z = 0; z < zoneN; z++) {
    const i0 = Math.round(z / zoneN * N), i1 = Math.round((z + 1) / zoneN * N);
    zones.push({
      from: i0 / N * 100, to: i1 / N * 100,
      gain: delta[i1] - delta[i0],                 // 正 = B 在这段净丢时间
      dAvg: (dist[i0] + dist[i1]) / 2,
      spdAvg: spdDiffS.slice(i0, i1 + 1).reduce((a, b) => a + b, 0) / (i1 - i0 + 1)
    });
  }
  const total = delta[N];
  return {
    N, delta, dist, spdDiff: spdDiffS, zones,
    total,
    lapA: lapA.index, lapB: lapB.index,
    timeA: lapA.time_s, timeB: lapB.time_s,
    // B 净丢时间最多的区间（正 gain）与捡回最多的（负 gain）
    lost: zones.filter(z => z.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, 5),
    gained: zones.filter(z => z.gain < 0).sort((a, b) => a.gain - b.gain).slice(0, 5)
  };
}

/* ---------- 极限圈速（Optimal Lap / 理论最快圈） ----------
   把赛道按进度切成 segCount 段，每段取所有完整圈里跑得最快的那段的耗时，
   累加得到「理论最快圈」。它一定 ≤ 实际最快圈，差值就是还能捡的时间。
   注意：各段来自不同圈，物理上未必能连着跑出来（Garage61 也叫它 optimal lap，
   只当改进方向看，别当可达目标）。 */
function idealLap(s, segCount = 50, laps = null) {
  const full = laps && laps.length ? laps : s.analysis.full;
  if (!full.length) return null;
  const perLap = [];
  for (const lap of full) {
    const tr = lapTrace(s, lap, 'speed', segCount);
    const times = [];
    for (let k = 0; k < segCount; k++) times.push(tr[k + 1].t - tr[k].t);
    perLap.push({ lap: lap.index, time_s: lap.time_s, times });
  }
  const segs = [];
  for (let k = 0; k < segCount; k++) {
    let mn = Infinity, who = null;
    for (const pl of perLap) if (pl.times[k] < mn) { mn = pl.times[k]; who = pl.lap; }
    segs.push({ seg: k, from: k / segCount * 100, to: (k + 1) / segCount * 100, time: mn, lap: who });
  }
  const idealTime = segs.reduce((a, b) => a + b.time, 0);
  // 从「参与计算的圈」里取最快圈，而不是全场最快——否则筛选掉出场圈后对不上
  const bestLap = full.reduce((m, l) => (!m || l.time_s < m.time_s) ? l : m, null);
  // 相对最快圈，每段还能捡多少（正值 = 有提升空间）
  let bt = null;
  if (bestLap) {
    const tr = lapTrace(s, bestLap, 'speed', segCount);
    bt = [];
    for (let k = 0; k < segCount; k++) bt.push(tr[k + 1].t - tr[k].t);
  }
  for (let k = 0; k < segCount; k++) segs[k].gain = bt ? Math.max(0, bt[k] - segs[k].time) : 0;
  const gain = bt ? bt.reduce((a, b) => a + b, 0) - idealTime : 0;
  return {
    segCount, idealTime, bestTime: bestLap ? bestLap.time_s : null,
    gain: Math.max(0, gain), segs, perLap,
    // ⚠ 别只留 6 段：页面上要列「可捡时间最多的 12 段」，这里不够就只渲染出 6 行
    top: [...segs].sort((a, b) => b.gain - a.gain).slice(0, 24)
  };
}

/* ---------- 理论走线（Optimal Lap 的赛道轨迹） ----------
   把赛道按进度切成 segCount 段，每段取「该段最快」来源圈的实际轨迹拼起来，
   得到一条"理论最优走线"（金色虚线画在地图上）。
   注意：各段来自不同圈，拼接处可能有小跳变，但能直观看出最优路径大致长什么样。 */
function idealTrackTrace(s, segCount = 50) {
  const idl = idealLap(s, segCount);
  if (!idl) return [];
  const cum = s.analysis.cum;
  const out = [];
  const perSeg = 8;                                  // 每段采 8 个点
  for (const sg of idl.segs) {
    const lap = s.analysis.full.find(l => l.index === sg.lap);
    if (!lap) continue;
    const A = lap.startIdx, B = lap.endIdx, D = lap.distance_m;
    for (let k = 0; k < perSeg; k++) {
      const d = sg.from / 100 * D + (sg.to - sg.from) / 100 * D * k / perSeg;
      const target = cum[A] + d;
      let ti = A; while (ti < B && cum[ti] < target) ti++;
      out.push([s.points[ti].lat, s.points[ti].lon]);
    }
  }
  return out;
}

/* ---------- 跨页会话管理 ----------
   数据存在 IndexedDB，但「当前选中哪个会话」要在页面间传递，用 localStorage。 */
const CUR_KEY = 'kart.curSessionId';
function saveCurId(id) { try { localStorage.setItem(CUR_KEY, String(id)); } catch (e) { } }
function loadCurId() { try { return localStorage.getItem(CUR_KEY); } catch (e) { return null; } }
function curSession() { return SESSIONS.find(s => s.id === curId) || null; }
function setCurSession(id) { curId = id; saveCurId(id); }

/* ---------- 页面导航 ---------- */
const PAGES = [
  { file: 'index.html', name: '车库', icon: '🏠' },
  { file: 'summary.html', name: '总结', icon: '🎯' },
  { file: 'laps.html', name: '圈速', icon: '⏱' },
  { file: 'telemetry.html', name: '遥测通道', icon: '📈' },
  { file: 'compare.html', name: '多圈对比', icon: '🔀' },
  { file: 'ideal.html', name: '极限圈速', icon: '⚡' },
  { file: 'track.html', name: '赛道图', icon: '🛰' }
];
function renderNav(activeFile) {
  const el = document.getElementById('pagenav');
  if (!el) return;
  el.innerHTML = PAGES.map(p =>
    `<a class="navitem ${p.file === activeFile ? 'on' : ''}" href="${p.file}"><span class="ni">${p.icon}</span>${p.name}</a>`
  ).join('');
}
/* 顶部会话条：切换会话 + 显示来源 */
function renderSessionBar(onChange) {
  const bar = document.getElementById('sessbar');
  if (!bar) return;
  if (!SESSIONS.length) {
    bar.innerHTML = '<span class="sbempty">还没有数据，<a href="index.html">去车库上传</a></span>';
    return;
  }
  bar.innerHTML =
    `<select id="sessSel" class="sbsel">${SESSIONS.map(s =>
      `<option value="${s.id}" ${s.id === curId ? 'selected' : ''}>${esc(s.name)} · ${s.analysis.full.length}圈</option>`).join('')}</select>
     <span id="sbMeta" class="sbmeta"></span>`;
  const sel = document.getElementById('sessSel');
  if (sel) sel.onchange = () => { setCurSession(sel.value); onChange && onChange(); };
  updateSessionMeta();
}
function updateSessionMeta() {
  const s = curSession(), m = document.getElementById('sbMeta');
  if (!m) return;
  if (!s) { m.textContent = ''; return; }
  m.innerHTML = `<i class="src ${s.source === 'iracing' ? 'iracing' : 'vbo'}">${s.source === 'iracing' ? 'iRacing' : 'VBOX'}</i>
    最快 <b>${s.analysis.best_time != null ? fmtTime(s.analysis.best_time, 2) : '-'}</b>
    · 极速 <b>${s.analysis.vmax.toFixed(0)}</b> km/h · ${esc(s.date)}`;
}
/* 各页面统一的启动流程：恢复数据 → 选中会话 → 渲染导航 */
async function bootPage(activeFile, onReady) {
  renderNav(activeFile);
  pageRefresh = onReady || null;             // 供 renderSidebar / selectSession 回调
  try { await openDB(); } catch (e) { }
  const recs = await dbLoadAll();
  for (const r of recs) SESSIONS.push(rebuildSession(r));
  const want = loadCurId();
  curId = (want && SESSIONS.some(s => s.id === want)) ? want : (SESSIONS.length ? SESSIONS[SESSIONS.length - 1].id : null);
  renderSessionBar(pageRefresh);
  setupUpload('fileInput', () => { if (pageRefresh) pageRefresh(); });
  onReady && onReady();
}

/* ================================================================
   通用曲线绘图引擎（各页面复用，保证视觉与交互一致）
   支持：多序列叠加 / 缩放平移 / 悬停十字读数 / 弯角竖线 / 背景区间 / 填充
   ================================================================ */
function drawTraces(cv, cfg) {
  if (!cv) return;
  const series = (cfg.series || []).filter(s => s.data && s.data.length);
  const padL = cfg.padL || 46, padR = cfg.padR || 14, padT = cfg.padT || 14, padB = cfg.padB || 30;
  const { W, H, ctx } = fitCanvas(cv, cfg.height || 300);
  ctx.clearRect(0, 0, W, H);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  if (!series.length) {
    ctx.fillStyle = '#8b98a5'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(cfg.emptyText || '暂无数据', W / 2, H / 2); return;
  }
  const N = series[0].data.length - 1;
  const v = cfg.view || { i0: 0, i1: N };
  const i0 = Math.max(0, Math.floor(v.i0)), i1 = Math.min(N, Math.ceil(v.i1));
  const span = Math.max(1e-6, v.i1 - v.i0);
  const sx = i => padL + (i - v.i0) / span * plotW;
  // Y 量程
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    for (let i = i0; i <= i1; i++) { const y = s.data[i]; if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
    if (s.forceZero) yMin = Math.min(yMin, 0);   // 需要零线时把 0 纳入量程
  }
  if (cfg.yMin != null) yMin = cfg.yMin;
  if (cfg.yMax != null) yMax = cfg.yMax;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;
  const sy = y => padT + plotH - (y - yMin) / (yMax - yMin) * plotH;

  ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();
  // 背景区间（如 Delta 的丢时间区）
  for (const b of (cfg.bands || [])) {
    const x1 = sx(b.from / 100 * N), x2 = sx(b.to / 100 * N);
    ctx.fillStyle = b.color || 'rgba(225,6,0,.10)';
    ctx.fillRect(x1, padT, x2 - x1, plotH);
  }
  // 网格
  const at = axisTicks(yMin, yMax, Math.max(2, plotH / 46));
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  for (const t of at.ticks) {
    if (t < yMin || t > yMax) continue;
    const y = sy(t); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
  }
  // 弯角竖线
  for (const c of (cfg.corners || [])) {
    const x = sx(c.progress_pct / 100 * N);
    ctx.strokeStyle = 'rgba(245,166,35,.45)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke(); ctx.setLineDash([]);
  }
  // F1 风格赛段背景（S1/S2/S3）：cfg.sectors 为 true 时绘制
  if (cfg.sectors) {
    const seg = [
      [0, 1 / 3, 'S1', 'rgba(59,158,255,.06)'],
      [1 / 3, 2 / 3, 'S2', 'rgba(34,211,238,.05)'],
      [2 / 3, 1, 'S3', 'rgba(63,185,80,.05)']
    ];
    for (const [f0, f1, name, color] of seg) {
      const x1 = sx(f0 * N), x2 = sx(f1 * N);
      ctx.fillStyle = color; ctx.fillRect(x1, padT, x2 - x1, plotH);
      ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x2, padT); ctx.lineTo(x2, padT + plotH); ctx.stroke();
      ctx.fillStyle = 'rgba(139,152,165,.7)'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(name, Math.max(x1 + 8, (x1 + x2) / 2), padT + 10);
    }
  }
  // 零线（Delta 图等需要）
  if (cfg.zeroLine && yMin < 0 && yMax > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(padL, sy(0)); ctx.lineTo(padL + plotW, sy(0)); ctx.stroke();
  }
  // 填充 + 折线
  for (const s of series) {
    if (s.fill) {
      ctx.fillStyle = s.fill;
      ctx.beginPath(); ctx.moveTo(sx(i0), sy(cfg.zeroLine ? 0 : yMin));
      for (let i = i0; i <= i1; i++) ctx.lineTo(sx(i), sy(s.data[i]));
      ctx.lineTo(sx(i1), sy(cfg.zeroLine ? 0 : yMin)); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.7; ctx.lineJoin = 'round';
    if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) { const x = sx(i), y = sy(s.data[i]); i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
  // 左轴刻度
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = '#8b98a5';
  for (const t of at.ticks) {
    if (t < yMin || t > yMax) continue;
    ctx.fillText(cfg.yFmt ? cfg.yFmt(t) : (Math.abs(t) >= 100 ? t.toFixed(0) : t.toFixed(at.step < 0.1 ? 2 : 1)), padL - 5, sy(t) + 3);
  }
  // X 轴（按当前单位取标签）
  const xLab = cfg.xLabels || null;
  if (xLab) {
    const uMin = xLab[Math.round(v.i0)] || 0, uMax = xLab[Math.round(v.i1)] || 0;
    const atx = axisTicks(uMin, uMax, Math.max(2, plotW / 105));
    ctx.textAlign = 'center'; ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.moveTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
    for (const t of atx.ticks) {
      if (t < uMin - 1e-9 || t > uMax + 1e-9) continue;
      const f = (t - uMin) / (uMax - uMin || 1);
      const idx = v.i0 + f * (v.i1 - v.i0);
      const x = sx(idx);
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.beginPath(); ctx.moveTo(x, padT + plotH); ctx.lineTo(x, padT + plotH + 4); ctx.stroke();
      ctx.fillStyle = '#8b98a5';
      ctx.fillText(cfg.xFmt ? cfg.xFmt(t) : String(Math.round(t)), Math.max(padL + 12, Math.min(padL + plotW - 12, x)), H - 8);
    }
  }
  // 悬停十字线 + 读数
  if (cfg.hoverIdx != null && cfg.hoverIdx >= 0) {
    const i = Math.max(0, Math.min(N, Math.round(cfg.hoverIdx)));
    const x = sx(i);
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke(); ctx.setLineDash([]);
    for (const s of series) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, sy(s.data[i]), 3.2, 0, 7); ctx.fill(); }
    if (cfg.tip) {
      const rows = cfg.tip(i);
      if (rows && rows.length) {
        const bw = cfg.tipW || 150, bh = rows.length * 14 + 8;
        let bx = x + 12; if (bx + bw > padL + plotW) bx = x - 12 - bw; if (bx < padL) bx = padL + 2;
        let by = padT + 6; if (by + bh > padT + plotH) by = padT + plotH - bh - 4;
        ctx.fillStyle = 'rgba(8,11,16,.94)'; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 5); else ctx.rect(bx, by, bw, bh);
        ctx.fill(); ctx.stroke();
        ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
        rows.forEach((r, k) => {
          const ty = by + 14 + k * 14;
          ctx.fillStyle = r[2] || '#8b98a5'; ctx.fillText(r[0], bx + 7, ty);
          ctx.fillStyle = r[2] ? r[2] : '#e6edf3'; ctx.textAlign = 'right';
          ctx.fillText(r[1], bx + bw - 7, ty); ctx.textAlign = 'left';
        });
      }
    }
  }
  // 图例（series.legend === false 的序列只画不标注，用于 Delta 的填充带）
  if (cfg.legend !== false && series.length) {
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    let lx = padL + 4;
    for (const s of series) {
      if (s.legend === false) continue;
      const txt = s.name || '';
      const w = ctx.measureText(txt).width;
      ctx.fillStyle = s.color; ctx.fillRect(lx, padT + 3, 8, 3);
      ctx.fillStyle = '#8b98a5'; ctx.fillText(txt, lx + 12, padT + 8);
      lx += w + 26;
    }
  }
}
/* 绑定缩放/平移/悬停。getCfg() 返回绘图表配置，onView 在视窗变化时回调 */
function bindTraceChart(cv, getCfg, onView) {
  if (!cv) return;
  const padL = 46, padR = 14;
  const plotW = () => Math.max(60, (cv.clientWidth || 660) - padL - padR);
  const N = () => { const c = getCfg(); return c && c.series && c.series[0] ? c.series[0].data.length - 1 : 1000; };
  const frac = cx => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, (cx - r.left - padL) / plotW())); };
  cv.style.cursor = 'crosshair'; cv.style.touchAction = 'none';
  const pointers = new Map();
  let pan = null, pinch = null;
  const clamp = v => {
    const n = N();
    // ⚠ 视窗 i0/i1 是【数据下标】（0..N），不是归一化 0..1！
    // 之前误用 Math.min(1, span)，一次滚轮就把 1000 点的窗口压成 1 点，曲线变直线。
    const s = Math.min(n, Math.max(4, v.i1 - v.i0));   // 视窗至少 4 个点，最多整圈
    v.i0 = Math.max(0, Math.min(n - s, v.i0)); v.i1 = v.i0 + s;
  };
  const zoomAt = (v, f, k) => {
    const at = v.i0 + f * (v.i1 - v.i0);
    v.i0 = at - (at - v.i0) * k; v.i1 = at + (v.i1 - at) * k; clamp(v);
  };
  // 滚轮：Ctrl/⌘ + 滚轮 = 图表缩放；普通滚轮【不拦截】，让页面正常滚动。
  // （遥测图上直接滚轮缩放是 Garage61 的做法，但用户反馈与翻页冲突，改成按键组合）
  cv.onwheel = e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const c = getCfg(); if (!c) return;
    zoomAt(c.view, frac(e.clientX), e.deltaY > 0 ? 1.2 : 1 / 1.2);
    onView && onView();
  };
  cv.onpointerdown = e => {
    cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e.clientX);
    if (pointers.size === 2) {
      const xs = [...pointers.values()];
      const c = getCfg(); if (!c) return;
      pinch = { d0: Math.abs(xs[1] - xs[0]) || 1, v0: c.view.i0, v1: c.view.i1, f: (frac(xs[0]) + frac(xs[1])) / 2 };
      pan = null; return;
    }
    const c = getCfg(); if (!c) return;
    pan = { x: e.clientX, i0: c.view.i0, i1: c.view.i1 };
    if (e.pointerType === 'touch') { c.hoverIdx = Math.round((c.view.i0 + frac(e.clientX) * (c.view.i1 - c.view.i0))); onView && onView(); }
  };
  cv.onpointermove = e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e.clientX);
    const c = getCfg(); if (!c) return;
    if (pinch && pointers.size >= 2) {
      const xs = [...pointers.values()];
      const d = Math.abs(xs[1] - xs[0]) || 1;
      c.view.i0 = pinch.v0; c.view.i1 = pinch.v1;
      zoomAt(c.view, pinch.f, pinch.d0 / d); onView && onView(); return;
    }
    if (pan) {
      const dx = (e.clientX - pan.x) / plotW() * (pan.i1 - pan.i0);
      c.view.i0 = pan.i0 - dx; c.view.i1 = pan.i1 - dx; clamp(c.view); onView && onView(); return;
    }
    c.hoverIdx = Math.round(c.view.i0 + frac(e.clientX) * (c.view.i1 - c.view.i0));
    onView && onView();
  };
  const end = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) pan = null; };
  cv.onpointerup = end; cv.onpointercancel = end;
  cv.onpointerleave = () => { const c = getCfg(); if (c) { c.hoverIdx = null; pan = null; onView && onView(); } };
  cv.ondblclick = () => { const c = getCfg(); if (c) { c.view.i0 = 0; c.view.i1 = N(); onView && onView(); } };
}
/* 图表缩放工具条：注入图表头部容器（holder），提供 缩小 / 复位 / 放大。
   普通滚轮不再缩放（让位给页面滚动），缩放靠 Ctrl+滚轮、双指、双击复位、或这三个按钮。 */
function chartTools(holder, cv, getCfg, onView) {
  if (!holder || !cv) return;
  if (holder.querySelector('.ctbtn')) return;             // 只注入一次
  holder.classList.add('ctwrap');
  const mark = document.createElement('span');
  mark.className = 'ctmark';
  mark.title = 'Ctrl/⌘ + 滚轮 = 缩放，普通滚轮 = 翻页；双击图 = 复位';
  mark.textContent = 'Ctrl+滚轮缩放 · 双击复位';
  holder.appendChild(mark);
  const group = document.createElement('span');
  group.className = 'ctgroup';
  group.innerHTML = '<button class="ctbtn" data-z="-1" title="缩小">−</button>' +
    '<button class="ctbtn" data-z="0" title="复位视图">⤢</button>' +
    '<button class="ctbtn" data-z="1" title="放大">＋</button>';
  holder.appendChild(group);
  holder.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('.ctbtn') : null;
    if (!b) return;
    const c = getCfg(); if (!c || !c.series || !c.series[0] || !c.series[0].data) return;
    const n = c.series[0].data.length - 1, v = c.view;
    const z = b.dataset.z;
    if (z === '0') { v.i0 = 0; v.i1 = n; }
    else {
      const at = (v.i0 + v.i1) / 2;
      const k = z === '1' ? 1 / 1.6 : 1.6;
      v.i0 = at - (at - v.i0) * k; v.i1 = at + (v.i1 - at) * k;
      const s = Math.min(n, Math.max(4, v.i1 - v.i0));
      v.i0 = Math.max(0, Math.min(n - s, v.i0)); v.i1 = v.i0 + s;
    }
    onView && onView();
  });
}

/* ================================================================
   多页面适配层
   core.js 的 loadFile / loadIBT 原本调用 renderSidebar / selectSession
   （那是单页界面的函数，已被拆走），这里补上多页面语义的实现，
   让「上传」在任意页面都能正常工作。
   ================================================================ */
let pageRefresh = null;        // 各页面通过 bootPage() 注册的重绘函数
function renderSidebar() { renderSessionBar(pageRefresh); }
function selectSession(id) {
  setCurSession(id);
  renderSessionBar(pageRefresh);
  if (pageRefresh) pageRefresh();
}

/* 上传文件（支持多选 / 拖拽） */
function uploadFiles(fileList, onDone) {
  let n = 0;
  const files = [...fileList].filter(f => /\.(vbo|ibt)$/i.test(f.name));
  if (!files.length) { showLoadError('只支持 .vbo（卡丁车 VBOX）和 .ibt（iRacing）文件'); return; }
  for (const f of files) {
    n++;
    loadFile(f, s => { if (s) { setCurSession(s.id); } if (onDone) onDone(s); });
  }
  return n;
}
/* 绑定顶栏的「+ 上传」和整页拖拽 */
function setupUpload(inputId, onDone) {
  const inp = document.getElementById(inputId);
  if (inp) inp.onchange = e => { uploadFiles(e.target.files, onDone); e.target.value = ''; };
  // 整页拖拽：多页面下每个页面都能直接拖文件进来
  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', e => {
    if (e.relatedTarget == null) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', e => {
    e.preventDefault(); document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files, onDone);
  });
}
/* 圈选择 chips（多页面复用）。laps 为 analysis.full，sel 为已选 index 数组 */
function renderLapChips(box, laps, sel, onToggle, markWarn) {
  if (!box) return;
  const median = laps.length ? [...laps].map(l => l.time_s).sort((a, b) => a - b)[laps.length >> 1] : 0;
  box.innerHTML = laps.map(l => {
    const warn = markWarn && median && l.time_s > median * 1.06;
    return `<button class="lapchip ${sel.includes(l.index) ? 'on' : ''} ${warn ? 'warn' : ''}" data-lap="${l.index}"
      title="${warn ? '比中位圈慢 6% 以上，可能是出场圈/失误圈' : ''}">#${l.index}<span class="lt">${fmtTime(l.time_s, 2)}</span></button>`;
  }).join('');
  box.onclick = e => {
    const b = e.target.closest ? e.target.closest('.lapchip') : null;
    if (b) onToggle(+b.dataset.lap);
  };
}
/* 时间差着色：正数=丢时间(红)，负数=捡时间(绿) */
function deltaCls(v) { return v > 0.005 ? 'd-pos' : (v < -0.005 ? 'd-neg' : 'd-zero'); }
function deltaTxt(v, digits) {
  const d = digits == null ? 3 : digits;
  return (v > 0 ? '+' : '') + v.toFixed(d) + 's';
}
