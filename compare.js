/* 多圈对比页：任意两圈（可跨 session/跨节）的各项数据差距在哪
   核心是累积时间 Delta —— 曲线往上走=对比圈在这段丢时间，往下走=捡时间
   跨 session 时 X 轴用「圈内进度 %」（不同节里程不同，距离不可比） */
(function () {
  const N = 1000;
  let A = null, B = null;          // {sid, lap}：参考圈 / 对比圈
  let cmp = null;                  // compareLaps / compareIdeal 结果
  let ideal = false;               // 标杆圈模式：B 侧换成「理论最快圈」虚拟圈
  let idealInfo = null;            // 标杆圈桩对象（index=-1，time=理论时间，当普通圈用）
  let tagA = '', tagB = '';        // 图表/表格里 A/B 的称呼（标杆模式下 B 是「理论圈」）
  let trA = {}, trB = {};          // 各通道曲线缓存
  const show = { thr: true, brk: true, speed: false, steer: false, gear: false, rpm: false, latg: false, long: false };
  const views = {};                // 各图视窗
  const view = k => (views[k] || (views[k] = { i0: 0, i1: N }));

  function sessById(sid) { return SESSIONS.find(x => x.id === sid) || null; }
  function lapGet(sid, idx) { const s = sessById(sid); return s ? s.analysis.full.find(l => l.index === idx) : null; }
  function sDate(s) { return String(s.date || '').replace(/^iRacing /, ''); }

  /* 从极限圈速页传过来的「要对比哪两圈」，读完立刻清掉。
     新格式 {sa, a, sb, b} 跨 session；老格式 {a, b} 视为当前 session */
  function loadFocusCmp() {
    try {
      const raw = localStorage.getItem('kart.focusCmp');
      if (!raw) return null;
      localStorage.removeItem('kart.focusCmp');
      const o = JSON.parse(raw);
      if (!o || o.a == null || o.b == null) return null;
      const sid = curSession() ? curSession().id : null;
      return { sa: o.sa || sid, a: o.a, sb: o.sb || sid, b: o.b };
    } catch (e) { return null; }
  }

  /* 把 pick 归一化成 {sid, lap}（sid/lap 无效时回退） */
  function norm(pick, fallbackSid) {
    const s = sessById(pick && pick.sid) || sessById(fallbackSid) || SESSIONS[SESSIONS.length - 1];
    if (!s) return null;
    let lap = pick && pick.lap;
    if (!lapGet(s.id, lap)) {
      lap = s.analysis.best ? s.analysis.best.index
        : (s.analysis.full.length ? s.analysis.full[0].index : null);
    }
    return { sid: s.id, lap };
  }
  /* B 的默认值：优先同赛道另一个 session 的最快圈（跨节对比），否则本 session 第二快 */
  function defaultB() {
    const sA = sessById(A.sid); if (!sA) return null;
    const sameTrack = SESSIONS.filter(x => x.id !== A.sid && sessionTrack(x) === sessionTrack(sA));
    const other = sameTrack.map(x => x.analysis.best).filter(b => b)
      .sort((x, y) => x.time_s - y.time_s)[0];
    if (other) return { sid: other ? sameTrack.find(x => x.analysis.best === other).id : A.sid, lap: other.index };
    const pool = sA.analysis.full.filter(l => !l.abnormal && !(sA.analysis.excluded || []).includes(l.index));
    const sorted = [...(pool.length ? pool : sA.analysis.full)].sort((x, y) => x.time_s - y.time_s);
    const best = sA.analysis.best;
    const b = sorted.find(l => best && l.index !== best.index) || sorted[0];
    return { sid: sA.id, lap: b ? b.index : null };
  }

  /* 计算两圈的各通道曲线 */
  function build() {
    const sA = sessById(A.sid);
    if (!sA || A.lap == null) return;
    const la = lapGet(A.sid, A.lap); if (!la) return;
    /* 标杆圈模式：B 侧是虚拟的「理论最快圈」，不依赖另一节/圈 */
    if (ideal) {
      const segN = 50;
      cmp = compareIdeal(sA, la, N, segN);
      trA = { speed: lapTrace(sA, la, 'speed', N) };
      const it = idealLapTrace(sA, N, segN);
      trB = { speed: it || [] };
      const idl = idealLap(sA, segN);
      if (idl && it && it.length) {
        let vmax = 0, vmin = Infinity;
        for (const p of it) { if (p.v > vmax) vmax = p.v; if (p.v < vmin) vmin = p.v; }
        idealInfo = { index: -1, time_s: idl.idealTime, distance_m: la.distance_m, max_speed: vmax, metrics: { minSpeed: vmin }, segN };
      } else {
        idealInfo = { index: -1, time_s: la.time_s, distance_m: la.distance_m, max_speed: la.max_speed, metrics: {}, segN };
      }
      return;
    }
    const sB = sessById(B.sid);
    if (!sB || B.lap == null) return;
    const lb = lapGet(B.sid, B.lap); if (!lb) return;
    cmp = compareLaps(sA, la, sB, lb, N);
    trA = { speed: lapTrace(sA, la, 'speed', N) };
    trB = { speed: lapTrace(sB, lb, 'speed', N) };
    for (const ch in show) {
      if (show[ch] && ch !== 'speed' && !trA[ch]) { trA[ch] = lapTrace(sA, la, ch, N); trB[ch] = lapTrace(sB, lb, ch, N); }
    }
  }

  function render() {
    const cur = curSession(), box = document.getElementById('content');
    if (!cur) {
      box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`;
      return;
    }
    const sid = cur.id;
    // 从「极限圈速」页跳转过来的指定两圈（读完即清）
    const want = loadFocusCmp();
    if (want) { A = norm({ sid: want.sa, lap: want.a }, sid); B = norm({ sid: want.sb, lap: want.b }, sid); }
    A = norm(A, sid);
    // B 无效时才给默认（优先同赛道另一个 session 的最快圈 = 跨节对比）
    if (!B || !lapGet(B.sid, B.lap)) B = defaultB();
    B = norm(B, sid);
    const sA = sessById(A.sid);
    if (!sA || !sA.analysis.full.length) { box.innerHTML = `<div class="blank">当前会话没有完整圈。</div>`; return; }
    if (A.lap == null) A = norm({ sid: sA.id, lap: sA.analysis.best ? sA.analysis.best.index : null }, sid);
    // B 无效时给默认（跨节最佳）
    if (B.lap == null || !lapGet(B.sid, B.lap)) { B = defaultB(); B = norm(B, sid); }
    // A/B 同 session 同圈 → 挪到同 session 次快圈
    if (B.sid === A.sid && B.lap === A.lap) {
      const sorted = [...sA.analysis.full].sort((x, y) => x.time_s - y.time_s);
      const alt = sorted.find(l => l.index !== A.lap);
      if (alt) B = { sid: A.sid, lap: alt.index };
    }
    build();

    const idealMode = ideal;
    const sB = idealMode ? sA : sessById(B.sid);
    const la = lapGet(A.sid, A.lap), lb = idealMode ? idealInfo : lapGet(B.sid, B.lap);
    if (!la || !lb) { box.innerHTML = `<div class="blank">选中的圈数据无效。</div>`; return; }
    const ir = !!sA.analysis.isIR;
    const diff = lb.time_s - la.time_s;
    const cross = !idealMode && sessionTrack(sA) !== sessionTrack(sB);
    /* 标杆模式下 B 侧是虚拟圈：称呼、会话下拉、通道图都跟着切换 */
    const segN = 50;
    const aTag = idealMode ? '你的圈' : '#' + A.lap;
    const bTag = idealMode ? '理论圈' : '#' + B.lap;
    const aLabel = idealMode ? '你的圈 #' + A.lap : '参考圈 #' + A.lap;
    const bLabel = idealMode ? '✨ 理论最快圈' : '对比圈 #' + B.lap;
    tagA = aTag; tagB = bTag;
    const diffLabel = idealMode
      ? (diff < -0.0005 ? `理论圈快 ${Math.abs(diff).toFixed(3)}s` : '已达成理论上限')
      : (diff > 0 ? '#' + B.lap + ' 更慢' : diff < 0 ? '#' + B.lap + ' 更快' : '持平');
    const sessOpts = SESSIONS.map(x =>
      `<option value="${x.id}" ${x.id === A.sid ? 'selected' : ''}>${esc(trackZh(sessionTrack(x)))} · ${esc(sDate(x))} · ${x.analysis.validCount != null ? x.analysis.validCount : x.analysis.full.length}圈</option>`).join('');
    const sessOpts2 = SESSIONS.map(x =>
      `<option value="${x.id}" ${x.id === B.sid ? 'selected' : ''}>${esc(trackZh(sessionTrack(x)))} · ${esc(sDate(x))} · ${x.analysis.validCount != null ? x.analysis.validCount : x.analysis.full.length}圈</option>`).join('');
    /* ⚠ 之前用一个闭包 lapOpts(sid) 复用，但 sid2 === A.sid ? A.lap : B.lap
       在 A.sid === B.sid 时两边都选 A.lap，导致 B 的下拉显示错的圈。直接各自生成。 */
    const lapOptsFor = (sid2, selLap) => {
      const s = sessById(sid2); if (!s) return '';
      return s.analysis.full.map(l => `<option value="${l.index}" ${l.index === selLap ? 'selected' : ''}>#${l.index} · ${fmtTime(l.time_s, 3)}${l.abnormal ? ' ⚠' : ''}</option>`).join('');
    };
    const chBtns = Object.keys(show).filter(ch => ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer'))
      .map(ch => `<button class="pbtn ov ${show[ch] ? 'on' : ''}" data-ch="${ch}" style="--c:${CHANNELS[ch].color}">${CHANNELS[ch].name}</button>`).join('');

    box.innerHTML = `
      ${cross ? `<div class="notice">⚠ 这两节<b>不是同一个赛道</b>（A=${esc(trackZh(sessionTrack(sA)))} / B=${esc(trackZh(sessionTrack(sB)))}），进度%对比仅供参考，圈速差没有意义。建议选同一个赛道的两节。</div>` : ''}
      <div class="stats">
        <div class="statbox"><div class="v">${fmtTime(la.time_s, 3)}</div><div class="k">${aLabel}<span class="sub" style="display:block;color:var(--mut);font-size:10.5px">${esc(trackZh(sessionTrack(sA)))} · ${esc(sDate(sA))}</span></div></div>
        <div class="statbox"><div class="v ${idealMode ? 'gold' : ''}">${fmtTime(lb.time_s, 3)}</div><div class="k">${bLabel}<span class="sub" style="display:block;color:var(--mut);font-size:10.5px">${idealMode ? '分段最优拼接' : esc(trackZh(sessionTrack(sB))) + ' · ' + esc(sDate(sB))}</span></div></div>
        <div class="statbox"><div class="v ${deltaCls(diff)}">${deltaTxt(diff)}</div><div class="k">${diffLabel}</div></div>
        <div class="statbox"><div class="v ${deltaCls(lb.max_speed - la.max_speed)}">${(lb.max_speed - la.max_speed) >= 0 ? '+' : ''}${(lb.max_speed - la.max_speed).toFixed(1)}</div>
          <div class="k">极速差 km/h</div></div>
      </div>

      <div class="card">
        <h3>选择对比的两节/圈 <span class="cunit">会话=某一节（某天跑的），可跨节对比：昨天 vs 今天</span></h3>
        <div class="crow">
          <label class="clab">参考
            <select id="selSessA" class="sbsel">${sessOpts}</select>
            <select id="selLapA" class="sbsel">${lapOptsFor(A.sid, A.lap)}</select></label>
          ${idealMode
            ? `<span class="sbsel on" style="pointer-events:none">✨ 理论最快圈 · ${segN} 段最优拼接</span>`
            : `<label class="clab">对比
            <select id="selSessB" class="sbsel">${sessOpts2}</select>
            <select id="selLapB" class="sbsel">${lapOptsFor(B.sid, B.lap)}</select></label>`}
          <button class="pbtn" id="swapBtn">⇄ 交换</button>
          <button class="pbtn" id="bestBtn">各节最快</button>
          <button class="pbtn ${idealMode ? 'on' : ''}" id="idealBtn" style="--c:#ffd23f">✨ 对标理论最快圈</button>
        </div>
        <p class="chint">「各节最快」= 参考用当前节的最快圈，对比用<b>另一个 session</b>（同赛道）的最快圈——直接看这节进步了多少。想同节内比，把两个会话选成同一个就行。<br>「对标理论最快圈」= 把这一节所有圈按赛道位置切成 ${segN} 段、每段取你跑得最快的那圈拼成一个「理论最快圈」，再看你当前这圈离它还差在哪——这是你在这条赛道上的理论上限。</p>
      </div>

      <div class="card">
        <h3>时间差 Delta <span class="cunit">${idealMode ? '曲线往上 = 你在这段丢了时间' : `曲线往上 = #${B.lap} 丢时间，往下 = 捡时间`}</span></h3>
        <canvas id="cvDelta" class="chart"></canvas>
        <p class="chint">纵轴是「${idealMode ? '你相对理论上限' : `#${B.lap} 相对 #${A.lap}`}的累积时间差」，单位秒。
          ${idealMode ? '曲线上升的那段就是你还能榨出时间的地方——每段取自你跑得最快的那一圈，合起来就是这条赛道上你今天能达到的理论上限。'
          : `曲线<b>陡然上升</b>的那一段就是 #${B.lap} 丢时间最多的地方——去对照下面的油门/刹车图，通常能看到刹车太早、给油太晚或弯心速度不够。`}</p>
      </div>

      <div class="card">
        <h3>速度差 <span class="cunit">${idealMode ? '你的速度 − 理论圈' : `#${B.lap} − #${A.lap}`}</span></h3>
        <canvas id="cvSpd" class="chart"></canvas>
        <p class="chint">${idealMode ? '正值（绿）= 你比理论圈还快，负值（红）= 比理论圈慢——负值大的地方就是该练的弯。' : `正值（绿）= #${B.lap} 更快，负值（红）= #${B.lap} 更慢。`}已做平滑，看趋势即可。</p>
      </div>

      ${idealMode ? '' : `<div class="card">
        <h3>通道对比 <span class="cunit">两条线叠加：蓝=#${A.lap}（${esc(trackZh(sessionTrack(sA)))} ${esc(sDate(sA))}），红=#${B.lap}（${esc(trackZh(sessionTrack(sB)))} ${esc(sDate(sB))}）</span></h3>
        <div class="pcgroup" id="chBtns" style="margin-bottom:10px">${chBtns}</div>
        <div id="chArea" class="chgrid"></div>
        ${ir ? '' : '<p class="chint">VBO 数据没有踏板/档位/转向传感器，油门与刹车是由纵向 G 推导的（数值为 G，非开度%）。</p>'}
      </div>`}

      <div class="card">
        <h3>分段差异 <span class="cunit">每 5% 赛道进度一段</span></h3>
        ${zoneTable()}
      </div>

      <div class="card">
        <h3>关键指标对比</h3>
        ${metricTable(la, lb, ir)}
      </div>`;

    document.getElementById('selSessA').onchange = e => {
      const s = sessById(e.target.value);
      A = { sid: s.id, lap: s.analysis.best ? s.analysis.best.index : null };
      if (!ideal && B.sid === A.sid) B = defaultB();
      render();
    };
    const selSB = document.getElementById('selSessB');
    if (selSB) selSB.onchange = e => {
      const s = sessById(e.target.value);
      B = { sid: s.id, lap: s.analysis.best ? s.analysis.best.index : null };
      if (B.sid === A.sid && B.lap === A.lap) B = defaultB();
      render();
    };
    document.getElementById('selLapA').onchange = e => { A = { sid: A.sid, lap: +e.target.value }; render(); };
    const selLB = document.getElementById('selLapB');
    if (selLB) selLB.onchange = e => { B = { sid: B.sid, lap: +e.target.value }; render(); };
    document.getElementById('swapBtn').onclick = () => { const t = A; A = B; B = t; render(); };
    document.getElementById('bestBtn').onclick = () => {
      const sA2 = sessById(A.sid);
      A = { sid: A.sid, lap: sA2.analysis.best ? sA2.analysis.best.index : null };
      B = defaultB();
      render();
    };
    document.getElementById('idealBtn').onclick = () => { ideal = !ideal; render(); };
    const cb = document.getElementById('chBtns');
    if (cb) cb.onclick = e => {
      const b = e.target.closest ? e.target.closest('[data-ch]') : null; if (!b) return;
      const ch = b.dataset.ch; show[ch] = !show[ch]; b.classList.toggle('on', show[ch]);
      build(); renderChannels();
    };
    drawAll();
  }

  function zoneTable() {
    if (!cmp) return '<p class="chint">无数据</p>';
    const rows = cmp.zones.map(z => `<tr>
      <td>${z.from.toFixed(0)}–${z.to.toFixed(0)}%</td>
      <td>${((z.from + z.to) / 2).toFixed(0)}%</td>
      <td class="${deltaCls(z.gain)}">${deltaTxt(z.gain)}</td>
      <td class="${deltaCls(z.spdAvg)}">${(z.spdAvg >= 0 ? '+' : '') + z.spdAvg.toFixed(1)}</td>
    </tr>`).join('');
    const lost = cmp.lost.slice(0, 3).map(z => `${z.from.toFixed(0)}–${z.to.toFixed(0)}%（${deltaTxt(z.gain)}）`).join('、') || '无';
    return `<table class="ctab">
      <thead><tr><th>区间</th><th>位置</th><th>${ideal ? '还能榨出' : '时间差'}</th><th>平均速度差</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="chint"><b>${ideal ? '你还能榨出时间最多的三段' : '#' + tagB + ' 丢时间最多的三段'}：</b>${lost}</p>`;
  }

  function metricTable(la, lb, ir) {
    const m1 = la.metrics || {}, m2 = lb.metrics || {};
    const rows = [
      ['圈速', fmtTime(la.time_s, 3), fmtTime(lb.time_s, 3), lb.time_s - la.time_s, v => deltaTxt(v)],
      ['圈里程', la.distance_m.toFixed(0) + 'm', lb.distance_m.toFixed(0) + 'm', 0, () => '—'],
      ['极速', la.max_speed.toFixed(1), lb.max_speed.toFixed(1), lb.max_speed - la.max_speed, v => (v >= 0 ? '+' : '') + v.toFixed(1)],
      ['最低速', m1.minSpeed != null ? m1.minSpeed.toFixed(1) : '-', m2.minSpeed != null ? m2.minSpeed.toFixed(1) : '-',
      (m2.minSpeed || 0) - (m1.minSpeed || 0), v => (v >= 0 ? '+' : '') + v.toFixed(1)],
      ['全油门占比', m1.flatout_pct != null ? m1.flatout_pct + '%' : '-', m2.flatout_pct != null ? m2.flatout_pct + '%' : '-',
      (m2.flatout_pct || 0) - (m1.flatout_pct || 0), v => (v >= 0 ? '+' : '') + v.toFixed(0) + '%'],
      ['刹车点数', m1.brakeCount != null ? m1.brakeCount : '-', m2.brakeCount != null ? m2.brakeCount : '-',
      (m2.brakeCount || 0) - (m1.brakeCount || 0), v => (v >= 0 ? '+' : '') + v.toFixed(0)],
      ['峰值减速', m1.peakBrakeG != null ? m1.peakBrakeG + (ir ? '%' : 'G') : '-', m2.peakBrakeG != null ? m2.peakBrakeG + (ir ? '%' : 'G') : '-', 0, () => '—'],
      ['G-Sum 峰值', m1.gsumPeak != null ? m1.gsumPeak : '-', m2.gsumPeak != null ? m2.gsumPeak : '-', 0, () => '—']
    ];
    return `<table class="ctab"><thead><tr><th>指标</th><th>${tagA}（${esc(trackZh(sessionTrack(sessById(A.sid))))} ${esc(sDate(sessById(A.sid)))})</th><th>${tagB}${ideal ? '（分段最优拼接）' : '（' + esc(trackZh(sessionTrack(sessById(B.sid)))) + ' ' + esc(sDate(sessById(B.sid))) + '）'}</th><th>差异</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td>
        <td class="${r[3] === 0 ? 'd-zero' : deltaCls(r[3])}">${r[4](r[3])}</td></tr>`).join('')}</tbody></table>
      ${ideal ? '<p class="chint">理论最快圈是由速度曲线合成的虚拟圈，只有速度类指标可比；油门/刹车/挡位等通道没有理论值，所以不显示。</p>' : ''}`;
  }

  /* ---------- 绘图 ---------- */
  function drawAll() { drawDelta(); drawSpd(); renderChannels(); }

  /* 注意：cfg 必须是「同一个持久对象」——bindTraceChart 会把 view / hoverIdx
     写回这个对象，onView 回调再原样重绘，缩放和悬停才会生效。
     如果每次 getCfg() 都新建一个对象，hover 状态会被丢掉。 */
  function xAxis(cfg) { cfg.xLabels = cmp.pct; cfg.xFmt = t => t.toFixed(0) + '%'; }
  function drawDelta() {
    const cv = document.getElementById('cvDelta'); if (!cv || !cmp) return;
    const v = view('delta');
    const cfg = {
      height: 320, view: v, zeroLine: true,
      corners: sessById(A.sid) ? sessById(A.sid).analysis.corners : [], sectors: true,
      series: [
        { name: '', data: cmp.delta.map(x => Math.max(0, x)), color: '#ff6b6b', fill: 'rgba(255,107,107,.25)', width: 0, legend: false },
        { name: '', data: cmp.delta.map(x => Math.min(0, x)), color: '#3fb950', fill: 'rgba(63,185,80,.25)', width: 0, legend: false },
        { name: '时间差 Delta (s)', color: '#e6edf3', data: cmp.delta, width: 1.9 }
      ],
      hoverIdx: v.hoverIdx,
      tip: i => [
        ['进度', (i / N * 100).toFixed(1) + '%'],
        ['Delta', deltaTxt(cmp.delta[i]), cmp.delta[i] > 0 ? '#ff6b6b' : '#3fb950'],
        [tagA + ' 速度', trA.speed ? trA.speed[i].v.toFixed(1) + ' km/h' : '-'],
        [tagB + ' 速度', trB.speed ? trB.speed[i].v.toFixed(1) + ' km/h' : '-']
      ]
    };
    xAxis(cfg);
    drawTraces(cv, cfg);
    bindTraceChart(cv, () => cfg, () => drawTraces(cv, cfg));
    const h3 = cv.closest(".card") ? cv.closest(".card").querySelector("h3") : null;
    if (h3) chartTools(h3, cv, () => cfg, () => drawTraces(cv, cfg));
  }
  function drawSpd() {
    const cv = document.getElementById('cvSpd'); if (!cv || !cmp) return;
    const v = view('spd');
    const cfg = {
      height: 260, view: v, zeroLine: true,
      corners: sessById(A.sid) ? sessById(A.sid).analysis.corners : [], sectors: true,
      series: [
        { name: '', data: cmp.spdDiff.map(x => Math.max(0, x)), color: '#3fb950', fill: 'rgba(63,185,80,.22)', width: 0, legend: false },
        { name: '', data: cmp.spdDiff.map(x => Math.min(0, x)), color: '#ff6b6b', fill: 'rgba(255,107,107,.22)', width: 0, legend: false },
        { name: '速度差 (km/h)', color: '#3b9eff', data: cmp.spdDiff, width: 1.8 }
      ],
      hoverIdx: v.hoverIdx,
      tip: i => [
        ['进度', (i / N * 100).toFixed(1) + '%'],
        ['速度差', (cmp.spdDiff[i] >= 0 ? '+' : '') + cmp.spdDiff[i].toFixed(1) + ' km/h',
        cmp.spdDiff[i] >= 0 ? '#3fb950' : '#ff6b6b'],
        [tagA, trA.speed ? trA.speed[i].v.toFixed(1) : '-'],
        [tagB, trB.speed ? trB.speed[i].v.toFixed(1) : '-']
      ]
    };
    xAxis(cfg);
    drawTraces(cv, cfg);
    bindTraceChart(cv, () => cfg, () => drawTraces(cv, cfg));
    const h3 = cv.closest(".card") ? cv.closest(".card").querySelector("h3") : null;
    if (h3) chartTools(h3, cv, () => cfg, () => drawTraces(cv, cfg));
  }

  /* 每个通道一张图，两条线叠加（Garage61 风格） */
  function renderChannels() {
    const box = document.getElementById('chArea'); if (!box) return;
    const sA = sessById(A.sid); if (!sA) return;
    const ir = !!sA.analysis.isIR;
    const chs = Object.keys(show).filter(ch => show[ch] && (ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer')));
    if (!chs.length) { box.innerHTML = '<p class="chint">勾选上方通道即可显示对比图。</p>'; return; }
    box.innerHTML = chs.map(ch => {
      const c = CHANNELS[ch];
      const unit = (!ir && (ch === 'thr' || ch === 'brk')) ? 'G' : c.unit;
      return `<div class="chcard">
        <div class="chart-head"><span class="cname" style="color:${c.color}">${c.name}</span>
          <span class="cunit">${unit}</span><span class="grow"></span>
          <span class="cunit">蓝 ${tagA} · 红 ${tagB}</span></div>
        <canvas id="ch_${ch}" class="chart"></canvas>
      </div>`;
    }).join('');
    for (const ch of chs) {
      const cv = document.getElementById('ch_' + ch); if (!cv) continue;
      const v = view('ch_' + ch);
      const c = CHANNELS[ch];
      const d1 = trA[ch].map(p => p.v), d2 = trB[ch].map(p => p.v);
      const unit = (!ir && (ch === 'thr' || ch === 'brk')) ? 'G' : c.unit;
      const cfg = {
        height: 210, view: v, corners: sA.analysis.corners, sectors: true,
        xLabels: trA[ch].map(p => p.pct), xFmt: t => t.toFixed(0) + '%',
        series: [
          { name: tagA, color: '#3b9eff', data: d1, width: 1.7 },
          { name: tagB, color: '#e10600', data: d2, width: 1.7 }
        ],
        hoverIdx: v.hoverIdx,
        tip: i => [
          ['进度', trA[ch][i].pct.toFixed(1) + '%'],
          [tagA, d1[i].toFixed(c.dec) + ' ' + unit, '#3b9eff'],
          [tagB, d2[i].toFixed(c.dec) + ' ' + unit, '#e10600'],
          ['差值', ((d2[i] - d1[i]) >= 0 ? '+' : '') + (d2[i] - d1[i]).toFixed(c.dec),
          (d2[i] - d1[i]) >= 0 ? '#3fb950' : '#ff6b6b']
        ]
      };
      drawTraces(cv, cfg);
      bindTraceChart(cv, () => cfg, () => { drawTraces(cv, cfg); });
      const head = cv.closest(".chcard") ? cv.closest(".chcard").querySelector(".chart-head") : null;
      if (head) chartTools(head, cv, () => cfg, () => drawTraces(cv, cfg));
    }
  }

  document.addEventListener('DOMContentLoaded', () => bootPage('compare.html', () => { A = B = null; ideal = false; idealInfo = null; render(); }));
})();
