/* ================================================================
   RaceChrono .rcz 解析器(Web 端)
   ----------------------------------------------------------------
   .rcz 本质是 zip 包,内含 session.json(元数据/圈时间) + 若干
   channel_<sid>_<dev>_<?>_<chanId>_<idx> 二进制通道文件。

   已逆向确认的通道布局(小端,每 8 字节一组):
     1   = 时间戳        int64  ms(绝对 Unix 毫秒,10Hz)
     2   = 累计距离      int64  mm
     3   = 位置          int32 pair: latitude, longitude(1e7 度)
     4   = 速度          int32 pair: 取前者 mm/s
     5   = 海拔          int32 pair: 取前者 mm
     6   = 航向(bearing) int32 pair: 取前者 1e-3 度
     30002 = 卫星数      int32 pair
     30003 = 定位类型    int32 pair(2 = 3D)
     30004 = 定位精度    int32 pair mm
   4/5/6/3000x 通常 5Hz,1/2/3 为 10Hz → 统一插值到时间轴。

   ⚠ 坐标编码:RaceChrono 的 lat/lon 不是标准 E7,而是「度 × 6e6」
     (= 度分 × 1e5,这样 ±180° 都在 int32 范围内)。用真实场地交叉
     验证过(汉赛跑跑 ÷6e6 后周长与里程通道比值 1.000,落点 30.50N
     /113.96E 正确)。代码按里程通道在 6e6 / 1e7 之间自动择优,并对
     明显异常的比例做兜底缩放。
   ================================================================ */

