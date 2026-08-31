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
      tt: tk.tt ? tk.tt.map(v => Math.round(v * 10) / 10) : null,   // 4 轮 × (L,M,R) 胎体温度 °C
      tc: tk.tc ? tk.tc.map(v => Math.round(v * 10) / 10) : null,   // 4 轮 × (L,M,R) 表面温度 °C
      ws: tk.ws ? tk.ws.map(v => Math.round(v * 10) / 10) : null,   // 4 轮转速 m/s
      /* absCut / absAct 分开存，不在这一步合并：
         实测 296 GT3 里 BrakeABScutPct 恒为 1.0（连不刹车时都是），是无效通道；
         BrakeABSactive 才是真信号。合并成一个字段会让上层无法判断该信谁。 */
      absCut: tk.absCut != null ? Math.round(tk.absCut * 10) / 10 : null,   // ABS 削减比例 %
      absAct: tk.absAct != null ? (tk.absAct ? 1 : 0) : null                // ABS 是否激活 0/1
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
function compareLaps(sA, lapA, sB, lapB, N = 1000) {
  const A = lapTrace(sA, lapA, 'speed', N);
  const B = lapTrace(sB, lapB, 'speed', N);
  const delta = [], dist = [], spdDiff = [], pct = [];
  for (let k = 0; k <= N; k++) {
    delta.push(B[k].t - A[k].t);            // 秒，正 = B 慢
    dist.push(A[k].d);                       // X 轴用参考圈的圈内距离
    spdDiff.push(B[k].v - A[k].v);           // 速度差 km/h，负 = B 慢
    pct.push(k / N * 100);                   // 圈内进度 %（跨 session 对比时用，距离不可比）
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
    N, delta, dist, pct, spdDiff: spdDiffS, zones,
    total,
    lapA: lapA.index, lapB: lapB.index,
    timeA: lapA.time_s, timeB: lapB.time_s,
    // B 净丢时间最多的区间（正 gain）与捡回最多的（负 gain）
    lost: zones.filter(z => z.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, 5),
    gained: zones.filter(z => z.gain < 0).sort((a, b) => a.gain - b.gain).slice(0, 5)
  };
}

/* ---------- 轮胎 & ABS 分析（仅 iRacing） ----------
   只挑跟「提升圈速」直接相关的三块（避震之类的细节先不做）：
   ① 长距离胎温：四轮胎面温度 + 内外温差（外倾/胎压诊断）+ 逐圈趋势
   ② ABS 介入：占刹车时间的比例 + 介入最狠的弯 → 刹车过深的证据
   ③ 磨损：每圈磨损量 + 内外偏磨
   tt 顺序：0-2 LF(L,M,R) / 3-5 RF / 6-8 LR / 9-11 RR；
   「外侧」= 靠车身外的一侧：LF、LR 取 L，RF、RR 取 R。

   ⚠ 真实 .ibt 实测（296 GT3 @Watkins Glen / Road America）发现的坑，代码里都做了防御：
   · BrakeABScutPct 在这车上恒为 1.0（不刹车也是 1），完全没有信息量 → 必须做「常量通道检测」，
     常量则弃用，改用 BrakeABSactive（布尔，实测刹车中 44.5% / 15.5% 触发，是真信号）。
   · LFtempC*(表面温度) 只有部分文件会写，Road America 那份全程恒 34.5°C → 同样要检测，
     无效时回退到 LFtemp*(胎体温度)，并在界面上标明用的是哪个。
   · LFwear* 在练习/测试节里全程只有一个取值（不模拟磨损）→ 检测无变化就不再显示磨损。
   · 温度阈值不能写死：胎体温度和表面温度差 30°C 以上，必须按来源分别给窗口。 */
const WHEELS = [
  { key: 'LF', name: '左前', mid: 1, outer: 0, inner: 2 },
  { key: 'RF', name: '右前', mid: 4, outer: 5, inner: 3 },
  { key: 'LR', name: '左后', mid: 7, outer: 6, inner: 8 },
  { key: 'RR', name: '右后', mid: 10, outer: 11, inner: 9 }
];
/* ⚠ 实测两个真文件后确认：LFtempC*(表面温度) 是**冻结快照**——全场一个值不变
   （Watkins Glen 恒 90.58，Road America 恒 34.55，唯一值个数 = 1）。
   所以：工作窗口 / 逐圈趋势只能用 LFtemp*(胎体温度，实时变化，唯一值 5961 个)；
   表面温度只在「三层 L/M/R 有真实差异」时才拿来看内外偏磨（外倾签名）。
   窗口按来源分开给：胎体比表面低 20~30°C，用同一个阈值会全错。 */
