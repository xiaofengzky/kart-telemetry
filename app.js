/* Kart Telemetry — 浏览器端 .vbo 解析与赛道分析 */
'use strict';

const SESSIONS = [];      // {id,name,date,points,offset,analysis}
let curId = null;
let map, trackLayer, satLayer, darkLayer, picking = false;
let myMarker = null;          // 当前位置标记

const RAD = Math.PI / 180;
const angDiff = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

/* ---------- 解析 ---------- */
function parseCoord(c, isLat) {
  let sign = 1;
  if (c[0] === '-') { sign = -1; c = c.slice(1); }
  c = c.replace(/\+/g, '');
  let deg, min;
  if (isLat) { deg = parseFloat(c.slice(0, 2)); min = parseFloat(c.slice(2)); }
  else { deg = parseFloat(c.slice(0, 3)); min = parseFloat(c.slice(3)); }
  return sign * (deg + min / 60);
}
function timeToSec(t) {
  const h = parseInt(t.slice(0, 2), 10), m = parseInt(t.slice(2, 4), 10), s = parseFloat(t.slice(4));
  return h * 3600 + m * 60 + s;
}
function parseVBO(text) {
  const comments = {};
  const cm = text.match(/Track:\s*(.+)/); if (cm) comments.track = cm[1].trim();
  const tm = text.match(/Beijing Time:\s*([\d\-: ]+)/); if (tm) comments.beijing = tm[1].trim();
  const di = text.indexOf('[data]');
  if (di < 0) return null;
  const lines = text.slice(di).split('\n');
  const pts = [];
  for (let ln of lines) {
    ln = ln.trim();
    if (!ln) continue;
    const p = ln.split(/\s+/);
    if (p.length < 10) continue;
    try {
      const lat = parseCoord(p[2], true);
      const lon = parseCoord(p[3], false);
      const vel = parseFloat(p[4]);
      const hdg = parseFloat(p[5]);
      pts.push({ lat, lon, vel, hdg, t: timeToSec(p[1]) });
    } catch (e) { /* skip */ }
  }
  return { comments, points: pts };
}

