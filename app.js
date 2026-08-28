/* Kart Telemetry — 浏览器端 .vbo 解析与赛道分析 */
'use strict';

const SESSIONS = [];      // {id,name,date,points,offset,analysis}
let curId = null;
let map, trackLayer, satLayer, darkLayer, esriTopo, esriRelief, picking = false;
let selLap = null;          // 刹车/油门事件表当前选中的圈
let myMarker = null;          // 当前位置标记
let cmpLaps = new Set();    // 速度对比图当前勾选的圈
const CMP_COLORS = ['#3b9eff', '#e10600', '#2ecc71', '#f5a623', '#a259ff', '#16d6c9', '#ff7ac6', '#ffd23f', '#7ed957', '#ff6b6b'];
const cmpColor = i => CMP_COLORS[(i - 1) % CMP_COLORS.length];

const RAD = Math.PI / 180;
const angDiff = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

/* ---------- 解析 ----------
   VBO 官方格式（Racelogic）：经纬度存的是【十进制分钟】，不是 NMEA 的 ddmm！
     latitude  = MMMM.MMMMMMMM  (+ve = 北纬)
     longitude = MMMMM.MMMMMMMM (+ve = 西经)  <-- 注意：正数表示西经，与我们习惯相反
   所以：纬度 = 值/60；经度 = -值/60（转成"东经为正"的通用经度）
   之前误按 ddmm 解析，导致坐标被算到 14.9N/-68.8E（委内瑞拉），这就是"位置偏移"的真凶。 */