const TIRE_WIN = {
  surface: { warm: 85, hot: 110, label: '表面温度' },
  carcass: { warm: 70, hot: 100, label: '胎体温度' }
};
const R1 = v => Math.round(v * 10) / 10;
/* 判断一组通道是不是「活的」：全程极差太小说明游戏根本没在写（或恒定），不能拿来分析 */
function chanLive(mn, mx, minRange) {
  return mn != null && mx != null && isFinite(mn) && isFinite(mx) && (mx - mn) >= minRange;
}
function tireAnalysis(s) {
  if (s.__tire !== undefined) return s.__tire;
  const pts = s.points, a = s.analysis;
  if (!(pts.length && pts[0] && pts[0].tt)) { s.__tire = null; return null; }

  /* ── 0. 有效飞行圈集合：出场圈/回场圈/异常圈的胎温会把均值带偏，
        这里只取「有效圈」覆盖到的点，得到的才是真正的长距离工作温度 ── */
  const valid = new Set();
  for (const l of (a.full || [])) if (!l.abnormal && !(s.excluded || []).some(x => x === l.index)) valid.add(l.index);
  const useValid = valid.size > 0;

  /* ── 1. 通道活性检测（一遍扫描拿 min/max）── */
  const mnT = new Array(12).fill(null), mxT = new Array(12).fill(null);
  const mnC = new Array(12).fill(null), mxC = new Array(12).fill(null);
  let mnAbs = null, mxAbs = null;
  for (const p of pts) {
    if (p.tt) for (let i = 0; i < 12; i++) { const v = p.tt[i]; if (v == null || !isFinite(v)) continue;
      if (mnT[i] == null || v < mnT[i]) mnT[i] = v; if (mxT[i] == null || v > mxT[i]) mxT[i] = v; }
    if (p.tc) for (let i = 0; i < 12; i++) { const v = p.tc[i]; if (v == null || !isFinite(v)) continue;
      if (mnC[i] == null || v < mnC[i]) mnC[i] = v; if (mxC[i] == null || v > mxC[i]) mxC[i] = v; }
  }
  const ttLive = chanLive(Math.min(...mnT.filter(x => x != null)), Math.max(...mxT.filter(x => x != null)), 5);
  let cLo = null, cHi = null;
  if (pts.some(p => p.tc)) {
    const f = mnC.filter(x => x != null);
    if (f.length) { cLo = Math.min(...f); cHi = Math.max(...mxC.filter(x => x != null)); }
  }
  const tcLive = chanLive(cLo, cHi, 5);
  /* 胎温（工作窗口/趋势）只能来源自实时通道 → 表面温度是冻结快照，恒定不能用 */
  const src = 'carcass';
  const win = TIRE_WIN[src];
  const TIRE_WARM = win.warm, TIRE_HOT = win.hot;
  /* 内外偏磨（外倾/胎压签名）优先用表面温度——它的 L/M/R 三层差更能反映接地面。
     但前提是三层真的有差异；Road America 那份 tc 三层全等 34.55（冷胎开局快照），
     这种情况退回车体温度算。 */
  let geo = 'tt';
  if (pts.some(p => p.tc)) {
    let ok = 0;
    for (let w = 0; w < 4; w++) {
      const i0 = w * 3, vals = [mnC[i0], mnC[i0 + 1], mnC[i0 + 2]].filter(x => x != null);
      if (vals.length === 3 && Math.max(...vals) - Math.min(...vals) >= 3) ok++;
    }
    if (ok >= 3) geo = 'tc';
  }

  /* ── 2. 四轮统计（只算有效圈的点）── */
  const sum = new Array(12).fill(0), peak = new Array(12).fill(-999);
  const gSum = new Array(12).fill(0);            // 几何（内外温差）用另一组通道单独累加
  let cnt = 0, cntAll = 0;
  const byLap = new Map();
  for (const p of pts) {
    const T = p.tt;
    if (!T) continue;
    const G = p[geo];
    const isFly = useValid ? valid.has(p.lap) : true;
    cntAll++;
    let g = byLap.get(p.lap);
    if (!g) { g = { lap: p.lap, t: new Array(12).fill(0), n: 0, nAll: 0, tAll: new Array(12).fill(0), absCnt: 0, brakeCnt: 0, maxSlip: 0, slipSum: 0 }; byLap.set(p.lap, g); }
    g.nAll++; for (let i = 0; i < 12; i++) g.tAll[i] += T[i];   // 逐圈趋势要包含非飞行圈，不然曲线中间会断
    if (isFly) {
      cnt++;
      for (let i = 0; i < 12; i++) { sum[i] += T[i]; if (T[i] > peak[i]) peak[i] = T[i]; }
      if (G) for (let i = 0; i < 12; i++) gSum[i] += G[i];
      g.n++;
      for (let i = 0; i < 12; i++) g.t[i] += T[i];
    }
    // ABS / 滑移：刹车事件本身不受"是否有效圈"影响，全程都算
    if (p.brk > 0.05) {
      g.brakeCnt++;
      if (p.absAct) g.absCnt++;
      if (p.ws && p.vel > 30) {
        const car = p.vel / 3.6, sl = Math.max(...p.ws.slice(0, 4).map(x => (car - x) / car));
        if (sl > g.maxSlip) g.maxSlip = sl;
        g.slipSum += sl;
      }
    }
  }
  if (!cnt) { s.__tire = null; return null; }
  const wheels = WHEELS.map(w => ({
    key: w.key, name: w.name,
    avg: R1(sum[w.mid] / cnt),
    peak: R1(peak[w.mid]),
    outer: R1(gSum[w.outer] / cnt),
    inner: R1(gSum[w.inner] / cnt),
    delta: R1((gSum[w.outer] - gSum[w.inner]) / cnt)
  }));

  /* ── 3. ABS / 滑移 ──
     实测：BrakeABScutPct 恒为 1.0（常量通道），BrakeABSactive 才是真信号。
     所以主指标用 active 占比，cut 只在它真的有波动时才作为"深度"补充。 */
  let brakeCnt = 0, absCnt = 0, cutSum = 0, cutN = 0, deepCnt = 0;
  let slipSum = 0, slipN = 0, maxSlip = 0, lockN = 0, lockRun = 0;
  const absAt = [];
  for (const p of pts) {
    if (p.brk > 0.05) {
      brakeCnt++;
      if (p.absAct) { absCnt++; absAt.push((p.lapPct || 0) * 100); }
      if (p.absCut != null && isFinite(p.absCut)) { cutSum += p.absCut; cutN++; if (p.absCut > 5) { deepCnt++; } }
      if (p.ws && p.vel > 30) {
        const car = p.vel / 3.6, sl = Math.max(...p.ws.slice(0, 4).map(x => (car - x) / car));
        slipSum += sl; slipN++;
        if (sl > maxSlip) maxSlip = sl;
        if (sl > 0.15) { lockRun++; if (lockRun >= 3) lockN++; } else lockRun = 0;   // 连续 3 帧(50ms)以上算一次锁死
      }
    } else lockRun = 0;
    if (p.absCut != null && isFinite(p.absCut)) { if (mnAbs == null || p.absCut < mnAbs) mnAbs = p.absCut; if (mxAbs == null || p.absCut > mxAbs) mxAbs = p.absCut; }
  }
  const cutLive = chanLive(mnAbs, mxAbs, 3);   // 削减比例通道是否真的在动
  const abs = {
    brakePct: brakeCnt ? R1(absCnt / brakeCnt * 100) : 0,          // ABS 触发占刹车时间
    deepPct: cutLive && brakeCnt ? R1(deepCnt / brakeCnt * 100) : 0, // 削减 >5% 的深度介入
    avgCut: cutLive && cutN ? R1(cutSum / cutN) : 0,
    cutLive,
    avgSlip: slipN ? R1(slipSum / slipN * 100) : 0,
    maxSlip: R1(maxSlip * 100),
    lockCount: lockN
  };
  const buckets = {};
  for (const pct of absAt) { const b = Math.floor(pct / 5) * 5; buckets[b] = (buckets[b] || 0) + 1; }
  const cornerOf = pct => {
    let best = null, bd = 1e9;
    for (const c of (a.corners || [])) { const d = Math.abs(c.progress_pct - pct); if (d < bd) { bd = d; best = c; } }
    return bd <= 8 ? best : null;
  };
  abs.hotspots = Object.keys(buckets).map(k => +k).sort((x, y) => buckets[y] - buckets[x]).slice(0, 3)
    .map(b => { const c = cornerOf(b + 2.5); return { pct: b, cornerId: c ? c.id : null, n: buckets[b], pctOfBrake: brakeCnt ? R1(buckets[b] / brakeCnt * 100) : 0 }; });

  const laps = [...byLap.values()].map(g => ({
    lap: g.lap,
    temp: g.nAll ? R1((g.tAll[1] + g.tAll[4] + g.tAll[7] + g.tAll[10]) / 4 / g.nAll) : null,
    absPct: g.brakeCnt ? R1(g.absCnt / g.brakeCnt * 100) : 0,
    maxSlip: R1(g.maxSlip * 100),
    fly: useValid ? valid.has(g.lap) : true
  })).sort((x, y) => x.lap - y.lap);
  /* 温度是否还在爬：把飞行圈按时间三等分，比较后段与前段。
     还在爬 = 这节太短、胎没热透，此时不该拿绝对温度去判"设定有问题"。 */
  const flySeq = laps.filter(l => l.fly && l.temp != null);
  let climb = 0, plateauTemp = null, settled = false;
  if (flySeq.length >= 3) {
    const k = Math.floor(flySeq.length / 3), head = flySeq.slice(0, k), tail = flySeq.slice(-k);
    const av = arr2 => arr2.reduce((t, l) => t + l.temp, 0) / arr2.length;
    climb = R1(av(tail) - av(head));
    settled = Math.abs(climb) < 1.5;
    plateauTemp = R1(av(tail));
  } else if (flySeq.length) {
    plateauTemp = flySeq[flySeq.length - 1].temp;
    settled = false;
  }

  /* ── 4. 磨损：先检测有没有真的在变，没变就不输出（练习/测试节 iRacing 不模拟磨损）── */
  const wear = { perLap: [], total: 0, outerInner: 0, usable: false };
  if (s.tireByLap && s.tireByLap.length) {
    let wLo = null, wHi = null;
    for (const r of s.tireByLap) {
      if (!r.wearStart || !r.wearEnd) continue;
      for (let i = 0; i < 12; i++) { const d = r.wearStart[i] - r.wearEnd[i]; if (wLo == null || d < wLo) wLo = d; if (wHi == null || d > wHi) wHi = d; }
    }
    if (chanLive(wLo, wHi, 0.0002)) {           // 至少掉 0.02 个百分点才算有磨损
      wear.usable = true;
      for (const r of s.tireByLap) {
        if (!r.wearStart || !r.wearEnd) continue;
        const mid = [1, 4, 7, 10].map(i => (r.wearStart[i] - r.wearEnd[i]) * 100);
        const outer = [0, 5, 6, 11].map(i => (r.wearStart[i] - r.wearEnd[i]) * 100);
        const inner = [2, 3, 8, 9].map(i => (r.wearStart[i] - r.wearEnd[i]) * 100);
        const R3 = v => Math.round(v * 1000) / 1000;
        wear.perLap.push({ lap: r.lap, mid: R3(mid.reduce((x, y) => x + y, 0) / 4),
          outer: R3(outer.reduce((x, y) => x + y, 0) / 4), inner: R3(inner.reduce((x, y) => x + y, 0) / 4) });
      }
      if (wear.perLap.length) {
        wear.total = Math.round(wear.perLap.reduce((t, r) => t + r.mid, 0) * 100) / 100;
        const o = wear.perLap.reduce((t, r) => t + r.outer, 0) / wear.perLap.length;
        const inn = wear.perLap.reduce((t, r) => t + r.inner, 0) / wear.perLap.length;
        wear.outerInner = Math.round((o - inn) * 100) / 100;
      }
    }
  }

  /* ── 5. 结论（按有效性裁剪，不输出没依据的判断）── */
  const v = [];
  const hot = wheels.reduce((m, w) => w.peak > m.peak ? w : m, wheels[0]);
  const coldW = wheels.reduce((m, w) => w.avg < m.avg ? w : m, wheels[0]);
  const skew = wheels.reduce((m, w) => Math.abs(w.delta) > Math.abs(m.delta) ? w : m, wheels[0]);
  const judge = plateauTemp != null ? plateauTemp : coldW.avg;

  /* 过热 / 过冷：只在「温度已经稳定」时下判断。
     还在爬坡说明这节太短，此时任何窗口结论都是噪音。 */
  if (!settled && Math.abs(climb) > 3) {
    v.push({
      t: 'mid',
      txt: `胎温整节都在爬（有效圈前段 → 后段 <b>${climb > 0 ? '+' : ''}${climb}°C</b>，现在 ${plateauTemp}°C）——` +
        `这节是从冷胎起跑的短节，胎还没热透，<b>先别拿绝对温度调设定</b>。想看长距离胎温，跑一整节（10 圈以上）再导。`
    });
  } else if (judge > TIRE_HOT) {
    v.push({ t: 'warn', txt: `<b>稳定胎温 ${judge}°C 超过 ${TIRE_HOT}°C</b>（最热 ${hot.name}，瞬间峰温 ${hot.peak}°C）——长距离会掉速，这一侧负荷偏大，查胎压或外倾。` });
  } else if (judge < TIRE_WARM) {
    v.push({ t: 'mid', txt: `稳定胎温 <b>${judge}°C</b>，低于 ${TIRE_WARM}°C——胎没进工作窗口，抓地没用满（气温低或圈数太少时常见，不影响走线判断）。` });
  } else {
    v.push({ t: 'good', txt: `稳定胎温 <b>${judge}°C</b>，落在 ${TIRE_WARM}–${TIRE_HOT}°C 工作窗口内（瞬间峰温最高 ${hot.peak}°C / ${hot.name}）。` });
  }
  if (hot.peak > TIRE_HOT + 25) v.push({ t: 'warn', txt: `${hot.name}瞬间峰温到过 <b>${hot.peak}°C</b>——短时间的过热尖峰，通常来自某几个重刹弯的负荷集中。` });

  const hotAvg = wheels.reduce((m, w) => w.avg > m.avg ? w : m, wheels[0]);
  const crossSpread = R1(hotAvg.avg - coldW.avg);
  if (Math.abs(crossSpread) >= 8) v.push({ t: 'mid', txt: `四轮温差 <b>${Math.abs(crossSpread)}°C</b>（最热 ${hotAvg.name} ${hotAvg.avg}°C / 最冷 ${coldW.name} ${coldW.avg}°C）——左右负荷不均，通常是这条赛道偏某一边，可以尝试微调左右胎压或刹车比。` });
  else v.push({ t: 'good', txt: `四轮温差只有 ${Math.abs(crossSpread)}°C，左右负荷挺均衡。` });

  if (Math.abs(skew.delta) >= 12) {
    v.push({
      t: skew.delta > 0 ? 'warn' : 'mid',
      txt: `<b>${skew.name}外侧比内侧${skew.delta > 0 ? '高' : '低'} ${Math.abs(skew.delta)}°C</b>——${skew.delta > 0
        ? '典型的外倾不足或胎压偏低，外侧在硬扛，每圈都在丢抓地。' : '外倾偏大或胎压偏高，接地面偏内侧。'}`
    });
  } else v.push({ t: 'good', txt: `四轮内外温差都在 12°C 以内（最大 ${skew.name} ${skew.delta > 0 ? '+' : ''}${skew.delta}°C），设定基本合理。` });

  if (brakeCnt) {
    if (abs.brakePct > 60) v.push({ t: 'warn', txt: `<b>ABS 在 ${abs.brakePct}% 的刹车时间里都在工作</b>——几乎每个刹车都在打滑边缘，试着把峰值刹车收 3~5%、把力度往前移，出弯反而更快。` });
    else if (abs.brakePct > 30) v.push({ t: 'mid', txt: `ABS 触发占刹车时间 <b>${abs.brakePct}%</b>——GT3 重刹时触发属正常，但如果集中在某几个弯，说明那几个弯刹车给多了。` });
    else v.push({ t: 'good', txt: `ABS 只占刹车时间 ${abs.brakePct}%，大部分刹车在轮胎抓地极限内，力度控制得不错。` });
    if (abs.cutLive && abs.avgCut > 5) v.push({ t: 'warn', txt: `ABS 平均削减 <b>${abs.avgCut}%</b> 的刹车力——介入很深，这段刹车基本是 ABS 在替你控制。` });
    if (abs.lockCount > 0) v.push({ t: 'warn', txt: `检测到 <b>${abs.lockCount} 次锁死</b>（轮速比车速慢 15% 以上、持续 50ms+）——真锁死会大幅拉长刹车距离，这是最容易捡回来的时间。` });
    else if (abs.avgSlip > 8) v.push({ t: 'mid', txt: `刹车时平均滑移 <b>${abs.avgSlip}%</b>，偏高但没到锁死——轮胎一直在滑，刹车距离会变长。` });
    else if (slipN) v.push({ t: 'good', txt: `刹车时平均滑移 ${abs.avgSlip}%，轮胎基本贴着地面滚，刹车效率正常。` });
  }
  if (wear.usable) {
    if (Math.abs(wear.outerInner) >= 1) v.push({ t: 'warn', txt: `<b>偏磨明显</b>：外侧比内侧多磨 ${Math.abs(wear.outerInner).toFixed(2)} 个百分点（${wear.outerInner > 0 ? '外侧' : '内侧'}），长距离会越来越难开。` });
    else v.push({ t: 'good', txt: `内外磨损差 ${Math.abs(wear.outerInner).toFixed(2)} 个百分点，磨得挺均匀。` });
  }

  s.__tire = {
    hasTire: true, wheels, abs, laps, wear, verdicts: v,
    src, srcLabel: win.label, geo, geoLabel: geo === 'tc' ? '表面温度' : '胎体温度',
    TIRE_WARM, TIRE_HOT,
    plateauTemp, climb, settled,
    samples: cnt, samplesAll: cntAll, flyingOnly: useValid,
    chan: { ttLive, tcLive, cutLive, wearLive: wear.usable }
  };
  return s.__tire;
}
/* 旧版本（v28 之前）上传的 iRacing 会话，points 里没有 tt / absAct，
   而原 .ibt 文件不会留在 IndexedDB 里 → 只能提示重传。VBO 本来就没这些通道，不算。 */