/* ---------- zip 解压(零依赖,浏览器 DecompressionStream) ---------- */
function rczU32(dv, off) { return dv.getUint32(off, true); }
async function rczUnzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  /* 从尾部找 EOCD(0x06054b50),最多回退 64KB) */
  let eocd = -1;
  const min = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .rcz(找不到 zip 目录)');
  const count = dv.getUint16(eocd + 10, true);
  let off = rczU32(dv, eocd + 16);
  const dec = new TextDecoder('utf-8');
  const files = {};
  for (let n = 0; n < count; n++) {
    if (rczU32(dv, off) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = rczU32(dv, off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = rczU32(dv, off + 42);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    /* 本地头里 size 可能为 0(data descriptor),所以一律用中央目录的 csize */
    const lnameLen = dv.getUint16(lho + 26, true), lextraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    const comp = u8.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压 .rcz,请换新版 Chrome/Edge/Safari');
      const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error('不支持的 zip 压缩方式(' + method + ')');
    files[name] = data;
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ---------- 通道解码 ---------- */
function rczI64(u8) {
  const n = u8.byteLength >> 3, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Number(dv.getBigInt64(i * 8, true));
  return a;
}
function rczPairFirst(u8) {
  const n = u8.byteLength >> 3, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = dv.getInt32(i * 8, true);
  return a;
}
function rczPairBoth(u8) {
  const n = u8.byteLength >> 3, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), a = [];
  for (let i = 0; i < n; i++) a.push([dv.getInt32(i * 8, true), dv.getInt32(i * 8 + 4, true)]);
  return a;
}
/* 把长度 m 的序列重采样到 n 个点(线性插值;m===n 时原样返回) */
function rczResample(arr, n) {
  const m = arr.length;
  if (m === n) return arr;
  if (m === 0) return new Array(n).fill(0);
  if (m === 1) return new Array(n).fill(arr[0]);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * (m - 1) / (n - 1), i0 = Math.floor(x), i1 = Math.min(m - 1, i0 + 1), f = x - i0;
    out[i] = arr[i0] * (1 - f) + arr[i1] * f;
  }
  return out;
}
/* 角度重采样:必须走最短弧,否则 359°→1° 线性插值会插出 180° 假跳变(横向 G 会爆到 5G+) */
function rczResampleAngle(arr, n) {
  const m = arr.length;
  if (m === n) return new Float64Array(arr);
  if (m === 0) return new Float64Array(n);
  if (m === 1) return new Float64Array(n).fill(arr[0]);
  const wrap = d => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * (m - 1) / (n - 1), i0 = Math.floor(x), i1 = Math.min(m - 1, i0 + 1), f = x - i0;
    let v = arr[i0] + wrap(arr[i1] - arr[i0]) * f;
    while (v < 0) v += 360; while (v >= 360) v -= 360;
    out[i] = v;
  }
  return out;
}
/* 从文件名取通道:channel_<sid>_<dev>_<?>_<chan>_<idx>;同一通道优先 primaryGpsDevice */
function rczChannels(files, primaryDev) {
  const out = {};
  for (const full of Object.keys(files)) {
    const base = full.split('/').pop();
    const m = /^channel_(\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/.exec(base);
    if (!m) continue;
    const dev = +m[2], ch = +m[4];
    if (!out[ch] || dev === primaryDev) out[ch] = files[full];
  }
  return out;
}

/* ---------- 坐标几何长度(米) ---------- */
function rczGeoLen(lat, lon) {
  const R = 6371000, RAD = Math.PI / 180;
  let la = 0;
  for (let i = 0; i < lat.length; i++) la += lat[i];
  const cos = Math.cos(la / lat.length * RAD);
  let s = 0;
  for (let i = 1; i < lat.length; i++) {
    const dy = (lat[i] - lat[i - 1]) * RAD * R;
    const dx = (lon[i] - lon[i - 1]) * RAD * R * cos;
    s += Math.hypot(dx, dy);
  }
  return s;
}

/* ---------- 主解析:输入解压后的 files 表 ---------- */
function parseRCZFiles(files) {
  /* session.json 可能在根目录或子目录(备份包) */
  const sKey = Object.keys(files).filter(k => /(^|\/)session\.json$/.test(k))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!sKey) {
    const isTrack = Object.keys(files).some(k => /(^|\/)trackId\.json$/.test(k));
    throw new Error(isTrack
      ? '这是 RaceChrono 的「赛道定义」文件(只有计时点,没有圈速数据)。请在 App 里打开某一次 Session → 分享 → 选 .rcz。'
      : '.rcz 里没有 session.json(可能不是 RaceChrono 会话文件)');
  }
  const session = JSON.parse(new TextDecoder('utf-8').decode(files[sKey]));
  const dir = sKey.slice(0, sKey.length - 'session.json'.length);

  /* 同目录的附属 json(可选) */
  let frag = null;
  try {
    const fk = dir + 'sessionfragment.json';
    if (files[fk]) frag = JSON.parse(new TextDecoder('utf-8').decode(files[fk]));
  } catch (e) { }
  const primaryDev = (frag && frag.primaryGpsDeviceIndex) || 100;

  /* 只取当前 session 目录下的通道(排除备份包里其它 session) */
  const mine = {};
  for (const k of Object.keys(files)) if (k.startsWith(dir) && /(^|\/)channel_\d+_\d+_\d+_\d+_\d+$/.test(k)) mine[k] = files[k];
  const ch = rczChannels(mine, primaryDev);

  /* 时间:优先 channel 1(int64 ms);缺失则用 session 的 firstTimestamp + 10Hz 推断 */
  let tAbs, n;
  if (ch[1]) { tAbs = rczI64(ch[1]); n = tAbs.length; }
  else {
    const first = session.firstTimestamp || Date.now();
    const len = (session.lengthTime || 0);
    n = Math.max(2, Math.round(len / 100));
    tAbs = new Float64Array(n);
    for (let i = 0; i < n; i++) tAbs[i] = first + i * 100;
  }
  if (n < 10) throw new Error('.rcz 数据点太少');

  /* 累计距离(mm → m):既用于坐标单位自检,也是速度缺失时的兜底 */
  const distCh = ch[2] ? rczI64(ch[2]).map(v => v / 1000) : null;

  /* 位置(10Hz):RaceChrono 不用标准 E7,而是「度 × 6e6」(= 度分 × 1e5,
     180°×6e6=1.08e9 刚好不溢出 int32)。实测汉赛跑跑 ÷6e6 后几何周长与
     里程通道比值正好 1.000,落点 30.50N / 113.96E 与实际场地一致。
     为兼容可能的其它版本,按里程通道在 6e6 / 1e7 之间自动择优。 */
  let lat = null, lon = null, geoDiv = 0;
  if (ch[3]) {
    const p = rczPairBoth(ch[3]);
    const rl = p.map(x => x[0]), rn = p.map(x => x[1]);
    const distTotal = distCh && distCh.length > 1 ? (distCh[distCh.length - 1] - distCh[0]) : 0;
    let bestErr = Infinity, bestLa = null, bestLo = null;
    for (const div of [6e6, 1e7]) {
      const la = rl.map(x => x / div), lo = rn.map(x => x / div);
      const gl = rczGeoLen(la, lo);
      const err = (distTotal > 50 && gl > 50) ? Math.abs(gl / distTotal - 1) : (div === 6e6 ? 0 : 1);
      if (err < bestErr) { bestErr = err; geoDiv = div; bestLa = la; bestLo = lo; }
    }
    lat = rczResample(new Float64Array(bestLa), n);
    lon = rczResample(new Float64Array(bestLo), n);
  }
  let spd = null;
  if (ch[4]) spd = rczResample(new Float64Array(Array.from(rczPairFirst(ch[4]), v => v / 1000)), n);
  else if (distCh && distCh.length === n) {
    spd = new Float64Array(n);
    for (let i = 1; i < n; i++) spd[i] = (distCh[i] - distCh[i - 1]) / Math.max(1e-6, (tAbs[i] - tAbs[i - 1]) / 1000);
  }
  /* 海拔 mm → m */
  const alt = ch[5] ? rczResample(new Float64Array(Array.from(rczPairFirst(ch[5]), v => v / 1000)), n) : null;
  /* 航向 mdeg → deg(角度插值,避免 0/360 跨界假跳变) */
  const brg = ch[6] ? rczResampleAngle(new Float64Array(Array.from(rczPairFirst(ch[6]), v => v / 1000)), n) : null;

  /* ---- 坐标自检:正常(÷6e6)时里程与几何应基本一致,只在明显异常时兜底缩放 ---- */
  let geoScale = 1;
  if (lat && lon && distCh && distCh.length >= 2) {
    const gl = rczGeoLen(lat, lon);
    if (gl > 50) {
      const ratio = (distCh[distCh.length - 1] - distCh[0]) / gl;
      geoScale = Math.round(ratio * 1000) / 1000;
      if (ratio > 1.12 || ratio < 0.88) {
        let la0 = 0, lo0 = 0;
        for (let i = 0; i < n; i++) { la0 += lat[i]; lo0 += lon[i]; }
        la0 /= n; lo0 /= n;
        for (let i = 0; i < n; i++) { lat[i] = la0 + (lat[i] - la0) * ratio; lon[i] = lo0 + (lon[i] - lo0) * ratio; }
      }
    }
  }

  /* ---- 圈标记:直接采用 RaceChrono 的计时线结果(比 GPS 闭环更准) ---- */
  const lapsMeta = (session.laps || []).filter(l => l.finishTimestamp && l.startTimestamp);
  const lapNoArr = new Array(n);
  for (let i = 0; i < n; i++) {
    const ms = tAbs[i];
    let no = null;
    for (let k = 0; k < lapsMeta.length; k++) {
      const l = lapsMeta[k];
      if (ms >= l.startTimestamp && ms < l.finishTimestamp) { no = l.number; break; }
    }
    if (no == null) {
      if (lapsMeta.length && ms < lapsMeta[0].startTimestamp) no = lapsMeta[0].number - 1;
      else if (lapsMeta.length) no = lapsMeta[lapsMeta.length - 1].number + 1;
      else no = 1;
    }
    lapNoArr[i] = no;
  }

  /* ---- 组装 points(与 .vbo 同构:vel 用 km/h,hdg 用度,h 用米) ---- */
  const t0 = tAbs[0];
  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = {
      t: (tAbs[i] - t0) / 1000,
      lat: lat ? lat[i] : 0,
      lon: lon ? lon[i] : 0,
      vel: spd ? spd[i] * 3.6 : 0,
      hdg: brg ? brg[i] : 0,
      h: alt ? alt[i] : null,
      lapNo: lapNoArr[i]
    };
  }

  /* 名称/时间 */
  const trackName = session.trackName || 'RaceChrono 赛道';
  const d = new Date(session.firstTimestamp || t0);
  const pad = x => String(x).padStart(2, '0');
  const date = trackName + ' ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());

  return {
    name: trackName, date, trackName, points, geoScale, geoDiv,
    lapCount: session.lapCount || lapsMeta.length,
    source: 'rcz'
  };
}

/* ---------- 对外:ArrayBuffer → 解析结果 ---------- */
async function parseRCZ(buf) {
  const files = await rczUnzip(buf);
  return parseRCZFiles(files);
}

if (typeof window !== 'undefined') { window.parseRCZ = parseRCZ; window.parseRCZFiles = parseRCZFiles; }
