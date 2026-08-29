/* ============================================================
   core.js —— 各页面共享的公共库（解析 / 分析 / 存储 / 绘图工具）
   ⚠ 上半部分由 ibt_test/split_core.js 从 app.js 自动抽取，勿手工改动；
     新增公共代码请写到 _core_ext.js，重新运行脚本即可合并进来。
   ============================================================ */
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

function niceStep(span, targetTicks) {
  const rough = span / Math.max(1, targetTicks);
  const exp = Math.floor(Math.log10(rough));
  const frac = rough / Math.pow(10, exp);   // 1..10
  const mant = frac <= 1.5 ? 1 : frac <= 3 ? 2 : frac <= 7 ? 5 : 10;
  return mant * Math.pow(10, exp);
}
function axisTicks(min, max, targetTicks) {
  const s = niceStep(max - min, targetTicks);
  const start = Math.floor(min / s) * s, end = Math.ceil(max / s) * s;
  const out = [];
  for (let v = start; v <= end + 1e-9; v += s) out.push(v);
  return { step: s, ticks: out };
}

const RAD = Math.PI / 180;
const angDiff = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

/* ---------- iRacing 踏板曲线 ----------
   PEDAL_N：每圈采样点数。1% 步长（101 点）对 6km 赛道意味着 60m 一个点，
   而刹车区常常只有 30~60m，细节全被抹掉；0.1% 步长（1001 点）≈ 6m 一个点，
   才能看清入弯刹车斜率、trail braking 的松刹车过程、出弯给油时机。 */
const PEDAL_N = 1000;
/* 踏板曲线每行各列的含义 */
const PEDAL_COLS = { pct: 0, thr: 1, brk: 2, vel: 3, gear: 4, rpm: 5, steer: 6, latg: 7, long: 8, dist: 9, time: 10 };

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

/* ================= iRacing .ibt 遥测 =================
   真实 .ibt 布局（与 iRacing 共享内存 header 同构，**小端** int32）：
     header:  0=ver 4=status 8=tickRate 12=sessionInfoUpdate 16=sessionInfoLen
              20=sessionInfoOffset 24=numVars 28=varHeaderOffset 32=numBuf 36=bufLen
     varHeader（每项 144 字节）: +0 type  +4 offset  +8 count  +12 countAsTime/pad
              +16 name[32]  +48 desc[64]  +112 unit[32]
     类型: 0=char(1) 1=bool(1) 2=int(4) 3=bitField(4) 4=float(4) 5=double(8)
     数据区: 起始 = sessionInfoOffset + sessionInfoLen，每条 tick = bufLen 字节，**无 tickCount 前缀**
   sessionInfo 是 YAML（不是 JSON），含 TrackName / TrackDisplayName 等。 */