function tireNeedsReupload(s) {
  return !!(s && s.analysis && s.analysis.isIR && s.points && s.points.length &&
    s.points[0] && s.points[0].tt === undefined);
}

/* ---------- 规则问答引擎（本地，不联网） ----------
   「我还能提升哪儿」这类问题 → 关键词匹配 → 用已有分析数据算答案。 */
const QA_RULES = [
  {
    id: 'improve', kw: ['提升', '进步', '还能', '哪里', '哪儿', '怎么练', '建议', '快一点', '更快', '提升点'],
    title: '我还能提升多少？',
    run(s, ctx) {
      const idl = ctx.idl;
      if (!idl) return { txt: '有效圈不足 2 圈，算不出理论极限。', tone: 'mid' };
      const pct = idl.gain / idl.bestTime * 100;
      const top = [...idl.segs].sort((x, y) => y.gain - x.gain).slice(0, 3)
        .map(sg => { const loc = segLocation(s, sg.from, sg.to); return `${loc.sector} ${loc.label}（−${sg.gain.toFixed(3)}s，最快 #${sg.lap}）`; });
      return {
        tone: pct > 2 ? 'warn' : pct > 0.8 ? 'mid' : 'good',
        txt: `理论上还能捡 <b>${fmtTime(idl.gain)}</b>（最快圈 ${fmtTime(idl.bestTime)} 的 ${pct.toFixed(1)}%）。<br>最值得练的三段：${top.join('；')}`,
        link: { href: 'ideal.html', label: '去极限圈速看细节' }
      };
    }
  },
  {
    id: 'sector', kw: ['赛段', '分段', 's1', 's2', 's3', '哪段', '哪一段', '段慢', '最慢', '慢在哪', '哪一段慢'],
    title: '我最慢的是哪一段？',
    run(s) {
      const a = s.analysis, sec = a.sectors || [];
      if (!sec.length) return { txt: '没有赛段数据。', tone: 'mid' };
      const w = sec.reduce((m, x) => x.std_s > m.std_s ? x : m, sec[0]);
      return {
        tone: w.std_s > 0.4 ? 'warn' : 'good',
        txt: `S1/S2/S3 平均：<b>${sec.map(x => x.name + ' ' + fmtTime(x.mean_s, 3)).join(' · ')}</b>。<br>最不稳定的是 <b>${w.name}</b>（波动 ±${w.std_s}s）——先固定走线再求快。`,
        link: { href: 'laps.html', label: '看分段表现' }
      };
    }
  },
  {
    id: 'brake', kw: ['刹车', '制动', '刹车点', 'abs', '锁死', '早刹', '晚刹'],
    title: '刹车有什么问题？',
    run(s) {
      const a = s.analysis, bc = a.brakeConsistency && a.brakeConsistency[0];
      const tir = tireAnalysis(s);
      let txt = '';
      if (bc) txt += `刹车点最不稳的位置在赛道 <b>${bc.progress}%</b>，每圈波动 <b>±${bc.std}%</b>。`;
      if (tir) {
        const ab = tir.abs;
        txt += `<br>ABS 在 <b>${ab.brakePct}%</b> 的刹车时间里触发`;
        if (tir.abs.hotspots.length) {
          const h = tir.abs.hotspots[0];
          txt += `，最频繁的一段在 <b>${h.pct}–${h.pct + 5}%</b>${h.cornerId != null ? '（T' + h.cornerId + ' 附近）' : ''}`;
        }
        if (ab.lockCount > 0) txt += `。<br>检测到 <b>${ab.lockCount} 次锁死</b>（轮速掉到车速 85% 以下），刹车时平均滑移 ${ab.avgSlip}%`;
        else if (ab.avgSlip) txt += `，刹车时平均滑移 <b>${ab.avgSlip}%</b>，最大 ${ab.maxSlip}%`;
        txt += '。';
      } else if (txt) txt += '<br>（这份数据没有 ABS/轮速通道）';
      const deep = tir && (tir.abs.brakePct > 60 || tir.abs.lockCount > 0);
      const tone = (bc && bc.std > 2) || deep ? 'warn' : 'good';
      return {
        tone, txt: txt || '刹车数据不足。',
        tip: (bc && bc.std > 2) ? '先把这个刹车点固定下来——每圈都在同一位置刹车，圈速立刻会稳。'
          : deep ? '试着把峰值刹车收 3~5%，留一点 ABS 之前的余量，出弯反而更快。' : '',
        link: { href: 'telemetry.html', label: '看 ABS 与轮胎面板' }
      };
    }
  },
  {
    id: 'tire', kw: ['胎温', '轮胎温度', '温度', '过热', '胎压', '外倾', '工作窗口'],
    title: '轮胎温度正常吗？',
    run(s) {
      const t = tireAnalysis(s);
      if (!t) {
        return tireNeedsReupload(s)
          ? { tone: 'mid', txt: '这场是<b>旧版本上传的</b>，当时没保存轮胎通道。重新上传一次原 .ibt 文件就能看到胎温/ABS/磨损（会作为新会话追加，历史不受影响）。' }
          : { tone: 'mid', txt: '这份数据没有轮胎温度通道（卡丁车 VBO 没有胎温传感器，iRacing 的 .ibt 才有）。' };
      }
      return {
        tone: t.verdicts.some(v => v.t === 'warn') ? 'warn' : 'good',
        txt: t.verdicts.map(v => '· ' + v.txt.replace(/^/, '')).join('<br>') || '轮胎数据不足。',
        tip: t.settled ? '' : '胎温还在爬坡，说明这节偏短——想看真实的长距离胎温，建议跑满一整节再导出。',
        link: { href: 'telemetry.html', label: '看轮胎与刹车面板' }
      };
    }
  },
  {
    id: 'wear', kw: ['磨损', '磨', '胎耗', '衰减', '长距离', '耐用'],
    title: '轮胎磨损怎么样？',
    run(s) {
      const t = tireAnalysis(s);
      if (!t) return { tone: 'mid', txt: '这份数据没有轮胎通道，看不了磨损。' };
      const w = t.wear;
      /* 实测：练习/测试节的 .ibt 里 LFwear* 全程只有一个取值（iRacing 不模拟磨损），
         这种情况要明说，不能报"磨得挺均匀"误导。 */
      if (!w.usable) {
        return {
          tone: 'mid',
          txt: '这场<b>没有磨损数据</b>——iRacing 在练习/测试节不会模拟轮胎损耗，磨损通道全程是一个固定值。' +
            '<br>想看长距离衰减，得跑一场<b>有轮胎损耗的比赛</b>（或长时间练习）再导出遥测。',
          link: { href: 'telemetry.html', label: '看轮胎面板' }
        };
      }
      const per = w.perLap.reduce((t, r) => t + r.mid, 0) / w.perLap.length;
      const short = Math.abs(w.total) < 0.05;
      return {
        tone: short ? 'mid' : (Math.abs(w.outerInner) >= 1 ? 'warn' : 'good'),
        txt: `平均每圈掉 <b>${per.toFixed(2)}</b> 个百分点胎面（四轮中层），全程累计 <b>${w.total.toFixed(2)}</b>。<br>` +
          (short ? '这段太短，磨损基本看不出来——想看长距离衰减，得跑一整节再分析。'
            : `内外磨损差 <b>${Math.abs(w.outerInner).toFixed(2)}</b> 个百分点（${w.outerInner > 0 ? '外侧多' : '内侧多'}）——${Math.abs(w.outerInner) >= 1 ? '偏磨会让长距离越来越难开，建议看外倾/胎压。' : '磨得挺均匀。'}`),
        link: { href: 'telemetry.html', label: '看磨损趋势' }
      };
    }
  },
  {
    id: 'consistency', kw: ['一致', '稳定', '波动', '标准差', '忽快忽慢', '不稳'],
    title: '我的一致性如何？',
    run(s) {
      const a = s.analysis;
      return {
        tone: a.core_std > 0.6 ? 'warn' : a.core_std > 0.35 ? 'mid' : 'good',
        txt: `核心圈标准差 <b>±${a.core_std}s</b>（${a.grade}），核心均速 ${fmtTime(a.core_avg, 3)}，最快 ${fmtTime(a.best_time, 3)}。<br>${a.core_std > 0.6 ? '节奏比较散，先求稳再求快。' : a.core_std > 0.35 ? '中等水平，最快的提升方式是固定刹车点。' : '很稳，可以在极限边缘多试晚刹。'}`,
        link: { href: 'laps.html', label: '看每一圈' }
      };
    }
  },
  {
    id: 'corner', kw: ['弯', '弯道', '入弯', '弯心', '转向不足', '推头', '损失', '丢速'],
    title: '哪个弯丢速最多？',
    run(s) {
      const cs = [...s.analysis.corners].sort((x, y) => y.speed_loss - x.speed_loss).slice(0, 3);
      if (!cs.length) return { tone: 'mid', txt: '没识别到弯角。' };
      return {
        tone: 'warn',
        txt: `丢速最多的弯：<b>${cs.map(c => `T${c.id} 损失 ${c.speed_loss} km/h（入 ${c.entry_speed} → 弯心 ${c.apex_speed} → 出 ${c.exit_speed}）`).join('；')}</b>。<br>出弯速度是最直接的圈速来源——晚刹 + 弯心保速 + 早给油。`,
        link: { href: 'track.html', label: '去赛道图看位置' }
      };
    }
  },
  {
    id: 'throttle', kw: ['油门', '给油', '全油门', '加速', '太晚', '早油', '给油早', '出弯给油', '早给油'],
    title: '出弯给油够早吗？',
    run(s) {
      const a = s.analysis;
      const best = a.best, m = best && best.metrics ? best.metrics : null;
      if (!m) return { tone: 'mid', txt: '没有油门/事件数据。' };
      return {
        tone: m.flatout_pct < 30 ? 'warn' : 'good',
        txt: `最快圈全油门占比 <b>${m.flatout_pct}%</b>，刹车点 ${m.brakeCount} 个，峰值减速 ${m.peakBrakeG}${a.isIR ? '%' : 'G'}，G-Sum 峰值 ${m.gsumPeak}。<br>${m.flatout_pct < 30 ? '全油门占比偏低，出弯可以再早一点给油（平滑加压，别一脚到底）。' : '全油门占比不错，接下来抠给油时机。'}`,
        link: { href: 'telemetry.html', label: '看油门曲线' }
      };
    }
  }
];
/* 问题 → 答案 */
function askQuestion(s, q, ctx = {}) {
  if (!s) return null;
  const text = String(q || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const r of QA_RULES) {
    let sc = 0;
    for (const k of r.kw) if (text.includes(k.toLowerCase())) sc += k.length >= 3 ? 2 : 1;
    if (sc > bestScore) { bestScore = sc; best = r; }
  }
  if (!best) return { fallback: true, suggestions: QA_RULES.map(r => r.title) };
  return { rule: best, ans: best.run(s, ctx) };
}

