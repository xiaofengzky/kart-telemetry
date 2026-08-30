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
  lapPct: ['LapDistPct'],
  // ── 轮胎 / 刹车（仅 iRacing 有）──
  // 胎面温度分左/中/右三层（车辆坐标系）：LF/LR 外侧=L，RF/RR 外侧=R
  tt: ['LFtempL', 'LFtempM', 'LFtempR', 'RFtempL', 'RFtempM', 'RFtempR',
    'LRtempL', 'LRtempM', 'LRtempR', 'RRtempL', 'RRtempM', 'RRtempR'],
  tc: ['LFtempCL', 'LFtempCM', 'LFtempCR', 'RFtempCL', 'RFtempCM', 'RFtempCR',
    'LRtempCL', 'LRtempCM', 'LRtempCR', 'RRtempCL', 'RRtempCM', 'RRtempCR'],
  absCut: ['BrakeABScutPct'],      // ABS 削减比例 0-100
  absAct: ['BrakeABSactive'],      // ABS 是否激活 0/1
  ws: ['LFspeed', 'RFspeed', 'LRspeed', 'RRspeed'],   // 每轮转速（算滑移）
  wp: ['LFpressure', 'RFpressure', 'LRpressure', 'RRpressure'],  // 热胎压 kPa
  wear: ['LFwearL', 'LFwearM', 'LFwearR', 'RFwearL', 'RFwearM', 'RFwearR',
    'LRwearL', 'LRwearM', 'LRwearR', 'RRwearL', 'RRwearM', 'RRwearR']
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
  // 多通道字段（轮胎温度/胎压/磨损/轮速）：每个名字都要拿到，缺一个就整组放弃
  const pickAll = names => {
    const out = [];
    for (const n of names) { const v = vars[n] || lower[n.toLowerCase()]; if (!v) return []; out.push(v); }
    return out;
  };
  const F = {};
  for (const k in IBT_FIELDS) {
    const names = IBT_FIELDS[k];
    F[k] = (k === 'tt' || k === 'tc' || k === 'ws' || k === 'wp' || k === 'wear')
      ? pickAll(names) : (pick(names) || pickCI(names));
  }
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
    for (const k in F) {
      const v = F[k];
      rec[k] = Array.isArray(v) ? (v.length ? v.map(x => ibtReadVal(dv, buf, base + x.offset, x.type)) : null)
        : (v ? ibtReadVal(dv, buf, base + v.offset, v.type) : null);
    }
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
      lapPct: +tk.lapPct || 0,            // 0-1
      // 轮胎/刹车（仅 iRacing，VBO 这些字段为 null）
      tt: tk.tt ? tk.tt.map(v => Math.round(v * 10) / 10) : null,   // 4 轮 × (L,M,R) 胎面温度 °C
      ws: tk.ws ? tk.ws.map(v => Math.round(v * 10) / 10) : null,   // 4 轮转速 m/s
      abs: tk.absCut != null ? Math.round(tk.absCut * 10) / 10 : (tk.absAct != null ? +tk.absAct : null) // ABS 削减% / 激活
    });
    prevLat = lat; prevLon = lon; prevHdg = hdg != null ? hdg : prevHdg;
  }
  return pts;
}
/* 按圈聚合轮胎数据（温度均值 / 胎体均值 / 胎压均值 / 磨损首尾）—— 不进 per-point，避免数据膨胀 */
function ibtTireByLap(ticks) {
  const acc = new Map();
  for (const tk of ticks) {
    if (!tk.tt && !tk.wear && !tk.tc) continue;
    const L = +tk.lap || 0;
    let a = acc.get(L);
    if (!a) {
      a = { lap: L, n: 0, tt: new Array(12).fill(0), tc: new Array(12).fill(0), wp: new Array(4).fill(0),
        wStart: tk.wear ? tk.wear.slice() : null, wEnd: null };
      acc.set(L, a);
    }
    a.n++;
    if (tk.tt) for (let i = 0; i < 12; i++) a.tt[i] += tk.tt[i];
    if (tk.tc) for (let i = 0; i < 12; i++) a.tc[i] += tk.tc[i];
    if (tk.wp) for (let i = 0; i < 4; i++) a.wp[i] += tk.wp[i];
    if (tk.wear) a.wEnd = tk.wear.slice();
  }
  const out = [];
  for (const a of acc.values()) {
    if (!a.n) continue;
    out.push({
      lap: a.lap,
      tt: a.tt.map(v => Math.round(v / a.n * 10) / 10),
      tc: a.tc.map(v => Math.round(v / a.n * 10) / 10),
      wp: a.wp.map(v => Math.round(v / a.n * 10) / 10),
      wearStart: a.wStart, wearEnd: a.wEnd
    });
  }
  return out.length ? out : null;
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
function analyze(points, excluded) {
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
  /* ---------- 异常圈自动检测（用户反馈：#1 蹭线 35m 被当成最快圈，统计全被污染） ----------
     分两类：
     ① junk（假圈/不完整圈）：里程不足中位圈的一半——起终点线附近停车/蹭线/断数据，
        根本不是一圈，直接从 full 移除（记入 a.junkCount，不进统计也不显示）。
     ② abnormal（异常圈）：里程正常但耗时远高于中位——暖胎圈/从 pit 出发/失误圈，
        保留显示（灰色 ⚠），但默认不参与任何统计。
     检测只在 ≥3 圈时启用（圈太少时中位数不可靠，全部保留）。 */
  const exclSet = new Set(excluded || []);
  let junkCount = 0, autoExcluded = 0;
  if (full.length >= 3) {
    const dSorted = [...full].map(l => l.distance_m).sort((x, y) => x - y);
    const medianDist = dSorted[dSorted.length >> 1];
    const tSorted = [...full].map(l => l.time_s).sort((x, y) => x - y);
    const medianT = tSorted[tSorted.length >> 1];
    const q1 = tSorted[Math.floor(tSorted.length * .25)], q3 = tSorted[Math.floor(tSorted.length * .75)];
    // ⚠ IQR 要钳制上限：圈很少时（3~4 圈）慢圈自己会把 q3-q1 撑大，检测阈值跟着抬升导致漏检。
    const iqr = Math.min(Math.max(0.001, q3 - q1), medianT * .1);
    for (const l of full) {
      if (l.distance_m < medianDist * .45) { l.junk = true; junkCount++; }
    }
    for (const l of full) {
      if (l.junk) continue;
      const slowPct = (l.time_s - medianT) / medianT * 100;
      // 慢于 中位 + max(1.5×IQR, 8%) → 异常圈
      if (l.time_s > medianT + Math.max(1.5 * iqr, medianT * .08)) {
        l.abnormal = true; l.abnormalPct = slowPct;
        if (!exclSet.has(l.index)) autoExcluded++;
      }
    }
  }
  const displayLaps = full.filter(l => !l.junk);          // full 只留真实圈（含异常圈）
  const validLaps = displayLaps.filter(l => !l.abnormal && !exclSet.has(l.index));  // 统计用
  const maxV = Math.max(...points.map(p => p.vel));
  for (const l of displayLaps) {
    const ev = lapEvents(points, cum, driveG, latg, l.startIdx, l.endIdx, l.distance_m, maxV);
    l.brakeEvents = ev.brakes; l.throttleEvents = ev.throttles; l.metrics = ev.metrics;
  }
  const best = validLaps.length ? validLaps.reduce((m, l) => l.time_s < m.time_s ? l : m) : null;
  const times = validLaps.map(l => l.time_s);
  const avg = times.reduce((s, v) => s + v, 0) / (times.length || 1);
  const std = times.length ? Math.sqrt(times.reduce((s, v) => s + (v - avg) ** 2, 0) / times.length) : 0;
  const core = times.filter(t => Math.abs(t - avg) <= 1.6 * std);
  const coreLaps = validLaps.filter(l => Math.abs(l.time_s - avg) <= 1.6 * std);
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
  if (displayLaps.length) {
    const st = [[], [], []];
    for (const l of displayLaps) {
      const a = l.startIdx, b = l.endIdx, base = cum[a], D = l.distance_m;
      const bd = [D / 3, 2 * D / 3, D];
      const idx = bd.map(t => { let ti = a; while (ti < b && (cum[ti] - base) < t) ti++; return ti; });
      const t0 = points[a].t;
      const sts = [points[idx[0]].t - t0, points[idx[1]].t - points[idx[0]].t, points[idx[2]].t - points[idx[1]].t];
      l.sector_times = sts;                       // 供每圈表格显示 S1/S2/S3
      if (!l.abnormal && !exclSet.has(l.index)) { st[0].push(sts[0]); st[1].push(sts[1]); st[2].push(sts[2]); }
    }
    for (let k = 0; k < 3; k++) {
      const v = st[k];
      if (!v.length) continue;
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
      sectors.push({ sector: k + 1, name: 'S' + (k + 1), mean_s: Math.round(m * 100) / 100, std_s: Math.round(sd * 100) / 100, best_s: Math.round(Math.min(...v) * 100) / 100 });
    }
  }
  const worst = [];
  // 波动区：跨圈同进度速度标准差（只用有效圈，异常圈会拉高噪声）
  const bands = 100, bs = Array.from({ length: bands + 1 }, () => []);
  for (const l of validLaps) {
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
    laps, full: displayLaps, best, vmin: Math.min(...vels), vmax: Math.max(...vels),
    best_time: best ? Math.round(best.time_s * 100) / 100 : null,
    avg_lap: Math.round(avg * 100) / 100, core_avg: Math.round(coreAvg * 100) / 100,
    core_std: Math.round(coreStd * 100) / 100, grade, gradeCol,
    corners, speedProfile: sp, gProfile: gp, longGProfile: dp, pedalProfile: pp, isIR,
    sectors, worstZones, brakeConsistency, xy, cum,
    latg, driveG,           // 全量（覆盖所有点），供任意圈的 G 通道分析 / 多圈 Delta 使用
    // 异常圈信息：junkCount=自动丢弃的假圈(里程过短)，abnormal=自动标记的异常圈(慢于中位)，
    // excluded=用户手动排除的圈 index，validCount=参与统计的有效圈数
    junkCount: junkCount || 0,
    abnormal: displayLaps.filter(l => l.abnormal).map(l => l.index),
    excluded: (excluded || []).slice(),
    validCount: validLaps.length
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
  // scrollWheelZoom:false —— 默认把滚轮留给页面滚动（用户反馈"地图上滚轮动不了页面"）。
  // 但纯 Ctrl+滚轮太隐蔽，用户又反馈"地图不能滚轮放大"，所以做成【点击激活】：
  // 点一下地图 → 滚轮归地图（可放大缩小）；鼠标移出地图 / 点页面别处 → 滚轮归页面。
  map = L.map('map', { zoomControl: false, attributionControl: true, scrollWheelZoom: false }).setView([30.55, 114.2], 15);
  let mapWheelOn = false;
  const mapEl = map.getContainer();
  // ⚠ Leaflet 的 Map 事件里【没有 'wheel'】——map.on('wheel') 永远不会触发，
  //   必须直接监听容器 DOM 的 wheel（且要 passive:false 才能 preventDefault）。
  mapEl.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey || mapWheelOn)) return;   // 未激活时普通滚轮留给页面滚动
    e.preventDefault();
    const z = map.getZoom() + (e.deltaY > 0 ? -1 : 1);
    if (z >= map.getMinZoom() && z <= map.getMaxZoom()) map.setZoom(z);   // 不用 animate：滚轮缩放要跟手
  }, { passive: false });
  // 激活态提示条（CSS 里 pointer-events:none，不挡地图交互）
  const mapHint = document.createElement('div');
  mapHint.className = 'maphint';
  mapHint.textContent = '🖱️ 点击地图启用滚轮缩放 · 移出自动释放';
  mapEl.appendChild(mapHint);
  const setMapWheel = on => {
    mapWheelOn = on;
    mapEl.classList.toggle('wheelon', on);
    mapHint.style.display = on ? 'none' : '';
  };
  setMapWheel(false);
  map.on('mousedown', () => setMapWheel(true));
  mapEl.addEventListener('mouseleave', () => setMapWheel(false));
  document.addEventListener('mousedown', e => { if (!mapEl.contains(e.target)) setMapWheel(false); });
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
    el.innerHTML = `<div class="sname">${esc(s.name)}<span class="strack">${a.full.length} 圈 · ${s.source === 'iracing' ? '<i class="src iracing">iRacing</i>' : '<i class="src vbo">VBOX</i>'}</span></div>
      <div class="sdate">${esc(s.date)}</div>
      <div class="sstat"><span>最快 <b>${a.best_time != null ? fmtTime(a.best_time, 2) : '-'}</b></span>
      <span>极速 <b>${a.vmax.toFixed(0)}</b></span><span>最高G <b>${Math.max(0, ...a.corners.map(c => c.max_g)).toFixed(2)}</b></span></div>`;
    el.onclick = () => selectSession(s.id);
    list.appendChild(el);
  }
}
function selectSession(id) {
  curId = id; const s = SESSIONS.find(x => x.id === id);
  selLap = null;
  // 换会话时复位踏板图视窗（换圈不复位，方便前后对比同一段）
  if (PEDAL.sess !== id) { PEDAL.sess = id; PEDAL.x0 = 0; PEDAL.x1 = 1; PEDAL.hover = null; }
  if (window.__closeNav) window.__closeNav();   // 手机端选完自动收起抽屉
  // 速度对比默认勾选最快圈 + 第二快圈（无完整圈时兜底为空）
  const sorted = [...s.analysis.full].sort((x, y) => x.time_s - y.time_s);
  cmpLaps = new Set(sorted.length ? [sorted[0].index] : []);
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
  const isIR = !!(a.isIR);
  // 单位适配：iRacing 用真实踏板开度(%)，VBO 用推导 G 值
  const fmtPeak = (v, isBrake) => {
    if (v == null) return '-';
    return isIR ? v + '%' : (isBrake ? v + 'G' : v + 'G');
  };
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
    ${a.full.map(l => `<tr class="${l.index === selIdx ? 'on' : ''}"><td>${l.index}</td><td>${l.time_s.toFixed(2)}</td><td>${l.metrics.brakeCount}</td><td>${fmtPeak(l.metrics.peakBrakeG, true)}</td><td>${fmtPeak(l.metrics.peakThrottleG, false)}</td><td>${l.metrics.minSpeed}</td><td>${l.metrics.flatout_pct}%</td><td>${l.metrics.gsumPeak}</td></tr>`).join('')}</table></div>`
    : '';

  // 选中圈刹车/油门事件表
  const brk = (sel && sel.brakeEvents) ? sel.brakeEvents : [];
  const thr = (sel && sel.throttleEvents) ? sel.throttleEvents : [];
  const brkHdr = isIR ? '最大刹车开度' : '峰值减速度';
  const thrHdr = isIR ? '最大油门开度' : '峰值加速';
  let evHtml = '';
  if (brk.length || thr.length) {
    evHtml = `<div class="evwrap">
      <div class="evcol"><h4>🛑 刹车点（#${sel ? sel.index : '-'}）</h4>
        <div class="tscroll"><table class="ctab ev"><tr><th>进度</th><th>${brkHdr}</th><th>刹车距离</th><th>入弯速</th><th>刹车后最低速</th></tr>
        ${brk.map(e => `<tr><td>${e.progress}%</td><td class="neg">${isIR ? e.peakG + '%' : e.peakG + 'G'}</td><td>${e.dist_m}m</td><td>${e.entrySpeed}</td><td>${e.minSpeed}</td></tr>`).join('') || '<tr><td colspan="5" class="satnote">无</td></tr>'}</table></div></div>
      <div class="evcol"><h4>🟢 油门点（#${sel ? sel.index : '-'}）</h4>
        <div class="tscroll"><table class="ctab ev"><tr><th>进度</th><th>${thrHdr}</th><th>加速距离</th><th>起始速</th><th>结束速</th></tr>
        ${thr.map(e => `<tr><td>${e.progress}%</td><td class="pos">${isIR ? e.peakG + '%' : e.peakG + 'G'}</td><td>${e.dist_m}m</td><td>${e.startSpeed}</td><td>${e.endSpeed}</td></tr>`).join('') || '<tr><td colspan="5" class="satnote">无</td></tr>'}</table></div></div>
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
      <li><b>整体节奏：</b>${worstSec ? `第 ${worstSec.sector} 段最不稳定（圈速标准差 ${worstSec.std_s.toFixed(2)}s）。` : ''}核心 ${a.full.length} 圈标准差仅 ${a.core_std.toFixed(2)}s，最快 ${fmtTime(a.best_time, 2)}、核心均速 ${fmtTime(a.core_avg, 2)}，差距 ${(a.core_avg - a.best_time).toFixed(2)}s。</li>
      <li><b>最大波动区：</b>${worst ? `赛道进度 ${worst.progress_pct}% 附近速度每圈差 ${worst.std} km/h，走线/刹车点不固定，是最容易捡时间的地方。` : '数据较一致。'}</li>
      <li><b>丢速度最多的弯：</b>${ic.map(c => `C${c.id} 损失 ${c.speed_loss} km/h（入 ${c.entry_speed}→弯心 ${c.apex_speed}）`).join('；')}。出弯速度（${ic.map(c => c.exit_speed).join(' / ')}）还有空间，练"晚刹+弯心保速+早给油"。</li>
      <li><b>抓地利用：</b>最高横向G 达 ${maxG.toFixed(2)}；横向G 最低的 C${minGc ? minGc.id : '-'} 仅 ${minGc ? minGc.max_g.toFixed(2) : '-'}G，可稍晚刹车多带速。</li>
      <li><b>刹车点一致性：</b>${bc ? `进度 ${bc.progress}% 的刹车点每圈位置差 ±${bc.std.toFixed(1)}%，是最该固定下来的刹车点；固定后单圈会更稳。` : '已较一致。'}</li>
      <li><b>油门/全油门：</b>当前圈全油门占比 ${bcLap ? bcLap.flatout_pct : '-'}%、峰值${isIR ? '油门开度' : '加速'} ${bcLap ? fmtPeak(bcLap.peakThrottleG, false) : '-'}、G-Sum 峰值 ${bcLap ? bcLap.gsumPeak : '-'}（抓地利用上限参考）。出弯早给油、平滑加压能把 G-Sum 推满。</li>
    </ul>`;
  }

  const lapOpts = a.full.map(l => `<option value="${l.index}" ${l.index === selIdx ? 'selected' : ''}>#${l.index} · ${fmtTime(l.time_s, 2)}</option>`).join('');

  document.getElementById('detail').innerHTML = `
    <div class="summary">
      <div class="dhead"><h2>${esc(s.name)} <i class="src ${isIR ? 'iracing' : 'vbo'}">${isIR ? 'iRacing' : 'VBOX'}</i></h2><span class="dt">${esc(s.date)}</span></div>
      <div class="statgrid">
        <div class="stat"><div class="v">${a.best_time != null ? fmtTime(a.best_time, 2) : '-'}</div><div class="k">最快圈</div></div>
        <div class="stat"><div class="v">${fmtTime(a.core_avg, 2)}</div><div class="k">核心均速</div></div>
        <div class="stat"><div class="v" style="color:${a.gradeCol}">${a.grade}</div><div class="k">一致性</div></div>
        <div class="stat"><div class="v">${a.vmax.toFixed(0)}</div><div class="k">极速 km/h</div></div>
        <div class="stat"><div class="v">${maxG.toFixed(2)}</div><div class="k">最高G</div></div>
        <div class="stat"><div class="v">${sel && sel.metrics ? sel.metrics.flatout_pct + '%' : '-'}</div><div class="k">全油门占比</div></div>
        <div class="stat"><div class="v">${sel && sel.metrics ? sel.metrics.gsumPeak : '-'}</div><div class="k">G-Sum峰值</div></div>
        <div class="stat"><div class="v">${bcLap ? fmtPeak(bcLap.peakBrakeG, true) : '-'}</div><div class="k">峰值减速度</div></div>
      </div>
    </div>
    <div class="secblock"><h3>圈速</h3><div class="laplist">${lapHtml}</div></div>
    <div class="secblock"><h3>最快圈 速度 / 横向G</h3><canvas id="chart" class="chart" width="660" height="280"></canvas>
      <div class="satnote">横轴=赛道进度0→100%；蓝=速度km/h，红=横向G；虚线=弯角位置</div></div>
    ${isIR
      ? `<div class="secblock"><h3>油门 / 刹车开度（iRacing 真实传感器）</h3>
         <div class="pedctrl" id="pedCtrl">
           <div class="pcgroup"><span class="pclabel">横轴</span>
             <button class="pbtn ${PEDAL.unit === 'pct' ? 'on' : ''}" data-unit="pct">进度 %</button>
             <button class="pbtn ${PEDAL.unit === 'dist' ? 'on' : ''}" data-unit="dist">距离 m</button>
             <button class="pbtn ${PEDAL.unit === 'time' ? 'on' : ''}" data-unit="time">时间 s</button>
           </div>
           <div class="pcgroup"><span class="pclabel">叠加</span>
             <button class="pbtn ov ${PEDAL.ov.speed ? 'on' : ''}" data-ov="speed" style="--c:#3b9eff">速度</button>
             <button class="pbtn ov ${PEDAL.ov.rpm ? 'on' : ''}" data-ov="rpm" style="--c:#f5a623">转速</button>
             <button class="pbtn ov ${PEDAL.ov.latg ? 'on' : ''}" data-ov="latg" style="--c:#a259ff">横向G</button>
             <button class="pbtn ov ${PEDAL.ov.steer ? 'on' : ''}" data-ov="steer" style="--c:#16d6c9">转向</button>
             <button class="pbtn ov ${PEDAL.ov.gear ? 'on' : ''}" data-ov="gear" style="--c:#8b98a5">档位</button>
           </div>
           <div class="pcgroup"><span class="pclabel">视图</span>
             <button class="pbtn" data-zoom="in">放大</button>
             <button class="pbtn" data-zoom="out">缩小</button>
             <button class="pbtn" data-zoom="reset">复位</button>
             <button class="pbtn" data-h="-60">矮</button>
             <button class="pbtn" data-h="60">高</button>
           </div>
         </div>
         <canvas id="chartPedal" class="chart" width="660" height="${PEDAL.height}"></canvas>
         <div class="satnote">绿=油门开度、红=刹车开度（0-100%，iRacing 真实传感器）；橙色虚线=弯角起点，底部色带=档位。
           每圈采样 <b>1001 点</b>（约 6m 一个），<b>滚轮/双指缩放、拖拽平移、鼠标悬停读数值、双击复位</b>——放大后能看清入弯刹车斜率、trail braking 松刹车的过渡、出弯给油时机。
           横轴换「距离 m」可直接读出刹车点离弯心多少米，配合换「时间 s」能算某段耗时。</div></div>`
      : `<div class="secblock"><h3>纵向G（刹车/油门曲线）</h3><canvas id="chartLong" class="chart" width="660" height="240"></canvas>
         <div class="satnote">红=刹车（纵向G为负），绿=油门（纵向G为正）；由速度差分推导，是卡丁车无刹车传感器时读刹车/油门点的标准做法</div></div>`}
    <div class="secblock"><h3>多圈速度叠加对比</h3>
      <div class="cmpchips" id="cmpChips">${a.full.map(l => `<button class="chip ${cmpLaps.has(l.index) ? 'on' : ''}" data-lap="${l.index}" style="--c:${cmpColor(l.index)}">#${l.index}</button>`).join('')}</div>
      <canvas id="chartCompare" class="chart" width="680" height="300"></canvas>
      <div class="satnote">同一张「赛道进度轴」上叠加所选圈的速度曲线，对比走线/刹车点差异。点击上方色块切换显示哪些圈（至少选 2 圈对比才有意义）。</div>
    </div>
    <div class="secblock"><h3>每圈汇总</h3>${lapTab}</div>
    <div class="secblock"><h3>刹车 / 油门事件 <select id="lapSel" class="lapsel">${lapOpts}</select></h3>${evHtml || '<div class="satnote">无刹车/油门事件。</div>'}</div>
    <div class="secblock"><h3>弯角明细（最快圈）</h3>${cornerHtml}</div>
    <div class="secblock"><div class="adv"><h3 style="color:var(--amber);border-left-color:var(--amber);margin-top:0">提升点</h3>${adv}</div></div>
    <div class="satnote">${isIR
      ? '注：iRacing .ibt 遥测坐标是模拟器输出的精确 WGS84，赛道直接落在真实场地；油门/刹车/档位/转速均为模拟器真实通道。'
      : '注：VBO 经纬度按官方格式（十进制分钟，经度正数为西经）解析，赛道已落在<b>真实场地位置</b>。若仍有几米误差属 GPS 正常漂移，可用地图「对齐」微调。'}</div>`;
  drawChart(document.getElementById('chart'), a.speedProfile, a.gProfile, a.corners);
  if (isIR) {
    const pdc = document.getElementById('chartPedal');
    drawPedalChart(pdc, a.pedalProfile, a.corners);
    bindPedalChart(pdc, a.pedalProfile);
    bindPedalCtrl(a);
  } else drawLongChart(document.getElementById('chartLong'), a.longGProfile, a.corners);
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
const PEDAL = {
  unit: 'pct',                                         // pct | dist | time
  x0: 0, x1: 1,                                        // 视窗（按采样下标归一化）
  ov: { speed: true, gear: true, rpm: false, latg: false, steer: false },
  hover: null,                                         // 悬停处的下标
  drag: null,                                          // {x, x0, x1}
  pinch: null,                                         // 双指缩放
  height: 420,
  sess: null                                           // 切换会话时复位视窗
};
function pedalRowAt(pp, i) { return pp[Math.max(0, Math.min(pp.length - 1, Math.round(i)))]; }
function pedalUnitCfg(pp, unit) {
  const last = pp[pp.length - 1];
  if (unit === 'dist') return { col: PEDAL_COLS.dist, max: last[PEDAL_COLS.dist], fmt: v => Math.round(v) + 'm', label: '圈内距离' };
  if (unit === 'time') return { col: PEDAL_COLS.time, max: last[PEDAL_COLS.time], fmt: v => v.toFixed(1) + 's', label: '圈内时间' };
  return { col: PEDAL_COLS.pct, max: 100, fmt: v => v.toFixed(1) + '%', label: '赛道进度' };
}
function drawPedalChart(cv, pp, corners) {
  if (!cv || !pp.length) return;
  const N = pp.length - 1;
  const padL = 44, padR = 50, padT = 16, padB = 34, gearH = 13;
  const showGear = PEDAL.ov.gear;
  const { W, H, ctx } = fitCanvas(cv, PEDAL.height);
  ctx.clearRect(0, 0, W, H);
  const plotH = H - padT - padB - (showGear ? gearH : 0);
  const plotW = W - padL - padR;
  const x0 = PEDAL.x0, x1 = Math.max(PEDAL.x1, x0 + 1e-4);
  const sx = i => padL + (i / N - x0) / (x1 - x0) * plotW;
  const sy = v => padT + plotH - Math.max(0, Math.min(100, v)) / 100 * plotH;   // 左轴：踏板开度 0-100%
  const uc = pedalUnitCfg(pp, PEDAL.unit);
  // 右轴量程（叠加速度 / 转速 / 横向G）
  let ovMax = 1;
  const ovSeries = [];
  if (PEDAL.ov.speed) { let m = 0; for (const r of pp) m = Math.max(m, r[PEDAL_COLS.vel]); ovSeries.push({ col: PEDAL_COLS.vel, color: '#3b9eff', max: m, name: '速度 km/h', fmt: v => v.toFixed(0) }); }
  if (PEDAL.ov.rpm) { let m = 0; for (const r of pp) m = Math.max(m, r[PEDAL_COLS.rpm]); ovSeries.push({ col: PEDAL_COLS.rpm, color: '#f5a623', max: m, name: '转速 rpm', fmt: v => v.toFixed(0) }); }
  if (PEDAL.ov.latg) { let m = 0; for (const r of pp) m = Math.max(m, r[PEDAL_COLS.latg]); ovSeries.push({ col: PEDAL_COLS.latg, color: '#a259ff', max: Math.max(m, 0.5), name: '横向G', fmt: v => v.toFixed(2) }); }
  for (const s of ovSeries) ovMax = Math.max(ovMax, s.max);
  const sy2 = v => padT + plotH - Math.max(0, Math.min(ovMax, v)) / ovMax * plotH;   // 右轴

  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();

  // ① 弯角区间：交替底色 + 顶部编号
  if (corners && corners.length) {
    const pctToIdx = p => p / 100 * N;
    for (let ci = 0; ci < corners.length; ci++) {
      const s = pctToIdx(corners[ci].progress_pct);
      const e = ci + 1 < corners.length ? pctToIdx(corners[ci + 1].progress_pct) : N;
      if (ci % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(sx(s), padT, sx(e) - sx(s), plotH); }
      ctx.strokeStyle = 'rgba(245,166,35,.55)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(sx(s), padT); ctx.lineTo(sx(s), padT + plotH); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f5a623'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
      const lx = Math.max(sx(s) + 3, padL + 2);
      if (lx < padL + plotW - 2) ctx.fillText('C' + corners[ci].id, lx, padT + 11);
    }
  }
  // ② 网格
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = sy(25 * k); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); }
  // ③ 填充区（刹车在下、油门在上，重叠处可见叠加）
  const i0 = Math.max(0, Math.floor(x0 * N)), i1 = Math.min(N, Math.ceil(x1 * N));
  const area = (col, fill) => {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(sx(i0), sy(0));
    for (let i = i0; i <= i1; i++) ctx.lineTo(sx(i), sy(pp[i][col]));
    ctx.lineTo(sx(i1), sy(0)); ctx.closePath(); ctx.fill();
  };
  area(PEDAL_COLS.brk, 'rgba(225,6,0,.22)');
  area(PEDAL_COLS.thr, 'rgba(46,204,113,.22)');
  // ④ 叠加通道（右轴）
  for (const s of ovSeries) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.2; ctx.globalAlpha = .85; ctx.beginPath();
    for (let i = i0; i <= i1; i++) { const x = sx(i), y = sy2(pp[i][s.col]); i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  // ⑤ 踏板线（画在最上层）
  const line = (col, color, w) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = i0; i <= i1; i++) { const x = sx(i), y = sy(pp[i][col]); i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
  };
  line(PEDAL_COLS.thr, '#2ecc71', 1.8);
  line(PEDAL_COLS.brk, '#e10600', 1.8);
  // ⑥ 转向角（叠加在踏板轴上，0-100% 表示 ±90°）
  if (PEDAL.ov.steer) {
    ctx.strokeStyle = 'rgba(22,214,201,.9)'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const st = pp[i][PEDAL_COLS.steer];
      const v = 50 + Math.max(-1, Math.min(1, st / (Math.PI / 2))) * 50;
      const x = sx(i), y = sy(v); i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // ⑦ 底部档位色带
  if (showGear) {
    const gy = padT + plotH, gh = gearH;
    ctx.save(); ctx.beginPath(); ctx.rect(padL, gy, plotW, gh); ctx.clip();
    let prevG = null, segStart = i0;
    for (let i = i0; i <= i1; i++) {
      const g = pp[i][PEDAL_COLS.gear];
      if (g !== prevG) {
        if (prevG !== null) {
          ctx.fillStyle = ['#5a6470', '#3b9eff', '#16d6c9', '#2ecc71', '#f5a623', '#ff7ac6', '#e10600', '#a259ff'][Math.min(7, Math.max(0, prevG))];
          ctx.fillRect(sx(segStart), gy, Math.max(1, sx(i) - sx(segStart)), gh);
          if (sx(i) - sx(segStart) > 14) { ctx.fillStyle = '#0b0e13'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(prevG > 0 ? String(prevG) : 'N', (sx(segStart) + sx(i)) / 2, gy + gh - 3); }
        }
        segStart = i; prevG = g;
      }
    }
    if (prevG !== null) {
      ctx.fillStyle = ['#5a6470', '#3b9eff', '#16d6c9', '#2ecc71', '#f5a623', '#ff7ac6', '#e10600', '#a259ff'][Math.min(7, Math.max(0, prevG))];
      ctx.fillRect(sx(segStart), gy, Math.max(1, sx(i1) - sx(segStart)), gh);
      if (sx(i1) - sx(segStart) > 14) { ctx.fillStyle = '#0b0e13'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(prevG > 0 ? String(prevG) : 'N', (sx(segStart) + sx(i1)) / 2, gy + gh - 3); }
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.strokeRect(padL, gy, plotW, gh);
    ctx.fillStyle = '#8b98a5'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('档', padL - 4, gy + gh - 3);
  }
  // ⑧ 左边框 + 右轴刻度
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.stroke();
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let k = 0; k <= 4; k++) { const v = 25 * k; ctx.fillStyle = '#8b98a5'; ctx.fillText(v + '%', padL - 5, sy(v) + 3); }
  if (ovSeries.length) {
    ctx.textAlign = 'left';
    for (let k = 0; k <= 4; k++) {
      const v = ovMax * k / 4;
      ctx.fillStyle = ovSeries[0].color; ctx.globalAlpha = .85;
      ctx.fillText(ovSeries[0].fmt(v), padL + plotW + 5, sy2(v) + 3); ctx.globalAlpha = 1;
    }
  }
  // ⑨ X 轴刻度（按当前单位 & 当前视窗跨度自适应，避免放大后刻度重叠）
  const firstRow = pp[i0], lastRow = pp[i1];
  const uMin = firstRow[uc.col], uMax = lastRow[uc.col];
  const at = axisTicks(uMin, uMax, Math.max(2, plotW / 110));
  ctx.fillStyle = '#8b98a5'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  const axisY = H - padB + (showGear ? gearH : 0) + 14;
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(padL, axisY - 17); ctx.lineTo(padL + plotW, axisY - 17); ctx.stroke();
  for (const v of at.ticks) {
    if (v < uMin - 1e-9 || v > uMax + 1e-9) continue;
    const targetIdx = (v - uMin) / (uMax - uMin) * (i1 - i0) + i0;
    const x = sx(targetIdx);
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.moveTo(x, axisY - 18); ctx.lineTo(x, axisY - 12); ctx.stroke();
    ctx.fillText(uc.fmt(v), Math.max(padL + 12, Math.min(padL + plotW - 12, x)), axisY);
  }
  ctx.fillStyle = '#6b7885'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(uc.label + ' →', padL, H - 6);
  if (x1 - x0 < 0.98) { ctx.textAlign = 'right'; ctx.fillStyle = '#f5a623'; ctx.fillText('已放大 ' + (1 / (x1 - x0)).toFixed(1) + '× · 双击复位', padL + plotW, H - 6); }

  // ⑩ 悬停十字线 + 读数框
  if (PEDAL.hover != null) {
    const i = Math.max(0, Math.min(N, PEDAL.hover)), row = pp[i], x = sx(i);
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH + (showGear ? gearH : 0)); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    for (const [col, color] of [[PEDAL_COLS.thr, '#2ecc71'], [PEDAL_COLS.brk, '#e10600']]) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, sy(row[col]), 3.2, 0, 7); ctx.fill();
    }
    const rows = [
      [uc.label, uc.fmt(row[uc.col])],
      ['油门', row[PEDAL_COLS.thr].toFixed(1) + '%'],
      ['刹车', row[PEDAL_COLS.brk].toFixed(1) + '%'],
      ['速度', row[PEDAL_COLS.vel].toFixed(1) + ' km/h'],
      ['档位', row[PEDAL_COLS.gear] > 0 ? row[PEDAL_COLS.gear] : 'N'],
      ['转速', row[PEDAL_COLS.rpm] + ' rpm'],
      ['转向', (row[PEDAL_COLS.steer] / RAD).toFixed(1) + '°'],
      ['横/纵G', row[PEDAL_COLS.latg].toFixed(2) + ' / ' + row[PEDAL_COLS.long].toFixed(2)]
    ];
    const bw = 132, bh = rows.length * 14 + 8;
    let bx = x + 12; if (bx + bw > padL + plotW) bx = x - 12 - bw; if (bx < padL) bx = padL + 2;
    let by = padT + 6; if (by + bh > padT + plotH) by = padT + plotH - bh - 4;
    ctx.fillStyle = 'rgba(8,11,16,.93)'; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 5); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
    rows.forEach((r, k) => {
      const ty = by + 14 + k * 14;
      ctx.fillStyle = '#8b98a5'; ctx.fillText(r[0], bx + 7, ty);
      ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'right'; ctx.fillText(r[1], bx + bw - 7, ty); ctx.textAlign = 'left';
    });
  }
}
/* 绑定踏板图的交互：滚轮/双指缩放、拖拽平移、悬停读数、双击复位 */
function bindPedalChart(cv, pp) {
  if (!cv || !pp || !pp.length) return;
  const N = pp.length - 1;
  const padL = 44, padR = 50;
  const plotW = () => Math.max(60, (cv.clientWidth || 660) - padL - padR);
  const redraw = () => { const s = SESSIONS.find(x => x.id === curId); if (s) drawPedalChart(cv, s.analysis.pedalProfile, s.analysis.corners); };
  const frac = clientX => {
    const r = cv.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left - padL) / plotW()));
  };
  const idxFromX = clientX => Math.round((PEDAL.x0 + frac(clientX) * (PEDAL.x1 - PEDAL.x0)) * N);
  const clamp = () => {
    const span = Math.min(1, Math.max(0.008, PEDAL.x1 - PEDAL.x0));   // 最多放大约 125×
    PEDAL.x0 = Math.max(0, Math.min(1 - span, PEDAL.x0)); PEDAL.x1 = PEDAL.x0 + span;
  };
  const zoomAt = (f, k) => {
    const at = PEDAL.x0 + f * (PEDAL.x1 - PEDAL.x0);
    PEDAL.x0 = at - (at - PEDAL.x0) * k; PEDAL.x1 = at + (PEDAL.x1 - at) * k;
    clamp();
  };
  const pointers = new Map();          // pointerId → clientX
  let pan = null;                      // {from, x0, x1}
  let pinch = null;                    // {d0, x0, x1, f}

  cv.style.cursor = 'crosshair';
  cv.style.touchAction = 'none';       // 手机上禁用默认滚动，才能接管拖拽/缩放

  cv.onwheel = e => {
    e.preventDefault();
    zoomAt(frac(e.clientX), e.deltaY > 0 ? 1.2 : 1 / 1.2);
    redraw();
  };
  cv.onpointerdown = e => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e.clientX);
    if (pointers.size === 2) {                       // 进入双指缩放
      const xs = [...pointers.values()];
      pinch = { d0: Math.abs(xs[1] - xs[0]) || 1, x0: PEDAL.x0, x1: PEDAL.x1, f: (frac(xs[0]) + frac(xs[1])) / 2 };
      pan = null; PEDAL.drag = null;
      return;
    }
    if (e.pointerType === 'touch') PEDAL.hover = idxFromX(e.clientX);
    pan = { from: e.clientX, x0: PEDAL.x0, x1: PEDAL.x1 };
    PEDAL.drag = pan;
  };
  cv.onpointermove = e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e.clientX);
    if (pinch && pointers.size >= 2) {
      const xs = [...pointers.values()];
      const d = Math.abs(xs[1] - xs[0]) || 1;
      const k = pinch.d0 / d;                        // 手指张开 → 放大
      PEDAL.x1 = pinch.x1; PEDAL.x0 = pinch.x0;
      zoomAt(pinch.f, k);
      redraw(); return;
    }
    if (pan) {
      const dx = (e.clientX - pan.from) / plotW() * (pan.x1 - pan.x0);
      PEDAL.x0 = pan.x0 - dx; PEDAL.x1 = pan.x1 - dx; clamp(); redraw(); return;
    }
    PEDAL.hover = idxFromX(e.clientX); redraw();
  };
  const endPointer = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { pan = null; PEDAL.drag = null; }
  };
  cv.onpointerup = endPointer;
  cv.onpointercancel = endPointer;
  cv.onpointerleave = () => { PEDAL.hover = null; pan = null; PEDAL.drag = null; redraw(); };
  cv.ondblclick = () => { PEDAL.x0 = 0; PEDAL.x1 = 1; redraw(); };
}
/* 踏板图控制条：横轴单位 / 叠加通道 / 缩放 / 高度 */
function bindPedalCtrl(a) {
  const box = document.getElementById('pedCtrl');
  const pdc = document.getElementById('chartPedal');
  if (!box || !pdc || !a.pedalProfile || !a.pedalProfile.length) return;
  const redraw = () => drawPedalChart(pdc, a.pedalProfile, a.corners);
  const clampSpan = () => {
    const span = Math.min(1, Math.max(0.008, PEDAL.x1 - PEDAL.x0));
    PEDAL.x0 = Math.max(0, Math.min(1 - span, PEDAL.x0)); PEDAL.x1 = PEDAL.x0 + span;
  };
  const zoomCenter = k => {
    const at = (PEDAL.x0 + PEDAL.x1) / 2;
    PEDAL.x0 = at - (at - PEDAL.x0) * k; PEDAL.x1 = at + (PEDAL.x1 - at) * k;
    clampSpan();
  };
  box.onclick = e => {
    const b = e.target.closest ? e.target.closest('.pbtn') : null;
    if (!b) return;
    if (b.dataset.unit) {
      PEDAL.unit = b.dataset.unit;
      box.querySelectorAll('[data-unit]').forEach(x => x.classList.toggle('on', x.dataset.unit === PEDAL.unit));
      redraw();
    } else if (b.dataset.ov) {
      const k = b.dataset.ov;
      PEDAL.ov[k] = !PEDAL.ov[k];
      b.classList.toggle('on', PEDAL.ov[k]);
      redraw();
    } else if (b.dataset.zoom) {
      const z = b.dataset.zoom;
      if (z === 'in') zoomCenter(1 / 1.8);
      else if (z === 'out') zoomCenter(1.8);
      else { PEDAL.x0 = 0; PEDAL.x1 = 1; PEDAL.hover = null; }
      redraw();
    } else if (b.dataset.h) {
      PEDAL.height = Math.max(260, Math.min(780, PEDAL.height + (+b.dataset.h)));
      redraw();
    }
  };
}
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
        track: name, offset: { dLat: 0, dLon: 0 }, excluded: [], tireByLap: ibtTireByLap(r.ticks),
        analysis: analyze(pts) };
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
    const s = { id, name, date, points: parsed.points, source: 'vbo', track: '', offset: { dLat: 0, dLon: 0 }, excluded: [], analysis: analyze(parsed.points) };
    SESSIONS.push(s);
    renderSidebar();
    if (SESSIONS.length === 1) selectSession(id);
    dbSave(s);   // 持久化
    onDone && onDone(s);
  };
  reader.readAsText(file);
}
function setupIO() {
  const input = document.getElementById('fileInput');
  input.addEventListener('change', e => { for (const f of e.target.files) loadFile(f); input.value = ''; });
  const isDataFile = n => /\.(vbo|ibt)$/i.test(n);
  const dz = document.getElementById('dropZone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => { e.stopPropagation(); for (const f of e.dataTransfer.files) if (isDataFile(f.name)) loadFile(f); });
  // 整页也能拖
  ['dragover'].forEach(ev => document.body.addEventListener(ev, e => e.preventDefault()));
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) if (isDataFile(f.name)) loadFile(f);
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
        points: s.points, offset: s.offset || { dLat: 0, dLon: 0 },
        track: s.track || (s.source === 'iracing' ? s.name : ''),
        tireByLap: s.tireByLap || null,
        excluded: (s.excluded || []).slice(), savedAt: Date.now()
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
  const excluded = Array.isArray(rec.excluded) ? rec.excluded.filter(x => typeof x === 'number') : [];
  const s = { id: rec.id, name: rec.name, date: rec.date, source: rec.source || 'vbo',
    track: rec.track || (rec.source === 'iracing' ? rec.name : ''),
    points: rec.points, offset: rec.offset || { dLat: 0, dLon: 0 }, tireByLap: rec.tireByLap || null,
    excluded, analysis: analyze(rec.points, excluded) };
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

window.addEventListener('DOMContentLoaded', () => {
  initMap(); setupIO();
  restoreSessions();
  // 视口变化后按新宽度重绘（canvas 是 width:100%，分辨率需跟着变，否则会拉伸模糊）
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const s = SESSIONS.find(x => x.id === curId);
      if (!s) return;
      const a = s.analysis, isIR = !!a.isIR;
      const pdc = document.getElementById('chartPedal');
      if (isIR && pdc) drawPedalChart(pdc, a.pedalProfile, a.corners);
      const cc = document.getElementById('chartCompare'); if (cc) drawCompare(s);
      const ch = document.getElementById('chart'); if (ch) drawChart(ch, a.speedProfile, a.gProfile, a.corners);
      const lc = document.getElementById('chartLong'); if (lc && !isIR) drawLongChart(lc, a.longGProfile, a.corners);
    }, 160);
  });
});