function ibtBytesToString(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) { const c = buf[start + i]; if (!c) break; s += String.fromCharCode(c); }
  return s;
}
const IBT_SIZE = [1, 1, 4, 4, 4, 8];            // 各类型字节数
function ibtReadVal(dv, buf, off, type) {
  // 越界一律返回 null，绝不让 DataView 抛异常（不同版本 header 可能有偏差）
  if (!(type >= 0 && type <= 5)) return null;
  if (off < 0 || off + IBT_SIZE[type] > buf.byteLength) return null;
  switch (type) {
    case 0: return buf[off];                    // char
    case 1: return buf[off] !== 0;              // bool
    case 2: return dv.getInt32(off, true);      // int
    case 3: return dv.getUint32(off, true);     // bitField
    case 4: return dv.getFloat32(off, true);    // float
    case 5: return dv.getFloat64(off, true);    // double
    default: return null;
  }
}
/* 需要的遥测通道（带备选名，兼容不同 iRacing 版本） */
const IBT_FIELDS = {
  t: ['SessionTime'],
  speed: ['Speed'],
  lat: ['Lat', 'WorldSpaceLatDeg', 'LapLat'],
  lon: ['Lon', 'WorldSpaceLonDeg', 'LapLon'],
  thr: ['Throttle'],
  brk: ['Brake'],
  gear: ['Gear'],
  rpm: ['RPM'],
  steer: ['SteeringWheelAngle'],
  latA: ['LatAccel'],
  lonA: ['LongAccel', 'LonAccel'],
  lap: ['Lap'],
  lapPct: ['LapDistPct']
};
function parseIBT(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tickRate = dv.getInt32(8, true);
  const siLen = dv.getInt32(16, true);
  const siOffset = dv.getInt32(20, true);
  const numVars = dv.getInt32(24, true);
  const varHdrOff = dv.getInt32(28, true);
  const bufLen = dv.getInt32(36, true);
  if (!(siLen > 0 && siOffset > 0 && numVars > 0 && bufLen > 0)) throw new Error('不是有效的 .ibt（header 异常）');
  const sessionInfo = ibtBytesToString(buf, siOffset, siLen);
  // 变量表
  const vars = {};
  for (let i = 0; i < numVars; i++) {
    const q = varHdrOff + i * 144;
    if (q + 144 > buf.byteLength) break;
    const name = ibtBytesToString(buf, q + 16, 32);
    if (name) vars[name] = { type: dv.getInt32(q, true), offset: dv.getInt32(q + 4, true), count: dv.getInt32(q + 8, true) };
  }
  const pick = names => { for (const n of names) if (vars[n]) return vars[n]; return null; };
  // 兜底：不区分大小写精确匹配（个别版本大小写不一致）
  const lower = {}; for (const n in vars) lower[n.toLowerCase()] = vars[n];
  const pickCI = names => { for (const n of names) if (lower[n.toLowerCase()]) return lower[n.toLowerCase()]; return null; };
  const F = {};
  for (const k in IBT_FIELDS) F[k] = pick(IBT_FIELDS[k]) || pickCI(IBT_FIELDS[k]);
  if (!F.lat || !F.lon) throw new Error('缺少经纬度通道（Lat/Lon）—— 该 .ibt 可能不是完整遥测录制');
  // 数据区
  const dataStart = siOffset + siLen;
  const n = Math.max(0, Math.floor((buf.byteLength - dataStart) / bufLen));
  if (!n) throw new Error('数据区为空');
  const dec = Math.max(1, Math.ceil(n / 60000));   // 超长会话降采样，避免浏览器卡顿
  const ticks = [];
  for (let i = 0; i < n; i += dec) {
    const base = dataStart + i * bufLen;
    const rec = {};
    for (const k in F) rec[k] = F[k] ? ibtReadVal(dv, buf, base + F[k].offset, F[k].type) : null;
    ticks.push(rec);
  }
  return { sessionInfo, tickRate, varCount: Object.keys(vars).length, ticks, varNames: Object.keys(vars) };
}
/* iRacing ticks → 与 .vbo 相同的 points（附带真实踏板/档位/转速通道） */
function ibtTicksToPoints(ticks) {
  const pts = [];
  let prevLat = null, prevLon = null, prevHdg = null;
  for (const tk of ticks) {
    const lat = +tk.lat, lon = +tk.lon;
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
    let hdg = null;
    if (prevLat != null) {
      // 精确坐标下用位置差分算航向（iRacing 的 Yaw 是相对赛道的，不能直接用）
      const dLon = (lon - prevLon) * Math.cos(lat * RAD);
      hdg = Math.atan2(dLon, lat - prevLat) / RAD;
      if (hdg < 0) hdg += 360;
    }
    pts.push({
      lat, lon,
      vel: (+tk.speed || 0) * 3.6,        // m/s → km/h
      hdg: hdg != null ? hdg : (prevHdg != null ? prevHdg : 0),
      h: null,
      t: +tk.t || 0,
      thr: +tk.thr || 0,                  // 0-1
      brk: +tk.brk || 0,                  // 0-1
      gear: +tk.gear || 0,
      rpm: +tk.rpm || 0,
      steer: +tk.steer || 0,              // rad
      latA: +tk.latA || 0,                // m/s²
      lonA: +tk.lonA || 0,                // m/s²
      lap: +tk.lap || 0,
      lapPct: +tk.lapPct || 0             // 0-1
    });
    prevLat = lat; prevLon = lon; prevHdg = hdg != null ? hdg : prevHdg;
  }
  return pts;
}
/* 从 sessionInfo(YAML) 提取赛道名 */
function ibtTrackName(sessionInfo) {
  if (!sessionInfo) return '';
  const m = sessionInfo.match(/TrackDisplayName:\s*(.+)/)
    || sessionInfo.match(/TrackName:\s*(.+)/);
  return m ? m[1].trim() : '';
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
  // iRacing：有真实 Throttle/Brake 通道，直接按踏板开度检测，不依赖 driveG 推导
  if (points[a] && points[a].thr !== undefined) {
    const thrB = 0.15, thrT = 0.15, minLen = 2.5, mergeGap = 10;
    const phases = (key, thr) => {
      const raw = []; let inc = false, st = 0;
      for (let t = a; t <= b; t++) {
        const on = points[t][key] > thr;
        if (on && !inc) { inc = true; st = t; }
        if (!on && inc) { raw.push([st, t - 1]); inc = false; }
      }
      if (inc) raw.push([st, b]);
      const filt = raw.filter(([s, e]) => (cum[e] - cum[s]) >= minLen);
      const merged = [];
      for (const seg of filt) {
        if (merged.length && (cum[seg[0]] - cum[merged[merged.length - 1][1]]) < mergeGap) merged[merged.length - 1] = [merged[merged.length - 1][0], seg[1]];
        else merged.push(seg);
      }
      return merged;
    };
    const pkOf = (key, s, e) => { let pk = s; for (let k = s; k <= e; k++) if (points[k][key] > points[pk][key]) pk = k; return pk; };
    const brakes = phases('brk', thrB).map(([s, e]) => {
      const pk = pkOf('brk', s, e);
      let lo = points[pk].vel, loi = pk;
      for (let k = pk; k <= e; k++) if (points[k].vel < lo) { lo = points[k].vel; loi = k; }
      return {
        progress: Math.round(100 * (cum[s] - cum[a]) / dist * 10) / 10,
        peakG: Math.round(points[pk].brk * 100),        // 0-100% 刹车开度
        dist_m: Math.round((cum[e] - cum[s]) * 10) / 10,
        entrySpeed: Math.round(points[s].vel * 10) / 10,
        minSpeed: Math.round(lo * 10) / 10
      };
    });
    const throttles = phases('thr', thrT).map(([s, e]) => {
      const pk = pkOf('thr', s, e);
      return {
        progress: Math.round(100 * (cum[s] - cum[a]) / dist * 10) / 10,
        peakG: Math.round(points[pk].thr * 100),        // 0-100% 油门开度
        dist_m: Math.round((cum[e] - cum[s]) * 10) / 10,
        startSpeed: Math.round(points[s].vel * 10) / 10,
        endSpeed: Math.round(points[e].vel * 10) / 10
      };
    });
    let peakBrake = 0, peakThrottle = 0, gsum = 0;
    for (let t = a; t <= b; t++) {
      peakBrake = Math.max(peakBrake, points[t].brk);
      peakThrottle = Math.max(peakThrottle, points[t].thr);
      gsum = Math.max(gsum, Math.hypot(driveG[t], latg[t]));
    }
    let fo = 0, tot = 0;
    for (let t = a + 1; t <= b; t++) {
      tot += cum[t] - cum[t - 1];
      if (points[t].thr > 0.85 && points[t].vel > 0.85 * vmax) fo += cum[t] - cum[t - 1];
    }
    const minSpeed = Math.min(...points.slice(a, b + 1).map(p => p.vel));
    return {
      brakes, throttles,
      metrics: {
        brakeCount: brakes.length, throttleCount: throttles.length,
        peakBrakeG: Math.round(peakBrake * 100),        // %
        peakThrottleG: Math.round(peakThrottle * 100),  // %
        gsumPeak: Math.round(gsum * 100) / 100,
        flatout_pct: tot ? Math.round(fo / tot * 100) : 0,
        minSpeed: Math.round(minSpeed * 10) / 10
      }
    };
  }
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
  const isIR = points[0] && points[0].latA !== undefined;
  const latg = new Array(n).fill(0), longa = new Array(n).fill(0), driveG = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (isIR) {
      // iRacing：直接用模拟器给出的真实加速度通道（m/s² → g）
      latg[i] = (points[i].latA || 0) / 9.81;
      driveG[i] = (points[i].lonA || 0) / 9.81;
      longa[i] = driveG[i];
      continue;
    }
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
  // 圈速识别：iRacing 直接用 Lap 通道分圈；.vbo 用「回到起点坐标」分圈
  const crossings = [0];
  if (isIR) {
    let lastLap = points[0].lap;
    for (let i = 1; i < n; i++) {
      if (points[i].lap !== lastLap) { crossings.push(i); lastLap = points[i].lap; }
    }
  } else {
    const sx = xy[0].x, sy = xy[0].y;
    const dstart = xy.map(p => Math.hypot(p.x - sx, p.y - sy));
    let lastProg = cum[0];
    let i = 1;
    while (i < n) {
      if (dstart[i] < 18) {
        let j = i, best = i, bd = dstart[i];
        while (j < n && dstart[j] < 18) { if (dstart[j] < bd) { bd = dstart[j]; best = j; } j++; }
        if (cum[best] - lastProg > 120) { crossings.push(best); lastProg = cum[best]; }
        i = j;
      } else i++;
    }
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
  const sp = [], gp = [], dp = [], pp = [];   // pp: iRacing 踏板曲线（高密度，见 PEDAL_COLS）
  if (best) {
    const a = best.startIdx, b = best.endIdx, D = best.distance_m;
    for (let pct = 0; pct <= 100; pct++) {
      const target = cum[a] + pct / 100 * D;
      let ti = a; while (ti < b && cum[ti] < target) ti++;
      sp.push([pct, Math.round(points[ti].vel * 10) / 10]);
      gp.push([pct, Math.round(Math.abs(latg[ti]) * 100) / 100]);
      dp.push([pct, Math.round(driveG[ti] * 100) / 100]);
    }
    // 踏板曲线用 0.1% 步长（约 1000 点）：1% 步长会把刹车区（常只有 30~60m）抹成 1~2 个点，看不出 trail braking 细节
    if (isIR) {
      const t0 = points[a].t, d0 = cum[a];
      let ti = a;                                   // 增量指针，避免 O(N*M)
      for (let k = 0; k <= PEDAL_N; k++) {
        const target = d0 + k / PEDAL_N * D;
        while (ti < b && cum[ti] < target) ti++;
        const p = points[ti];
        pp.push([
          Math.round(k / PEDAL_N * 1000) / 10,      // 0 进度 %
          Math.round(p.thr * 1000) / 10,            // 1 油门 %
          Math.round(p.brk * 1000) / 10,            // 2 刹车 %
          Math.round(p.vel * 10) / 10,              // 3 速度 km/h
          p.gear | 0,                               // 4 档位
          Math.round(p.rpm),                        // 5 转速
          Math.round(p.steer * 1000) / 1000,        // 6 转向 rad
          Math.round(Math.abs(latg[ti]) * 100) / 100, // 7 横向 G
          Math.round(driveG[ti] * 100) / 100,       // 8 纵向 G
          Math.round((cum[ti] - d0) * 10) / 10,     // 9 圈内距离 m
          Math.round((p.t - t0) * 1000) / 1000      // 10 圈内时间 s
        ]);
      }
    }
  }
  // F1 风格三段赛段（S1/S2/S3）：每圈三个赛段时间 + 跨圈汇总。
  // 用户反馈"用百分比看不清赛道上的提升点"，三段式更贴近赛事节奏。
  const sectors = [];
  if (full.length) {
    const st = [[], [], []];
    for (const l of full) {
      const a = l.startIdx, b = l.endIdx, base = cum[a], D = l.distance_m;
      const bd = [D / 3, 2 * D / 3, D];
      const idx = bd.map(t => { let ti = a; while (ti < b && (cum[ti] - base) < t) ti++; return ti; });
      const t0 = points[a].t;
      const sts = [points[idx[0]].t - t0, points[idx[1]].t - points[idx[0]].t, points[idx[2]].t - points[idx[1]].t];
      l.sector_times = sts;                       // 供每圈表格显示 S1/S2/S3
      st[0].push(sts[0]); st[1].push(sts[1]); st[2].push(sts[2]);
    }
    for (let k = 0; k < 3; k++) {
      const v = st[k], m = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
      sectors.push({ sector: k + 1, name: 'S' + (k + 1), mean_s: Math.round(m * 100) / 100, std_s: Math.round(sd * 100) / 100, best_s: Math.round(Math.min(...v) * 100) / 100 });
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
    corners, speedProfile: sp, gProfile: gp, longGProfile: dp, pedalProfile: pp, isIR,
    sectors, worstZones, brakeConsistency, xy, cum,
    latg, driveG            // 全量（覆盖所有点），供任意圈的 G 通道分析 / 多圈 Delta 使用
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
  // scrollWheelZoom:false —— 地图上滚轮直接滚页面（用户反馈"地图上滚轮动不了"）。
  // 地图缩放用左下角 +/- 按钮、拖拽或双指捏合。
  map = L.map('map', { zoomControl: false, attributionControl: true, scrollWheelZoom: false }).setView([30.55, 114.2], 15);
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
function centroidPlot(s) {
  let la = 0, lo = 0;
  for (let i = 0; i < s.points.length; i++) { const p = plotPt(s, i); la += p[0]; lo += p[1]; }
  return { lat: la / s.points.length, lon: lo / s.points.length };
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* 按 CSS 实际宽度 + devicePixelRatio 设置画布分辨率，避免被拉伸模糊 */
function fitCanvas(cv, cssH) {
  const dpr = window.devicePixelRatio || 1;
  cv.style.height = cssH + 'px';
  // 先写 style.height 再量：全局 box-sizing:border-box 时 clientHeight 会比 cssH 少掉边框，
  // 直接用 cssH 做后备缓冲会让底部几像素被裁掉
  const cssW = cv.clientWidth || cv.parentElement.clientWidth || 660;
  const cssHReal = cv.clientHeight || cssH;
  const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssHReal * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之后一律用 CSS 像素坐标绘制
  return { W: cssW, H: cssHReal, ctx };
}

/* ================= iRacing 油门/刹车详细曲线 =================
   可缩放（滚轮 / 拖拽 / 双击复位）、悬停十字读数、横向可换单位（进度/距离/时间）、
   可叠加速度 / 转速 / 横向G / 转向角，底部档位色带。
   数据来自 pedalProfile（1001 点，列定义见 PEDAL_COLS）。 */
/* 绑定踏板图的交互：滚轮/双指缩放、拖拽平移、悬停读数、双击复位 */
/* 踏板图控制条：横轴单位 / 叠加通道 / 缩放 / 高度 */
/* roundRect 兜底（老浏览器没有该方法） */
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath();
    return this;
  };
}

/* 单圈速度曲线：按赛道进度 0→100% 重采样（不同圈长也按位置对齐） */
/* 多圈速度叠加对比 */
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
/* 加载失败提示（非阻塞，显示在详情区） */
function showLoadError(msg) {
  // 多页面下优先写 #loaderr（各页面都有的提示位），兼容老的单页 #detail
  const d = document.getElementById('loaderr') || document.getElementById('detail');
  if (d) {
    d.innerHTML = `<div class="notice" style="border-left-color:var(--accent)">⚠ ${msg}</div>`;
    d.style.display = 'block';
  }
  console.error('[kart]', msg);
}
function loadIBT(file, onDone) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const r = parseIBT(new Uint8Array(e.target.result));
      if (!r.ticks.length) { showLoadError('无法解析 .ibt（无数据）：' + file.name); return; }
      const pts = ibtTicksToPoints(r.ticks);
      if (pts.length < 50) { showLoadError('.ibt 有效数据点太少：' + file.name); return; }
      // 从 session info(YAML) 提取赛道名
      let name = ibtTrackName(r.sessionInfo);
      if (!name) name = file.name.replace(/\.ibt$/i, '');
      const d = file.lastModified ? new Date(file.lastModified) : new Date();
      const date = 'iRacing ' + d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const s = { id: Date.now() + '_' + SESSIONS.length, name, date, points: pts, source: 'iracing',
        offset: { dLat: 0, dLon: 0 }, analysis: analyze(pts) };
      SESSIONS.push(s);
      renderSidebar();
      if (SESSIONS.length === 1) selectSession(s.id);
      dbSave(s);   // 持久化
      onDone && onDone(s);
    } catch (err) { console.error(err); showLoadError('解析 .ibt 失败：' + file.name + '<br>' + (err && err.message)); }
  };
  reader.readAsArrayBuffer(file);
}
function loadFile(file, onDone) {
  if (/\.ibt$/i.test(file.name)) { loadIBT(file, onDone); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const parsed = parseVBO(e.target.result);
    if (!parsed || !parsed.points.length) { showLoadError('无法解析：' + file.name); return; }
    const name = (parsed.comments.track && parsed.comments.track !== 'carrot2') ? parsed.comments.track
      : (parsed.comments.track || file.name.replace(/\.vbo$/i, ''));
    const date = parsed.comments.beijing || ('UTC ' + parsed.points[0].t.toFixed(0));
    const id = Date.now() + '_' + SESSIONS.length;
    const s = { id, name, date, points: parsed.points, source: 'vbo', offset: { dLat: 0, dLon: 0 }, analysis: analyze(parsed.points) };
    SESSIONS.push(s);
    renderSidebar();
    if (SESSIONS.length === 1) selectSession(id);
    dbSave(s);   // 持久化
    onDone && onDone(s);
  };
  reader.readAsText(file);
}
/* ================= IndexedDB 持久化（数据只存本地浏览器，不上传） =================
   存原始 points（+offset），打开页面时重新 analyze，保证算法升级后旧数据也能用新分析。 */