/* ---------- 分析 ---------- */
function project(points) {
  let mlat = 0, mlon = 0;
  for (const p of points) { mlat += p.lat; mlon += p.lon; }
  mlat /= points.length; mlon /= points.length;
  const R = 6371000;
  return points.map(p => ({
    x: (p.lon - mlon) * RAD * R * Math.cos(mlat * RAD),
    y: (p.lat - mlat) * RAD * R
  }));
}
function analyze(points) {
  const n = points.length;
  const xy = project(points);
  const cum = [0];
  for (let i = 1; i < n; i++) {
    cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
  }
  // 横向G + 纵向G
  const latg = new Array(n).fill(0), longa = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const v = (points[i - 1].vel + points[i + 1].vel) / 2 / 3.6;
    const dh = angDiff(points[i + 1].hdg, points[i - 1].hdg);
    const dth = (points[i + 1].t - points[i - 1].t) || (2 / 25);
    latg[i] = v > 1 ? (v * (dh * RAD / dth) / 9.81) : 0;
    longa[i] = ((points[i + 1].vel - points[i - 1].vel) / 3.6) / dth / 9.81;
  }
  // 圈速：回到起点
  const sx = xy[0].x, sy = xy[0].y;
  const dstart = xy.map(p => Math.hypot(p.x - sx, p.y - sy));
  const crossings = [0]; let lastProg = cum[0];
  let i = 1;
  while (i < n) {
    if (dstart[i] < 18) {
      let j = i, best = i, bd = dstart[i];
      while (j < n && dstart[j] < 18) { if (dstart[j] < bd) { bd = dstart[j]; best = j; } j++; }
      if (cum[best] - lastProg > 120) { crossings.push(best); lastProg = cum[best]; }
      i = j;
    } else i++;
  }
  const laps = [];
  for (let k = 1; k < crossings.length; k++) {
    const a = crossings[k - 1], b = crossings[k];
    const seg = [];
    for (let t = a; t <= b; t++) seg.push(points[t].vel);
    let mg = 0; for (let t = a; t <= b; t++) mg = Math.max(mg, Math.abs(latg[t]));
    laps.push({
      index: k, startIdx: a, endIdx: b,
      time_s: points[b].t - points[a].t,
      distance_m: cum[b] - cum[a],
      max_speed: Math.max(...seg), min_speed: Math.min(...seg),
      avg_speed: seg.reduce((s, v) => s + v, 0) / seg.length, max_g: mg
    });
  }
  const full = laps.filter(l => l.time_s > 5);
  const best = full.length ? full.reduce((m, l) => l.time_s < m.time_s ? l : m) : null;
  const times = full.map(l => l.time_s);
  const avg = times.reduce((s, v) => s + v, 0) / (times.length || 1);
  const std = times.length ? Math.sqrt(times.reduce((s, v) => s + (v - avg) ** 2, 0) / times.length) : 0;
  const core = times.filter(t => Math.abs(t - avg) <= 1.6 * std);
  const coreAvg = core.length ? core.reduce((s, v) => s + v, 0) / core.length : avg;
  const coreStd = core.length > 1 ? Math.sqrt(core.reduce((s, v) => s + (v - coreAvg) ** 2, 0) / core.length) : 0;
  const grade = coreStd < 0.25 ? 'A 极佳' : coreStd < 0.5 ? 'B 良好' : coreStd < 0.9 ? 'C 一般' : 'D 波动大';
  const gradeCol = coreStd < 0.25 ? 'var(--green)' : coreStd < 0.5 ? 'var(--blue)' : coreStd < 0.9 ? 'var(--amber)' : 'var(--accent)';

  // 弯角（最快圈）
  const corners = [];
  if (best) {
    const a = best.startIdx, b = best.endIdx, thr = 0.42, raw = [];
    let inc = false, st = 0;
    for (let t = a; t <= b; t++) {
      const isc = Math.abs(latg[t]) > thr && points[t].vel > 10;
      if (isc && !inc) { inc = true; st = t; }
      if (!isc && inc) { raw.push([st, t]); inc = false; }
    }
    if (inc) raw.push([st, b]);
    const merged = [];
    for (const [s, e] of raw) {
      if (merged.length && (cum[s] - cum[merged[merged.length - 1][1]]) < 12) merged[merged.length - 1] = [merged[merged.length - 1][0], e];
      else merged.push([s, e]);
    }
    for (const [s, e] of merged) {
      if (cum[e] - cum[s] < 6) continue;
      let ai = s; for (let t = s; t <= e; t++) if (points[t].vel < points[ai].vel) ai = t;
      let mg = 0; for (let t = s; t <= e; t++) mg = Math.max(mg, Math.abs(latg[t]));
      if (mg < 0.4) continue;
      const entry = points[Math.max(s - 4, a)].vel, exitv = points[Math.min(e + 4, b)].vel;
      if (entry - points[ai].vel < 1.5) continue;
      corners.push({
        id: corners.length + 1, apexIdx: ai,
        progress_pct: Math.round(100 * (cum[ai] - cum[a]) / best.distance_m * 10) / 10,
        entry_speed: Math.round(entry * 10) / 10, apex_speed: Math.round(points[ai].vel * 10) / 10,
        exit_speed: Math.round(exitv * 10) / 10, max_g: Math.round(mg * 100) / 100,
        speed_loss: Math.round((entry - points[ai].vel) * 10) / 10, length_m: Math.round((cum[e] - cum[s]) * 10) / 10
      });
    }
  }
  // 最快圈速度/G 曲线（100点）
  const sp = [], gp = [];
  if (best) {
    const a = best.startIdx, b = best.endIdx, D = best.distance_m;
    for (let pct = 0; pct <= 100; pct++) {
      const target = cum[a] + pct / 100 * D;
      let ti = a; while (ti < b && cum[ti] < target) ti++;
      sp.push([pct, Math.round(points[ti].vel * 10) / 10]);
      gp.push([pct, Math.round(Math.abs(latg[ti]) * 100) / 100]);
    }
  }
  // 分段 & 波动区
  const sectors = [];
  if (full.length) {
    const Dref = full.map(l => l.distance_m).sort((x, y) => x - y)[full.length >> 1];
    const bounds = [0, .25, .5, .75, 1].map(x => x * Dref);
    const st = [[], [], [], []];
    for (const l of full) {
      const a = l.startIdx, base = cum[a];
      const idx = bounds.map(bd => { let ti = a; while (ti < l.endIdx && (cum[ti] - base) < bd) ti++; return ti; });
      for (let k = 0; k < 4; k++) st[k].push(points[idx[k + 1]].t - points[idx[k]].t);
    }
    for (let k = 0; k < 4; k++) {
      const v = st[k], m = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
      sectors.push({ sector: k + 1, mean_s: Math.round(m * 100) / 100, std_s: Math.round(sd * 100) / 100, best_s: Math.round(Math.min(...v) * 100) / 100 });
    }
  }
  const worst = [];
  // 波动区：跨圈同进度速度标准差
  const bands = 100, bs = Array.from({ length: bands + 1 }, () => []);
  for (const l of full) {
    const a = l.startIdx, b = l.endIdx, D = l.distance_m;
    for (let pct = 0; pct <= bands; pct++) {
      const target = cum[a] + pct / bands * D;
      let ti = a; while (ti < b && cum[ti] < target) ti++;
      bs[pct].push(points[ti].vel);
    }
  }
  const worstZones = [];
  const cands = [];
  for (let pct = 0; pct <= bands; pct++) {
    const vals = bs[pct];
    if (vals.length < 2) continue;
    const m = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
    cands.push([sd, pct, m]);
  }
  cands.sort((x, y) => y[0] - x[0]);
  for (const [sd, pct, m] of cands.slice(0, 3)) worstZones.push({ progress_pct: pct, mean_speed: Math.round(m * 10) / 10, std: Math.round(sd * 10) / 10 });
  const vels = points.map(p => p.vel);
  return {
    laps, full, best, vmin: Math.min(...vels), vmax: Math.max(...vels),
    best_time: best ? Math.round(best.time_s * 100) / 100 : null,
    avg_lap: Math.round(avg * 100) / 100, core_avg: Math.round(coreAvg * 100) / 100,
    core_std: Math.round(coreStd * 100) / 100, grade, gradeCol,
    corners, speedProfile: sp, gProfile: gp, sectors, worstZones, xy, cum
  };
}