function parseCoord(c, isLat) {
  const v = parseFloat(c.replace(/\+/g, ''));
  if (!isFinite(v)) return 0;
  return isLat ? (v / 60) : (-v / 60);
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
      const h = parseFloat(p[6]);
      pts.push({ lat, lon, vel, hdg, h: isFinite(h) ? h : null, t: timeToSec(p[1]) });
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
/* 从纵向 G(driveG) 推导单圈刹车/油门事件与指标。卡丁车多无刹车传感器，专业做法是读 longitudinal G：
   向下突刺=刹车点(起始)、深度=刹车力度、宽度=刹车距离；正向加速段=油门点(出弯)。
   用较高阈值并过滤/合并短抖动，只保留真正有意义的驾驶阶段。 */
function lapEvents(points, cum, driveG, latg, a, b, dist, vmax) {
  const thrB = 0.35, thrT = 0.28, minLen = 2.5, mergeGap = 10;
  // 用平滑后的 driveG 做阶段检测（抑制 25Hz 噪声），峰值仍用原始 driveG 保证准
  const sm = new Array(b - a + 1);
  for (let t = a; t <= b; t++) { let s = 0, c = 0; for (let k = Math.max(a, t - 1); k <= Math.min(b, t + 1); k++) { s += driveG[k]; c++; } sm[t] = s / c; }
  const phases = (sign, thr) => {
    const raw = []; let inc = false, st = 0;
    for (let t = a; t <= b; t++) {
      const on = sign < 0 ? sm[t] < -thr : sm[t] > thr;
      if (on && !inc) { inc = true; st = t; }
      if (!on && inc) { raw.push([st, t - 1]); inc = false; }
    }
    if (inc) raw.push([st, b]);
    const filt = raw.filter(([s, e]) => (cum[e] - cum[s]) >= minLen);   // 去掉单点噪声
    const merged = [];
    for (const seg of filt) {                                             // 合并相邻同类型阶段
      if (merged.length && (cum[seg[0]] - cum[merged[merged.length - 1][1]]) < mergeGap) merged[merged.length - 1] = [merged[merged.length - 1][0], seg[1]];
      else merged.push(seg);
    }
    return merged;
  };
  const pkOf = (s, e, sign) => { let pk = s; for (let k = s; k <= e; k++) if (sign < 0 ? driveG[k] < driveG[pk] : driveG[k] > driveG[pk]) pk = k; return pk; };
  const brakes = phases(-1, thrB).map(([s, e]) => {
    const pk = pkOf(s, e, -1);
    let lo = points[pk].vel, loi = pk;
    for (let k = pk; k <= e; k++) if (points[k].vel < lo) { lo = points[k].vel; loi = k; }
    return {
      progress: Math.round(100 * (cum[s] - cum[a]) / dist * 10) / 10,
      peakG: Math.round(-driveG[pk] * 100) / 100,
      dist_m: Math.round((cum[e] - cum[s]) * 10) / 10,
      entrySpeed: Math.round(points[s].vel * 10) / 10,
      minSpeed: Math.round(lo * 10) / 10
    };
  });
  const throttles = phases(1, thrT).map(([s, e]) => {
    const pk = pkOf(s, e, 1);
    return {
      progress: Math.round(100 * (cum[s] - cum[a]) / dist * 10) / 10,
      peakG: Math.round(driveG[pk] * 100) / 100,
      dist_m: Math.round((cum[e] - cum[s]) * 10) / 10,
      startSpeed: Math.round(points[s].vel * 10) / 10,
      endSpeed: Math.round(points[e].vel * 10) / 10
    };
  });
  let peakBrake = 0, peakThrottle = 0, gsum = 0;
  for (let t = a; t <= b; t++) {
    peakBrake = Math.min(peakBrake, driveG[t]);
    peakThrottle = Math.max(peakThrottle, driveG[t]);
    gsum = Math.max(gsum, Math.hypot(driveG[t], latg[t]));
  }
  let fo = 0, tot = 0;
  for (let t = a + 1; t <= b; t++) {
    tot += cum[t] - cum[t - 1];
    if (Math.abs(driveG[t]) < 0.15 && points[t].vel > 0.85 * vmax) fo += cum[t] - cum[t - 1];
  }
  const minSpeed = Math.min(...points.slice(a, b + 1).map(p => p.vel));
  return {
    brakes, throttles,
    metrics: {
      brakeCount: brakes.length, throttleCount: throttles.length,
      peakBrakeG: Math.round(-peakBrake * 100) / 100,
      peakThrottleG: Math.round(peakThrottle * 100) / 100,
      gsumPeak: Math.round(gsum * 100) / 100,
      flatout_pct: tot ? Math.round(fo / tot * 100) : 0,
      minSpeed: Math.round(minSpeed * 10) / 10
    }
  };
}
function analyze(points) {
  const n = points.length;
  const xy = project(points);
  const cum = [0];
  for (let i = 1; i < n; i++) {
    cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
  }
  // 横向G + 纵向G（driveG=分离坡度后的净纵向G：刹车为负，油门为正）
  const latg = new Array(n).fill(0), longa = new Array(n).fill(0), driveG = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const v = (points[i - 1].vel + points[i + 1].vel) / 2 / 3.6;
    const dh = angDiff(points[i + 1].hdg, points[i - 1].hdg);
    const dth = (points[i + 1].t - points[i - 1].t) || (2 / 25);
    latg[i] = v > 1 ? (v * (dh * RAD / dth) / 9.81) : 0;
    const dvdt = ((points[i + 1].vel - points[i - 1].vel) / 3.6) / dth / 9.81;
    let slope = 0;
    if (points[i - 1].h != null && points[i + 1].h != null) {
      const ds = (cum[i + 1] - cum[i - 1]) || 1;
      slope = (points[i + 1].h - points[i - 1].h) / ds;
    }
    driveG[i] = dvdt - slope;
    longa[i] = dvdt;
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
  const maxV = Math.max(...points.map(p => p.vel));
  for (const l of full) {
    const ev = lapEvents(points, cum, driveG, latg, l.startIdx, l.endIdx, l.distance_m, maxV);
    l.brakeEvents = ev.brakes; l.throttleEvents = ev.throttles; l.metrics = ev.metrics;
  }
  const best = full.length ? full.reduce((m, l) => l.time_s < m.time_s ? l : m) : null;
  const times = full.map(l => l.time_s);
  const avg = times.reduce((s, v) => s + v, 0) / (times.length || 1);
  const std = times.length ? Math.sqrt(times.reduce((s, v) => s + (v - avg) ** 2, 0) / times.length) : 0;
  const core = times.filter(t => Math.abs(t - avg) <= 1.6 * std);
  const coreLaps = full.filter(l => Math.abs(l.time_s - avg) <= 1.6 * std);
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
  const sp = [], gp = [], dp = [];
  if (best) {
    const a = best.startIdx, b = best.endIdx, D = best.distance_m;
    for (let pct = 0; pct <= 100; pct++) {
      const target = cum[a] + pct / 100 * D;
      let ti = a; while (ti < b && cum[ti] < target) ti++;
      sp.push([pct, Math.round(points[ti].vel * 10) / 10]);
      gp.push([pct, Math.round(Math.abs(latg[ti]) * 100) / 100]);
      dp.push([pct, Math.round(driveG[ti] * 100) / 100]);
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
  // 刹车点一致性：以最快圈每个刹车点为基准，看核心圈里对应刹车点位置的圈间标准差
  const brakeConsistency = [];
  if (best && coreLaps.length >= 2 && best.brakeEvents && best.brakeEvents.length) {
    for (const re of best.brakeEvents) {
      const arr = [];
      for (const l of coreLaps) {
        if (!l.brakeEvents || !l.brakeEvents.length) continue;
        let be = l.brakeEvents[0], bd = 1e9;
        for (const e of l.brakeEvents) { const d = Math.abs(e.progress - re.progress); if (d < bd) { bd = d; be = e; } }
        arr.push(be.progress);
      }
      if (arr.length >= 2) {
        const m = arr.reduce((s, v) => s + v, 0) / arr.length;
        const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
        brakeConsistency.push({ progress: re.progress, std: Math.round(sd * 100) / 100, peakG: re.peakG });
      }
    }
    brakeConsistency.sort((x, y) => y.std - x.std);
  }
  const vels = points.map(p => p.vel);
  return {
    laps, full, best, vmin: Math.min(...vels), vmax: Math.max(...vels),
    best_time: best ? Math.round(best.time_s * 100) / 100 : null,
    avg_lap: Math.round(avg * 100) / 100, core_avg: Math.round(coreAvg * 100) / 100,
    core_std: Math.round(coreStd * 100) / 100, grade, gradeCol,
    corners, speedProfile: sp, gProfile: gp, longGProfile: dp, sectors, worstZones, brakeConsistency, xy, cum
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
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([30.55, 114.2], 15);
  // 全部免 API key 的公开瓦片源
  satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
  darkLayer = L.tileLayer('https://cartodb-basemaps-a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abcd', attribution: 'CARTO' });
  esriTopo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
  esriRelief = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
  // 注：Google/OSM/OpenTopoMap 瓦片在部分网络环境不可达，故只保留实测可用的源
  satLayer.addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.layers({
    'Esri 卫星': satLayer, 'Esri 地形': esriTopo, 'Esri 晕渲': esriRelief, '暗色': darkLayer
  }, null, { position: 'bottomleft' }).addTo(map);
  trackLayer = L.layerGroup().addTo(map);
  setTimeout(() => map && map.invalidateSize(), 200);
  map.on('click', e => {
    if (!picking || !curId) return;
    const s = SESSIONS.find(x => x.id === curId);
    applyAlign(s, e.latlng.lat, e.latlng.lng);
    document.getElementById('alignLat').value = e.latlng.lat.toFixed(5);
    document.getElementById('alignLon').value = e.latlng.lng.toFixed(5);
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
  selLap = null;
  if (window.__closeNav) window.__closeNav();   // 手机端选完自动收起抽屉
  // 速度对比默认勾选最快圈 + 第二快圈
  const sorted = [...s.analysis.full].sort((x, y) => x.time_s - y.time_s);
  cmpLaps = new Set([sorted[0].index]);
  if (sorted[1]) cmpLaps.add(sorted[1].index);
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
  const selIdx = selLap != null ? selLap : (a.best ? a.best.index : (a.full[0] && a.full[0].index));
  const sel = a.full.find(l => l.index === selIdx) || a.best || a.full[0];
  let lapHtml = a.laps.map(l => {
    const w = Math.max(4, 100 * (1 - (l.time_s - (a.best_time || l.time_s)) / (maxT - (a.best_time || l.time_s) || 1)));
    return `<div class="lap${l.index === bestIdx ? ' best' : ''}"><span class="ln">#${l.index}</span>
      <span class="lbar"><span class="lfill" style="width:${w}%"></span></span>
      <span class="lt">${l.time_s.toFixed(2)}s</span></div>`;
  }).join('');

  let cornerHtml = a.corners.length ? `<div class="tscroll"><table class="ctab"><tr><th>弯</th><th>进度</th><th>入弯</th><th>弯心</th><th>出弯</th><th>横向G</th><th>损失</th></tr>
    ${a.corners.map(c => `<tr><td>${c.id}</td><td>${c.progress_pct}%</td><td>${c.entry_speed}</td><td class="b">${c.apex_speed}</td><td>${c.exit_speed}</td><td>${c.max_g}</td><td>${c.speed_loss}</td></tr>`).join('')}</table></div>`
    : '<div class="satnote">未能识别明显弯角。</div>';

  // 每圈汇总表
  let lapTab = a.full.length ? `<div class="tscroll"><table class="ctab ev"><tr><th>圈</th><th>时间</th><th>刹车点</th><th>峰值减速度</th><th>峰值加速</th><th>最低速</th><th>全油门</th><th>G-Sum</th></tr>
    ${a.full.map(l => `<tr class="${l.index === selIdx ? 'on' : ''}"><td>${l.index}</td><td>${l.time_s.toFixed(2)}</td><td>${l.metrics.brakeCount}</td><td>${l.metrics.peakBrakeG}G</td><td>${l.metrics.peakThrottleG}G</td><td>${l.metrics.minSpeed}</td><td>${l.metrics.flatout_pct}%</td><td>${l.metrics.gsumPeak}</td></tr>`).join('')}</table></div>`
    : '';

  // 选中圈刹车/油门事件表
  const brk = (sel && sel.brakeEvents) ? sel.brakeEvents : [];
  const thr = (sel && sel.throttleEvents) ? sel.throttleEvents : [];
  let evHtml = '';
  if (brk.length || thr.length) {
    evHtml = `<div class="evwrap">
      <div class="evcol"><h4>🛑 刹车点（#${sel ? sel.index : '-'}）</h4>
        <div class="tscroll"><table class="ctab ev"><tr><th>进度</th><th>峰值减速度</th><th>刹车距离</th><th>入弯速</th><th>刹车后最低速</th></tr>
        ${brk.map(e => `<tr><td>${e.progress}%</td><td class="neg">${e.peakG}G</td><td>${e.dist_m}m</td><td>${e.entrySpeed}</td><td>${e.minSpeed}</td></tr>`).join('') || '<tr><td colspan="5" class="satnote">无</td></tr>'}</table></div></div>
      <div class="evcol"><h4>🟢 油门点（#${sel ? sel.index : '-'}）</h4>
        <div class="tscroll"><table class="ctab ev"><tr><th>进度</th><th>峰值加速</th><th>加速距离</th><th>起始速</th><th>结束速</th></tr>
        ${thr.map(e => `<tr><td>${e.progress}%</td><td class="pos">${e.peakG}G</td><td>${e.dist_m}m</td><td>${e.startSpeed}</td><td>${e.endSpeed}</td></tr>`).join('') || '<tr><td colspan="5" class="satnote">无</td></tr>'}</table></div></div>
    </div>`;
  }

  // 建议
  const worst = a.worstZones[0];
  const worstSec = a.sectors.length ? a.sectors.reduce((m, x) => x.std_s > m.std_s ? x : m) : null;
  const ic = [...a.corners].sort((x, y) => y.speed_loss - x.speed_loss).slice(0, 2);
  const minGc = a.corners.length ? a.corners.reduce((m, x) => x.max_g < m.max_g ? x : m) : null;
  const maxG = a.corners.length ? Math.max(...a.corners.map(c => c.max_g)) : 0;
  const bc = a.brakeConsistency[0];
  const bcLap = sel ? sel.metrics : null;
  let adv = '';
  if (a.best) {
    adv = `<ul>
      <li><b>整体节奏：</b>${worstSec ? `第 ${worstSec.sector} 段最不稳定（圈速标准差 ${worstSec.std_s.toFixed(2)}s）。` : ''}核心 ${a.full.length} 圈标准差仅 ${a.core_std.toFixed(2)}s，最快 ${a.best_time.toFixed(2)}s、核心均速 ${a.core_avg.toFixed(2)}s，差距 ${(a.core_avg - a.best_time).toFixed(2)}s。</li>
      <li><b>最大波动区：</b>${worst ? `赛道进度 ${worst.progress_pct}% 附近速度每圈差 ${worst.std} km/h，走线/刹车点不固定，是最容易捡时间的地方。` : '数据较一致。'}</li>
      <li><b>丢速度最多的弯：</b>${ic.map(c => `C${c.id} 损失 ${c.speed_loss} km/h（入 ${c.entry_speed}→弯心 ${c.apex_speed}）`).join('；')}。出弯速度（${ic.map(c => c.exit_speed).join(' / ')}）还有空间，练"晚刹+弯心保速+早给油"。</li>
      <li><b>抓地利用：</b>最高横向G 达 ${maxG.toFixed(2)}；横向G 最低的 C${minGc ? minGc.id : '-'} 仅 ${minGc ? minGc.max_g.toFixed(2) : '-'}G，可稍晚刹车多带速。</li>
      <li><b>刹车点一致性：</b>${bc ? `进度 ${bc.progress}% 的刹车点每圈位置差 ±${bc.std.toFixed(1)}%，是最该固定下来的刹车点；固定后单圈会更稳。` : '已较一致。'}</li>
      <li><b>油门/全油门：</b>当前圈全油门占比 ${bcLap ? bcLap.flatout_pct : '-'}%、峰值加速 ${bcLap ? bcLap.peakThrottleG : '-'}G、G-Sum 峰值 ${bcLap ? bcLap.gsumPeak : '-'}（抓地利用上限参考）。出弯早给油、平滑加压能把 G-Sum 推满。</li>
    </ul>`;
  }

  const lapOpts = a.full.map(l => `<option value="${l.index}" ${l.index === selIdx ? 'selected' : ''}>#${l.index} · ${l.time_s.toFixed(2)}s</option>`).join('');

  document.getElementById('detail').innerHTML = `
    <div class="summary">
      <div class="dhead"><h2>${esc(s.name)}</h2><span class="dt">${esc(s.date)}</span></div>
      <div class="statgrid">
        <div class="stat"><div class="v">${a.best_time != null ? a.best_time.toFixed(2) + 's' : '-'}</div><div class="k">最快圈</div></div>
        <div class="stat"><div class="v">${a.core_avg.toFixed(2) + 's'}</div><div class="k">核心均速</div></div>
        <div class="stat"><div class="v" style="color:${a.gradeCol}">${a.grade}</div><div class="k">一致性</div></div>
        <div class="stat"><div class="v">${a.vmax.toFixed(0)}</div><div class="k">极速 km/h</div></div>
        <div class="stat"><div class="v">${maxG.toFixed(2)}</div><div class="k">最高G</div></div>
        <div class="stat"><div class="v">${sel && sel.metrics ? sel.metrics.flatout_pct + '%' : '-'}</div><div class="k">全油门占比</div></div>
        <div class="stat"><div class="v">${sel && sel.metrics ? sel.metrics.gsumPeak : '-'}</div><div class="k">G-Sum峰值</div></div>
        <div class="stat"><div class="v">${bcLap ? bcLap.peakBrakeG + 'G' : '-'}</div><div class="k">峰值减速度</div></div>
      </div>
    </div>
    <div class="secblock"><h3>圈速</h3><div class="laplist">${lapHtml}</div></div>
    <div class="secblock"><h3>最快圈 速度 / 横向G</h3><canvas id="chart" class="chart" width="660" height="280"></canvas>
      <div class="satnote">横轴=赛道进度0→100%；蓝=速度km/h，红=横向G；虚线=弯角位置</div></div>
    <div class="secblock"><h3>纵向G（刹车/油门曲线）</h3><canvas id="chartLong" class="chart" width="660" height="240"></canvas>
      <div class="satnote">红=刹车（纵向G为负），绿=油门（纵向G为正）；由速度差分推导，是卡丁车无刹车传感器时读刹车/油门点的标准做法</div></div>
    <div class="secblock"><h3>多圈速度叠加对比</h3>
      <div class="cmpchips" id="cmpChips">${a.full.map(l => `<button class="chip ${cmpLaps.has(l.index) ? 'on' : ''}" data-lap="${l.index}" style="--c:${cmpColor(l.index)}">#${l.index}</button>`).join('')}</div>
      <canvas id="chartCompare" class="chart" width="680" height="300"></canvas>
      <div class="satnote">同一张「赛道进度轴」上叠加所选圈的速度曲线，对比走线/刹车点差异。点击上方色块切换显示哪些圈（至少选 2 圈对比才有意义）。</div>
    </div>
    <div class="secblock"><h3>每圈汇总</h3>${lapTab}</div>
    <div class="secblock"><h3>刹车 / 油门事件 <select id="lapSel" class="lapsel">${lapOpts}</select></h3>${evHtml || '<div class="satnote">无刹车/油门事件。</div>'}</div>
    <div class="secblock"><h3>弯角明细（最快圈）</h3>${cornerHtml}</div>
    <div class="secblock"><div class="adv"><h3 style="color:var(--amber);border-left-color:var(--amber);margin-top:0">提升点</h3>${adv}</div></div>
    <div class="satnote">注：VBO 经纬度按官方格式（十进制分钟，经度正数为西经）解析，赛道已落在<b>真实场地位置</b>。若仍有几米误差属 GPS 正常漂移，可用地图「对齐」微调。</div>`;
  drawChart(document.getElementById('chart'), a.speedProfile, a.gProfile, a.corners);
  drawLongChart(document.getElementById('chartLong'), a.longGProfile, a.corners);
  drawCompare(s);
  const chips = document.getElementById('cmpChips');
  if (chips) chips.onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const idx = parseInt(b.dataset.lap, 10);
    if (cmpLaps.has(idx)) cmpLaps.delete(idx); else cmpLaps.add(idx);
    b.classList.toggle('on');
    drawCompare(SESSIONS.find(x => x.id === curId));
  };
  const selEl = document.getElementById('lapSel');
  if (selEl) selEl.onchange = () => { selLap = parseInt(selEl.value, 10); renderDetail(s); };
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
function drawLongChart(cv, dp, corners) {
  if (!cv || !dp.length) return;
  const W = cv.width, H = cv.height, padL = 38, padR = 38, padT = 14, padB = 22;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const gmax = Math.max(0.2, Math.max(...dp.map(p => Math.abs(p[1]))) * 1.1);
  const sx = p => padL + p / 100 * (W - padL - padR);
  const sy = g => H - padB - (g + gmax) / (2 * gmax) * (H - padT - padB);
  ctx.strokeStyle = '#7a6a3a'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  for (const c of corners) { ctx.beginPath(); ctx.moveTo(sx(c.progress_pct), padT); ctx.lineTo(sx(c.progress_pct), H - padB); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#5a6675'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, sy(0)); ctx.lineTo(W - padR, sy(0)); ctx.stroke();
  for (let i = 1; i < dp.length; i++) {
    const x0 = sx(dp[i - 1][0]), x1 = sx(dp[i][0]), y0 = sy(dp[i - 1][1]), y1 = sy(dp[i][1]);
    ctx.fillStyle = dp[i][1] < 0 ? 'rgba(225,6,0,.5)' : 'rgba(46,204,113,.5)';
    ctx.beginPath(); ctx.moveTo(x0, sy(0)); ctx.lineTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1, sy(0)); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = '#3b9eff'; ctx.lineWidth = 1.4; ctx.beginPath();
  dp.forEach((p, i) => { const x = sx(p[0]), y = sy(p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  ctx.fillStyle = '#e10600'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  ctx.fillText('-' + gmax.toFixed(1) + 'G', padL - 4, sy(-gmax) + 3);
  ctx.fillText('0', padL - 4, sy(0) + 3);
  ctx.fillStyle = '#2ecc71'; ctx.textAlign = 'left';
  ctx.fillText('+' + gmax.toFixed(1) + 'G', W - padR + 4, sy(gmax) + 3);
  ctx.fillStyle = '#8b98a5'; ctx.textAlign = 'center';
  ctx.fillText('赛道进度 →', W / 2, H - 6);
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* 单圈速度曲线：按赛道进度 0→100% 重采样（不同圈长也按位置对齐） */
function lapSpeedProfile(s, lap) {
  const cum = s.analysis.cum, a = lap.startIdx, b = lap.endIdx, D = lap.distance_m, out = [];
  for (let pct = 0; pct <= 100; pct++) {
    const target = cum[a] + pct / 100 * D;
    let ti = a; while (ti < b && cum[ti] < target) ti++;
    out.push([pct, Math.round(s.points[ti].vel * 10) / 10]);
  }
  return out;
}
/* 多圈速度叠加对比 */
function drawCompare(s) {
  const cv = document.getElementById('chartCompare'); if (!cv) return;
  const W = cv.width, H = cv.height, padL = 40, padR = 12, padT = 14, padB = 24;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const laps = s.analysis.full.filter(l => cmpLaps.has(l.index));
  if (!laps.length) {
    ctx.fillStyle = '#8b98a5'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('请选择至少一圈进行对比', W / 2, H / 2); return;
  }
  const profs = laps.map(l => ({ lap: l, prof: lapSpeedProfile(s, l), color: cmpColor(l.index) }));
  let vmax = 0; profs.forEach(p => p.prof.forEach(q => vmax = Math.max(vmax, q[1]))); vmax = vmax * 1.05 || 1;
  const sx = p => padL + p / 100 * (W - padL - padR);
  const sy = v => H - padB - v / vmax * (H - padT - padB);
  // 网格 + Y 轴
  ctx.strokeStyle = '#222b36'; ctx.lineWidth = 1; ctx.fillStyle = '#8b98a5'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) { const v = vmax * k / 4, y = sy(v); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.fillText(v.toFixed(0), padL - 4, y + 3); }
  // X 轴
  ctx.textAlign = 'center';
  for (let p = 0; p <= 100; p += 25) ctx.fillText(p + '%', sx(p), H - 8);
  ctx.fillStyle = '#8b98a5'; ctx.fillText('赛道进度 →', W / 2, H - 6 + 0);
  // 曲线
  profs.forEach(p => { ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.beginPath(); p.prof.forEach((q, i) => { const x = sx(q[0]), y = sy(q[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); });
  // 图例（左上角，标圈号+圈速）
  ctx.textAlign = 'left'; ctx.font = '11px sans-serif';
  let ly = padT + 6;
  profs.forEach(p => { ctx.fillStyle = p.color; ctx.fillRect(padL + 4, ly - 8, 11, 3); ctx.fillStyle = '#cdd6e0'; ctx.fillText('#' + p.lap.index + ' · ' + p.lap.time_s.toFixed(2) + 's', padL + 19, ly - 4); ly += 15; });
}

/* ---------- 对齐 ---------- */
function centroidRaw(s) {
  let la = 0, lo = 0;
  for (let i = 0; i < s.points.length; i++) { la += s.points[i].lat; lo += s.points[i].lon; }
  return { lat: la / s.points.length, lon: lo / s.points.length };
}
function applyAlign(s, lat, lon) {
  // 必须用「未偏移」的原始坐标中心来算 offset，否则第二次对齐会把已偏移的中心再当基准，导致越偏越回。
  const cen = centroidRaw(s);
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
    distTxt = '<div class="mdist">距当前赛道中心约 <b>' + d.toFixed(1) + ' km</b></div>';
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
  // 手机端抽屉：汉堡按钮 / 遮罩 / 选中会话后自动收起
  const layout = document.querySelector('.layout');
  const closeNav = () => layout && layout.classList.remove('nav-open');
  document.getElementById('menuBtn').onclick = () => layout && layout.classList.toggle('nav-open');
  document.getElementById('scrim').onclick = closeNav;
  // ESC 关闭抽屉
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });
  // 抽屉内向左滑动关闭
  const sidebar = document.querySelector('.sidebar');
  let tx0 = null, ty0 = null;
  sidebar.addEventListener('touchstart', e => { tx0 = e.touches[0].clientX; ty0 = e.touches[0].clientY; }, { passive: true });
  sidebar.addEventListener('touchend', e => {
    if (tx0 == null) return;
    const dx = e.changedTouches[0].clientX - tx0, dy = e.changedTouches[0].clientY - ty0;
    if (dx < -50 && Math.abs(dy) < 40) closeNav();   // 左滑且非竖向滚动
    tx0 = ty0 = null;
  }, { passive: true });
  // 视口变宽时（转横屏）自动收起，避免抽屉残留
  window.addEventListener('resize', () => { if (window.innerWidth > 680) closeNav(); });
  window.__closeNav = closeNav;
  // 右上角地图浮窗：放大/收起 + 对齐面板
  const mapMod = document.getElementById('mapModule');
  document.getElementById('mmExpand').onclick = () => {
    mapMod.classList.toggle('expanded');
    setTimeout(() => map && map.invalidateSize(), 60);
  };
  document.getElementById('mmAlign').onclick = () => {
    document.getElementById('alignBox').classList.toggle('show');
  };
}
window.addEventListener('DOMContentLoaded', () => { initMap(); setupIO(); });