let idb = null;
function openDB() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
    const rq = indexedDB.open('kart-telemetry', 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('sessions')) rq.result.createObjectStore('sessions', { keyPath: 'id' }); };
    rq.onsuccess = () => { idb = rq.result; res(idb); };
    rq.onerror = () => rej(rq.error);
  });
}
function dbSave(s) {
  if (!idb) return Promise.resolve();
  try {
    return new Promise(res => {
      const tx = idb.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({
        id: s.id, name: s.name, date: s.date, source: s.source || 'vbo',
        points: s.points, offset: s.offset || { dLat: 0, dLon: 0 }, savedAt: Date.now()
      });
      tx.oncomplete = res; tx.onerror = () => res();
    });
  } catch (e) { return Promise.resolve(); }
}
function dbLoadAll() {
  if (!idb) return Promise.resolve([]);
  return new Promise(res => {
    try {
      const rq = idb.transaction('sessions', 'readonly').objectStore('sessions').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    } catch (e) { res([]); }
  });
}
function dbDelete(id) {
  if (!idb) return;
  try { idb.transaction('sessions', 'readwrite').objectStore('sessions').delete(id); } catch (e) { }
}
function rebuildSession(rec) {
  const s = { id: rec.id, name: rec.name, date: rec.date, source: rec.source || 'vbo',
    points: rec.points, offset: rec.offset || { dLat: 0, dLon: 0 }, analysis: analyze(rec.points) };
  return s;
}
/* 从数据库恢复会话 */
async function restoreSessions() {
  try {
    await openDB();
    const recs = await dbLoadAll();
    for (const rec of recs) SESSIONS.push(rebuildSession(rec));
    if (SESSIONS.length) {
      renderSidebar();
      selectSession(SESSIONS[SESSIONS.length - 1].id);   // 恢复上次最后一次查看的会话
    }
  } catch (e) { /* 无 IndexedDB 环境则静默降级 */ }
}