/* ---------- 颜色 ---------- */
function speedColor(t) {
  t = Math.max(0, Math.min(1, t));
  const hue = 220 - 220 * t;
  const s = .7, l = .48, c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = l - c / 2;
  let r, g, b;
  if (hue < 60) [r, g, b] = [c, x, 0]; else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x]; else if (hue < 240) [r, g, b] = [0, x, c]; else [r, g, b] = [c, 0, 0];
  return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
}

/* ---------- 地图 ---------- */
function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView([14.9, 8.2], 15);
  satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
  darkLayer = L.tileLayer('https://cartodb-basemaps-a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abcd', attribution: 'CARTO' });
  satLayer.addTo(map);
  L.control.layers({ '卫星': satLayer, '暗色': darkLayer }, null, { position: 'topright' }).addTo(map);
  trackLayer = L.layerGroup().addTo(map);
  setTimeout(() => map && map.invalidateSize(), 200);
  map.on('click', e => {
    if (!picking || !curId) return;
    const s = SESSIONS.find(x => x.id === curId);
    applyAlign(s, e.latlng.lat, e.latlng.lng);
    picking = false; document.getElementById('pickAlign').classList.add('ghost');
    document.getElementById('alignNote').textContent = '已按地图点击位置对齐。';
    document.getElementById('alignNote').style.display = 'block';
  });
}
function plotPt(s, i) { return [s.points[i].lat + s.offset.dLat, s.points[i].lon + s.offset.dLon]; }
function drawTrack(s) {
  trackLayer.clearLayers();
  const dec = Math.max(1, Math.floor(s.points.length / 1500));
  const vmin = s.analysis.vmin, vmax = s.analysis.vmax, span = (vmax - vmin) || 1;
  for (let i = 1; i < s.points.length; i += dec) {
    const j = Math.min(i, s.points.length - 1);
    const a = plotPt(s, i - 1), b = plotPt(s, j);
    const vavg = (s.points[i - 1].vel + s.points[j].vel) / 2;
    trackLayer.addLayer(L.polyline([a, b], { color: speedColor((vavg - vmin) / span), weight: 3.2, opacity: .95, lineCap: 'round' }));
  }
  for (const c of s.analysis.corners) {
    const p = plotPt(s, c.apexIdx);
    trackLayer.addLayer(L.circleMarker(p, { radius: 9, color: '#fff', weight: 1.5, fillColor: '#222', fillOpacity: 1 }));
    trackLayer.addLayer(L.marker(p, { icon: L.divIcon({ className: '', html: `<div style="color:#fff;font:700 11px sans-serif;text-align:center;transform:translateY(-1px)">${c.id}</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) }));
  }
  const bnds = L.latLngBounds(s.points.map((_, i) => plotPt(s, i)));
  map.fitBounds(bnds, { padding: [40, 40] });
}

/* ---------- 渲染 ---------- */
function renderSidebar() {
  document.getElementById('sessCount').textContent = SESSIONS.length;
  const list = document.getElementById('sessList');
  list.innerHTML = '';
  document.getElementById('emptyHint').style.display = SESSIONS.length ? 'none' : 'block';
  for (const s of SESSIONS) {
    const a = s.analysis;
    const el = document.createElement('div');
    el.className = 'sess' + (s.id === curId ? ' active' : '');
    el.innerHTML = `<div class="sname">${esc(s.name)}<span class="strack">${a.full.length} 圈</span></div>
      <div class="sdate">${esc(s.date)}</div>
      <div class="sstat"><span>最快 <b>${a.best_time != null ? a.best_time.toFixed(2) : '-'}s</b></span>
      <span>极速 <b>${a.vmax.toFixed(0)}</b></span><span>最高G <b>${Math.max(0, ...a.corners.map(c => c.max_g)).toFixed(2)}</b></span></div>`;
    el.onclick = () => selectSession(s.id);
    list.appendChild(el);
  }
}
function selectSession(id) {
  curId = id; const s = SESSIONS.find(x => x.id === id);
  renderSidebar(); drawTrack(s); renderDetail(s);
  // 对齐框
  const cen = centroidPlot(s);
  document.getElementById('alignLat').value = cen.lat.toFixed(5);
  document.getElementById('alignLon').value = cen.lon.toFixed(5);
  document.getElementById('alignNote').style.display = 'none';
  picking = false; document.getElementById('pickAlign').classList.add('ghost');
  document.getElementById('mapBadge').textContent = '卫星图 · ' + s.name;
}
function centroidPlot(s) {
  let la = 0, lo = 0;
  for (let i = 0; i < s.points.length; i++) { const p = plotPt(s, i); la += p[0]; lo += p[1]; }
  return { lat: la / s.points.length, lon: lo / s.points.length };
}
function renderDetail(s) {
  const a = s.analysis;
  const maxT = Math.max(...a.laps.map(l => l.time_s));
  const bestIdx = a.best ? a.best.index : -1;
  let lapHtml = a.laps.map(l => {
    const w = Math.max(4, 100 * (1 - (l.time_s - (a.best_time || l.time_s)) / (maxT - (a.best_time || l.time_s) || 1)));
    return `<div class="lap${l.index === bestIdx ? ' best' : ''}"><span class="ln">#${l.index}</span>
      <span class="lbar"><span class="lfill" style="width:${w}%"></span></span>
      <span class="lt">${l.time_s.toFixed(2)}s</span></div>`;
  }).join('');

  let cornerHtml = a.corners.length ? `<table class="ctab"><tr><th>弯</th><th>进度</th><th>入弯</th><th>弯心</th><th>出弯</th><th>横向G</th><th>损失</th></tr>
    ${a.corners.map(c => `<tr><td>${c.id}</td><td>${c.progress_pct}%</td><td>${c.entry_speed}</td><td class="b">${c.apex_speed}</td><td>${c.exit_speed}</td><td>${c.max_g}</td><td>${c.speed_loss}</td></tr>`).join('')}</table>`
    : '<div class="satnote">未能识别明显弯角。</div>';

  // 建议
  const worst = a.worstZones[0];
  const worstSec = a.sectors.length ? a.sectors.reduce((m, x) => x.std_s > m.std_s ? x : m) : null;
  const ic = [...a.corners].sort((x, y) => y.speed_loss - x.speed_loss).slice(0, 2);
  const minGc = a.corners.length ? a.corners.reduce((m, x) => x.max_g < m.max_g ? x : m) : null;
  const maxG = a.corners.length ? Math.max(...a.corners.map(c => c.max_g)) : 0;
  let adv = '';
  if (a.best) {
    adv = `<ul>
      <li><b>整体节奏：</b>${worstSec ? `第 ${worstSec.sector} 段最不稳定（圈速标准差 ${worstSec.std_s.toFixed(2)}s）。` : ''}核心 ${a.full.length} 圈标准差仅 ${a.core_std.toFixed(2)}s，最快 ${a.best_time.toFixed(2)}s、核心均速 ${a.core_avg.toFixed(2)}s，差距 ${(a.core_avg - a.best_time).toFixed(2)}s。</li>
      <li><b>最大波动区：</b>${worst ? `赛道进度 ${worst.progress_pct}% 附近速度每圈差 ${worst.std} km/h，走线/刹车点不固定，是最容易捡时间的地方。` : '数据较一致。'}</li>
      <li><b>丢速度最多的弯：</b>${ic.map(c => `C${c.id} 损失 ${c.speed_loss} km/h（入 ${c.entry_speed}→弯心 ${c.apex_speed}）`).join('；')}。出弯速度（${ic.map(c => c.exit_speed).join(' / ')}）还有空间，练"晚刹+弯心保速+早给油"。</li>
      <li><b>抓地利用：</b>最高横向G 达 ${maxG.toFixed(2)}；横向G 最低的 C${minGc ? minGc.id : '-'} 仅 ${minGc ? minGc.max_g.toFixed(2) : '-'}G，可稍晚刹车多带速。</li>
    </ul>`;
  }

  document.getElementById('detail').innerHTML = `
    <div class="dhead"><h2>${esc(s.name)}</h2><span class="dt">${esc(s.date)}</span></div>
    <div class="statgrid">
      <div class="stat"><div class="v">${a.best_time != null ? a.best_time.toFixed(2) + 's' : '-'}</div><div class="k">最快圈</div></div>
      <div class="stat"><div class="v">${a.core_avg.toFixed(2) + 's'}</div><div class="k">核心均速</div></div>
      <div class="stat"><div class="v" style="color:${a.gradeCol}">${a.grade}</div><div class="k">一致性</div></div>
      <div class="stat"><div class="v">${a.vmax.toFixed(0)}</div><div class="k">极速 km/h</div></div>
      <div class="stat"><div class="v">${maxG.toFixed(2)}</div><div class="k">最高G</div></div>
      <div class="stat"><div class="v">${a.full.length}</div><div class="k">有效圈</div></div>
    </div>
    <div class="secblock"><h3>圈速</h3><div class="laplist">${lapHtml}</div></div>
    <div class="secblock"><h3>最快圈 速度 / 横向G</h3><canvas id="chart" class="chart" width="660" height="280"></canvas>
      <div class="satnote">横轴=赛道进度0→100%；蓝=速度km/h，红=横向G；虚线=弯角位置</div></div>
    <div class="secblock"><h3>弯角明细（最快圈）</h3>${cornerHtml}</div>
    <div class="secblock"><div class="adv"><h3 style="color:var(--amber);border-left-color:var(--amber);margin-top:0">提升点</h3>${adv}</div></div>
    <div class="satnote">注：本 .vbo 的 GPS 为偏移坐标，赛道<b>形状</b>准确。左下角"对齐真实场地"可把赛道平移到真实卫星位置。</div>`;
  drawChart(document.getElementById('chart'), a.speedProfile, a.gProfile, a.corners);
}
function drawChart(cv, sp, gp, corners) {
  if (!cv || !sp.length) return;
  const W = cv.width, H = cv.height, padL = 38, padR = 38, padT = 14, padB = 22;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const vmax = Math.max(...sp.map(p => p[1])) * 1.05 || 1;
  const gmax = Math.max(...gp.map(p => p[1])) * 1.1 || 3;
  const sx = p => padL + p / 100 * (W - padL - padR);
  const syv = v => H - padB - v / vmax * (H - padT - padB);
  const syg = g => H - padB - g / gmax * (H - padT - padB);
  // 弯角竖线
  ctx.strokeStyle = '#7a6a3a'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  for (const c of corners) { ctx.beginPath(); ctx.moveTo(sx(c.progress_pct), padT); ctx.lineTo(sx(c.progress_pct), H - padB); ctx.stroke(); }
  ctx.setLineDash([]);
  // 速度
  ctx.strokeStyle = '#3b9eff'; ctx.lineWidth = 2; ctx.beginPath();
  sp.forEach((p, i) => { const x = sx(p[0]), y = syv(p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  // G
  ctx.strokeStyle = '#e10600'; ctx.lineWidth = 1.6; ctx.beginPath();
  gp.forEach((p, i) => { const x = sx(p[0]), y = syg(p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  // 刻度
  ctx.fillStyle = '#3b9eff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) { const v = vmax * k / 4; ctx.fillText(v.toFixed(0), padL - 4, syv(v) + 3); }
  ctx.fillStyle = '#e10600'; ctx.textAlign = 'left';
  for (let k = 0; k <= 4; k++) { const g = gmax * k / 4; ctx.fillText(g.toFixed(1) + 'G', W - padR + 4, syg(g) + 3); }
  ctx.fillStyle = '#8b98a5'; ctx.textAlign = 'center';
  ctx.fillText('赛道进度 →', W / 2, H - 6);
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* ---------- 对齐 ---------- */
function applyAlign(s, lat, lon) {
  const cen = centroidPlot(s);
  s.offset.dLat = lat - cen.lat; s.offset.dLon = lon - cen.lon;
  drawTrack(s);
}

/* ---------- 我的位置（浏览器定位） ---------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function setMyPosMsg(html) { const b = document.getElementById('myPos'); b.style.display = 'block'; b.innerHTML = html; }
function locateMe() {
  const btn = document.getElementById('locateBtn');
  if (!navigator.geolocation) { setMyPosMsg('<div class="merr">⚠ 此浏览器不支持定位</div>'); return; }
  if (!window.isSecureContext) {
    setMyPosMsg('<div class="merr">⚠ 定位需安全环境：请用 <b>http://localhost</b> 打开本页（file:// 下浏览器禁用定位）。<br>可在本目录运行 <b>python -m http.server</b> 后访问 localhost。</div>');
    return;
  }
  btn.classList.add('busy'); btn.textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(pos => {
    btn.classList.remove('busy'); btn.textContent = '📍 定位我';
    showMyPos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy || 0);
  }, err => {
    btn.classList.remove('busy'); btn.textContent = '📍 定位我';
    let msg = '定位失败';
    if (err.code === 1) msg = '定位被拒绝：请在浏览器地址栏允许本站点的定位权限';
    else if (err.code === 2) msg = '定位不可用：设备无 GPS 信号或网络受限';
    else if (err.code === 3) msg = '定位超时（' + (err.message || '') + '）';
    setMyPosMsg('<div class="merr">⚠ ' + msg + '。<br>建议用 <b>http://localhost</b> 打开本页再试。</div>');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}
function showMyPos(lat, lon, acc) {
  const ll = [lat, lon];
  if (myMarker) myMarker.setLatLng(ll);
  else myMarker = L.marker(ll, {
    icon: L.divIcon({ className: '', html: '<div class="locpin"><div class="locring"></div><div class="locdot"></div></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    zIndexOffset: 1000
  }).addTo(map);
  myMarker.bindPopup('📍 你在这里<br>' + lat.toFixed(5) + ', ' + lon.toFixed(5) + '<br>精度 ±' + acc.toFixed(0) + ' m').openPopup();
  map.flyTo(ll, Math.max(map.getZoom(), 16));
  let distTxt = '';
  const s = SESSIONS.find(x => x.id === curId);
  if (s) {
    const c = centroidPlot(s);
    const d = haversine(lat, lon, c.lat, c.lon);
    distTxt = '<div class="mdist">距当前赛道中心约 <b>' + d.toFixed(1) + ' km</b><br>可用左下「对齐真实场地」校正 GPS 偏移</div>';
  }
  setMyPosMsg('<div class="mlat">📍 我的位置</div>' + lat.toFixed(5) + ', ' + lon.toFixed(5) + '<br>精度 ±' + acc.toFixed(0) + ' m' + distTxt);
}

/* ---------- 加载文件 ---------- */
function loadFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const parsed = parseVBO(e.target.result);
    if (!parsed || !parsed.points.length) { alert('无法解析：' + file.name); return; }
    const name = (parsed.comments.track && parsed.comments.track !== 'carrot2') ? parsed.comments.track
      : (parsed.comments.track || file.name.replace(/\.vbo$/i, ''));
    const date = parsed.comments.beijing || ('UTC ' + parsed.points[0].t.toFixed(0));
    const id = Date.now() + '_' + SESSIONS.length;
    const s = { id, name, date, points: parsed.points, offset: { dLat: 0, dLon: 0 }, analysis: analyze(parsed.points) };
    SESSIONS.push(s);
    renderSidebar();
    if (SESSIONS.length === 1) selectSession(id);
  };
  reader.readAsText(file);
}
function setupIO() {
  const input = document.getElementById('fileInput');
  input.addEventListener('change', e => { for (const f of e.target.files) loadFile(f); input.value = ''; });
  const dz = document.getElementById('dropZone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => { e.stopPropagation(); for (const f of e.dataTransfer.files) if (/\.vbo$/i.test(f.name)) loadFile(f); });
  // 整页也能拖
  ['dragover'].forEach(ev => document.body.addEventListener(ev, e => e.preventDefault()));
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) if (/\.vbo$/i.test(f.name)) loadFile(f);
  });
  document.getElementById('applyAlign').onclick = () => {
    const s = SESSIONS.find(x => x.id === curId); if (!s) return;
    const lat = parseFloat(document.getElementById('alignLat').value), lon = parseFloat(document.getElementById('alignLon').value);
    if (isNaN(lat) || isNaN(lon)) return;
    applyAlign(s, lat, lon);
    document.getElementById('alignNote').textContent = '已对齐到 ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
    document.getElementById('alignNote').style.display = 'block';
  };
  document.getElementById('pickAlign').onclick = () => {
    picking = !picking;
    document.getElementById('pickAlign').classList.toggle('ghost', !picking);
    document.getElementById('alignNote').textContent = picking ? '请在卫星图上点击赛道真实中心位置…' : '';
    document.getElementById('alignNote').style.display = picking ? 'block' : 'none';
  };
  document.getElementById('resetAlign').onclick = () => {
    const s = SESSIONS.find(x => x.id === curId); if (!s) return;
    s.offset = { dLat: 0, dLon: 0 }; drawTrack(s);
    const cen = centroidPlot(s);
    document.getElementById('alignLat').value = cen.lat.toFixed(5);
    document.getElementById('alignLon').value = cen.lon.toFixed(5);
    document.getElementById('alignNote').style.display = 'none';
  };
  document.getElementById('locateBtn').onclick = locateMe;
}
window.addEventListener('DOMContentLoaded', () => { initMap(); setupIO(); });