/* ---------- 赛道名显示（英文 → 中文） ----------
   iRacing 的 sessionInfo 给的是英文赛道名（TrackDisplayName），
   这里映射成中文，没收录的原样显示。 */
const TRACK_ZH = {
  'Road America': '美国之路', 'Watkins Glen': '沃特金斯格伦', 'Watkins Glen International': '沃特金斯格伦',
  'Spa-Francorchamps': '斯帕', 'Monza': '蒙扎', 'Suzuka': '铃鹿', 'Silverstone': '银石',
  'Nürburgring': '纽博格林', 'Nurburgring': '纽博格林', 'Laguna Seca': '拉古纳塞卡',
  'Sebring': '赛百灵', 'Daytona': '戴托纳', 'Le Mans': '勒芒', 'Imola': '伊莫拉',
  'Zandvoort': '赞德沃特', 'Barcelona': '巴塞罗那', 'Hungaroring': '匈牙利环',
  'Red Bull Ring': '红牛环', 'Interlagos': '英特拉格斯', 'Mount Panorama': '全景山',
  'Monaco': '摩纳哥', 'Mugello': '穆杰罗', 'Road Atlanta': '亚特兰大路',
  'Zolder': '佐尔德', 'Charlotte': '夏洛特', 'Long Beach': '长滩', 'Mid-Ohio': '中俄亥俄',
  'Indianapolis': '印第安纳波利斯', 'COTA': '美洲赛道', 'Circuit of the Americas': '美洲赛道',
  'Kyalami': '卡拉米', 'Hockenheim': '霍根海姆', 'Oulton Park': '奥顿公园',
  'Brands Hatch': '布兰兹哈奇', 'Donington': '多宁顿', 'Snetterton': '斯内特顿',
  'Phillip Island': '菲利普岛', 'Sandown': '桑当', 'Bathurst': '巴瑟斯特'
};
function trackZh(t) {
  if (!t) return '未分类赛道';
  return TRACK_ZH[t] || t;
}
/* session 的赛道字段：iRacing 自动取赛道名，VBO 没有就归「未分类赛道」 */
function sessionTrack(s) {
  if (s.track) return s.track;
  return s.source === 'iracing' ? (s.name || '') : '';
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
    const warn = markWarn && (l.abnormal === true || (median && l.time_s > median * 1.06));
    const exc = l.abnormal === true;
    return `<button class="lapchip ${sel.includes(l.index) ? 'on' : ''} ${warn ? 'warn' : ''}" data-lap="${l.index}"
      title="${exc ? '异常圈：比中位圈慢 ' + (l.abnormalPct != null ? l.abnormalPct.toFixed(0) : '?') + '%，已自动排除出统计（暖胎/出场圈？）' : (warn ? '比中位圈慢 6% 以上，可能是出场圈/失误圈' : '')}">#${l.index}<span class="lt">${fmtTime(l.time_s, 2)}</span>${exc ? '<span class="lt" style="color:var(--amber)">⚠</span>' : ''}</button>`;
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