/* ======== 以下来自 _core_ext.js（手工维护） ======== */
/* ================================================================
   _core_ext.js —— 手工维护的公共扩展（由 split_core.js 合并进 core.js）
   内容：遥测通道定义 / 单圈曲线采样 / 多圈 Delta / 极限圈速 /
        跨页会话管理 / 导航 / 通用曲线绘图引擎
   ================================================================ */

/* ---------- 遥测通道 ----------
   X 轴统一用「圈内进度 %」重采样（Garage61 用的是距离，本质一样）：
   不同圈走线不同、总里程不同，按进度%才能让所有圈在同一根轴上对齐。
   VBO 没有踏板传感器，油门/刹车用纵向 G 推导（已在 UI 上标注量纲）。 */
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
      v: channelValue(s, ti, ch)
    });
  }
  // 收尾对齐：末点强制为圈末，避免采样误差让总时长对不上
  if (out.length) { out[out.length - 1].d = cum[B] - d0; out[out.length - 1].t = s.points[B].t - t0; }
  return out;
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
    top: [...segs].sort((a, b) => b.gain - a.gain).slice(0, 6)
  };
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
    最快 <b>${s.analysis.best_time != null ? s.analysis.best_time.toFixed(2) + 's' : '-'}</b>
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
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) { const x = sx(i), y = sy(s.data[i]); i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
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
      title="${warn ? '比中位圈慢 6% 以上，可能是出场圈/失误圈' : ''}">#${l.index}<span class="lt">${l.time_s.toFixed(2)}s</span></button>`;
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
