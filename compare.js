/* 多圈对比页：任意两圈的各项数据差距在哪
   核心是累积时间 Delta —— 曲线往上走=对比圈在这段丢时间，往下走=捡时间 */
(function () {
  const N = 1000;
  let A = null, B = null;          // 参考圈 / 对比圈的 lap index
  let cmp = null;                  // compareLaps 结果
  let trA = {}, trB = {};          // 各通道曲线缓存
  const show = { thr: true, brk: true, speed: false, steer: false, gear: false, rpm: false, latg: false, long: false };
  const views = {};                // 各图视窗
  const view = k => (views[k] || (views[k] = { i0: 0, i1: N }));

  function lapByIdx(i) { const s = curSession(); return s ? s.analysis.full.find(l => l.index === i) : null; }

  /* 从极限圈速页传过来的「要对比哪两圈」，读完立刻清掉，避免下次进页面被粘住 */
  function loadFocusCmp() {
    try {
      const raw = localStorage.getItem('kart.focusCmp');
      if (!raw) return null;
      localStorage.removeItem('kart.focusCmp');
      const o = JSON.parse(raw);
      return (o && o.a != null && o.b != null) ? o : null;
    } catch (e) { return null; }
  }

  /* 计算两圈的各通道曲线 */
  function build() {
    const s = curSession(); if (!s || A == null || B == null) return;
    const la = lapByIdx(A), lb = lapByIdx(B); if (!la || !lb) return;
    cmp = compareLaps(s, la, lb, N);
    // speed 始终计算：Delta / 速度差图的悬停读数要用
    trA = { speed: lapTrace(s, la, 'speed', N) };
    trB = { speed: lapTrace(s, lb, 'speed', N) };
    for (const ch in show) {
      if (show[ch] && ch !== 'speed' && !trA[ch]) { trA[ch] = lapTrace(s, la, ch, N); trB[ch] = lapTrace(s, lb, ch, N); }
    }
  }

  function render() {
    const s = curSession(), box = document.getElementById('content');
    if (!s) {
      box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`;
      return;
    }
    const a = s.analysis;
    if (a.full.length < 2) {
      box.innerHTML = `<div class="blank">这场只有 <b>${a.full.length}</b> 个完整圈，至少需要 2 圈才能对比。<br>
        <a href="laps.html">查看圈速</a></div>`;
      return;
    }
    // 从「极限圈速」页点「对比这两圈」过来的：直接选中指定的两圈（读完即清）
    const want = loadFocusCmp();
    if (want && lapByIdx(want.a) && lapByIdx(want.b) && want.a !== want.b && a.full.length > 1) { A = want.a; B = want.b; }
    if (A == null || !lapByIdx(A)) A = a.best ? a.best.index : a.full[0].index;
    if (B == null || !lapByIdx(B) || B === A) {
      // 默认从有效圈里挑（跳过自动排除的异常圈）
      const pool = a.full.filter(l => !l.abnormal && !(a.excluded || []).includes(l.index));
      const sorted = [...(pool.length ? pool : a.full)].sort((x, y) => x.time_s - y.time_s);
      B = (sorted.find(l => l.index !== A) || sorted[0]).index;
    }
    build();

    const ir = !!a.isIR;
    const la = lapByIdx(A), lb = lapByIdx(B);
    const diff = lb.time_s - la.time_s;
    const opts = a.full.map(l => `<option value="${l.index}" ${l.index === A ? 'selected' : ''}>#${l.index} · ${fmtTime(l.time_s, 3)}</option>`).join('');
    const opts2 = a.full.map(l => `<option value="${l.index}" ${l.index === B ? 'selected' : ''}>#${l.index} · ${fmtTime(l.time_s, 3)}</option>`).join('');
    const chBtns = Object.keys(show).filter(ch => ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer'))
      .map(ch => `<button class="pbtn ov ${show[ch] ? 'on' : ''}" data-ch="${ch}" style="--c:${CHANNELS[ch].color}">${CHANNELS[ch].name}</button>`).join('');

    box.innerHTML = `
      <div class="stats">
        <div class="statbox"><div class="v">${fmtTime(la.time_s, 3)}</div><div class="k">参考圈 #${A}</div></div>
        <div class="statbox"><div class="v">${fmtTime(lb.time_s, 3)}</div><div class="k">对比圈 #${B}</div></div>
        <div class="statbox"><div class="v ${deltaCls(diff)}">${deltaTxt(diff)}</div><div class="k">${diff > 0 ? '#' + B + ' 更慢' : diff < 0 ? '#' + B + ' 更快' : '持平'}</div></div>
        <div class="statbox"><div class="v ${deltaCls(lb.max_speed - la.max_speed)}">${(lb.max_speed - la.max_speed) >= 0 ? '+' : ''}${(lb.max_speed - la.max_speed).toFixed(1)}</div>
          <div class="k">极速差 km/h</div></div>
      </div>

      <div class="card">
        <h3>选择对比的两圈</h3>
        <div class="crow">
          <label class="clab">参考圈 <select id="selA" class="sbsel">${opts}</select></label>
          <label class="clab">对比圈 <select id="selB" class="sbsel">${opts2}</select></label>
          <button class="pbtn" id="swapBtn">⇄ 交换</button>
          <button class="pbtn" id="bestBtn">最快 vs 第二快</button>
        </div>
        <p class="chint">参考圈通常选你跑得最好的那一圈，对比圈选想找问题的那一圈。</p>
      </div>

      <div class="card">
        <h3>时间差 Delta <span class="cunit">曲线往上 = #${B} 丢时间，往下 = #${B} 捡时间</span></h3>
        <canvas id="cvDelta" class="chart"></canvas>
        <p class="chint">这是赛车遥测里最重要的一张图。纵轴是「#${B} 相对 #${A} 的累积时间差」，单位秒。
          曲线<b>陡然上升</b>的那一段就是 #${B} 丢时间最多的地方——去对照下面的油门/刹车图，通常能看到刹车太早、给油太晚或弯心速度不够。</p>
      </div>

      <div class="card">
        <h3>速度差 <span class="cunit">#${B} − #${A}</span></h3>
        <canvas id="cvSpd" class="chart"></canvas>
        <p class="chint">正值（绿）= #${B} 更快，负值（红）= #${B} 更慢。已做平滑，看趋势即可。</p>
      </div>

      <div class="card">
        <h3>通道对比 <span class="cunit">两条线叠加：蓝=#${A}，红=#${B}</span></h3>
        <div class="pcgroup" id="chBtns" style="margin-bottom:10px">${chBtns}</div>
        <div id="chArea" class="chgrid"></div>
        ${ir ? '' : '<p class="chint">VBO 数据没有踏板/档位/转向传感器，油门与刹车是由纵向 G 推导的（数值为 G，非开度%）。</p>'}
      </div>

      <div class="card">
        <h3>分段差异 <span class="cunit">每 5% 赛道进度一段</span></h3>
        ${zoneTable()}
      </div>

      <div class="card">
        <h3>关键指标对比</h3>
        ${metricTable(la, lb, ir)}
      </div>`;

    document.getElementById('selA').onchange = e => { A = +e.target.value; if (B === A) B = null; render(); };
    document.getElementById('selB').onchange = e => { B = +e.target.value; if (B === A) A = null; render(); };
    document.getElementById('swapBtn').onclick = () => { const t = A; A = B; B = t; render(); };
    document.getElementById('bestBtn').onclick = () => {
      const sorted = [...a.full].sort((x, y) => x.time_s - y.time_s);
      A = sorted[0].index; B = sorted[1] ? sorted[1].index : sorted[0].index; render();
    };
    const cb = document.getElementById('chBtns');
    if (cb) cb.onclick = e => {
      const b = e.target.closest ? e.target.closest('[data-ch]') : null; if (!b) return;
      const ch = b.dataset.ch; show[ch] = !show[ch]; b.classList.toggle('on', show[ch]);
      build(); renderChannels();
    };
    drawAll();
  }

  function zoneTable() {
    const rows = cmp.zones.map(z => `<tr>
      <td>${z.from.toFixed(0)}–${z.to.toFixed(0)}%</td>
      <td>${z.dAvg.toFixed(0)} m</td>
      <td class="${deltaCls(z.gain)}">${deltaTxt(z.gain)}</td>
      <td class="${deltaCls(z.spdAvg)}">${(z.spdAvg >= 0 ? '+' : '') + z.spdAvg.toFixed(1)}</td>
    </tr>`).join('');
    const lost = cmp.lost.slice(0, 3).map(z => `${z.from.toFixed(0)}–${z.to.toFixed(0)}%（${deltaTxt(z.gain)}）`).join('、') || '无';
    return `<table class="ctab">
      <thead><tr><th>区间</th><th>位置</th><th>时间差</th><th>平均速度差</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="chint"><b>#${B} 丢时间最多的三段：</b>${lost}</p>`;
  }

  function metricTable(la, lb, ir) {
    const m1 = la.metrics || {}, m2 = lb.metrics || {};
    const rows = [
      ['圈速', la.time_s.toFixed(3) + 's', lb.time_s.toFixed(3) + 's', lb.time_s - la.time_s, v => deltaTxt(v)],
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
    return `<table class="ctab"><thead><tr><th>指标</th><th>#${A}</th><th>#${B}</th><th>差异</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td>
        <td class="${r[3] === 0 ? 'd-zero' : deltaCls(r[3])}">${r[4](r[3])}</td></tr>`).join('')}</tbody></table>`;
  }

  /* ---------- 绘图 ---------- */
  function drawAll() { drawDelta(); drawSpd(); renderChannels(); }

  /* 注意：cfg 必须是「同一个持久对象」——bindTraceChart 会把 view / hoverIdx
     写回这个对象，onView 回调再原样重绘，缩放和悬停才会生效。
     如果每次 getCfg() 都新建一个对象，hover 状态会被丢掉。 */
  function drawDelta() {
    const cv = document.getElementById('cvDelta'); if (!cv || !cmp) return;
    const v = view('delta');
    const cfg = {
      height: 320, view: v, zeroLine: true,
      corners: curSession().analysis.corners, sectors: true,
      xLabels: cmp.dist, xFmt: t => Math.round(t) + 'm',
      series: [
        { name: '', data: cmp.delta.map(x => Math.max(0, x)), color: '#ff6b6b', fill: 'rgba(255,107,107,.25)', width: 0, legend: false },
        { name: '', data: cmp.delta.map(x => Math.min(0, x)), color: '#3fb950', fill: 'rgba(63,185,80,.25)', width: 0, legend: false },
        { name: '时间差 Delta (s)', color: '#e6edf3', data: cmp.delta, width: 1.9 }
      ],
      hoverIdx: v.hoverIdx,
      tip: i => [
        ['位置', cmp.dist[i].toFixed(0) + ' m', '#e6edf3'],
        ['进度', (i / N * 100).toFixed(1) + '%'],
        ['Delta', deltaTxt(cmp.delta[i]), cmp.delta[i] > 0 ? '#ff6b6b' : '#3fb950'],
        ['#' + A + ' 速度', trA.speed ? trA.speed[i].v.toFixed(1) + ' km/h' : '-'],
        ['#' + B + ' 速度', trB.speed ? trB.speed[i].v.toFixed(1) + ' km/h' : '-']
      ]
    };
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
      corners: curSession().analysis.corners, sectors: true,
      xLabels: cmp.dist, xFmt: t => Math.round(t) + 'm',
      series: [
        { name: '', data: cmp.spdDiff.map(x => Math.max(0, x)), color: '#3fb950', fill: 'rgba(63,185,80,.22)', width: 0, legend: false },
        { name: '', data: cmp.spdDiff.map(x => Math.min(0, x)), color: '#ff6b6b', fill: 'rgba(255,107,107,.22)', width: 0, legend: false },
        { name: '速度差 (km/h)', color: '#3b9eff', data: cmp.spdDiff, width: 1.8 }
      ],
      hoverIdx: v.hoverIdx,
      tip: i => [
        ['位置', cmp.dist[i].toFixed(0) + ' m', '#e6edf3'],
        ['速度差', (cmp.spdDiff[i] >= 0 ? '+' : '') + cmp.spdDiff[i].toFixed(1) + ' km/h',
        cmp.spdDiff[i] >= 0 ? '#3fb950' : '#ff6b6b'],
        ['#' + A, trA.speed ? trA.speed[i].v.toFixed(1) : '-'],
        ['#' + B, trB.speed ? trB.speed[i].v.toFixed(1) : '-']
      ]
    };
    drawTraces(cv, cfg);
    bindTraceChart(cv, () => cfg, () => drawTraces(cv, cfg));
    const h3 = cv.closest(".card") ? cv.closest(".card").querySelector("h3") : null;
    if (h3) chartTools(h3, cv, () => cfg, () => drawTraces(cv, cfg));
  }

  /* 每个通道一张图，两条线叠加（Garage61 风格） */
  function renderChannels() {
    const box = document.getElementById('chArea'); if (!box) return;
    const s = curSession(); if (!s) return;
    const ir = !!s.analysis.isIR;
    const chs = Object.keys(show).filter(ch => show[ch] && (ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer')));
    if (!chs.length) { box.innerHTML = '<p class="chint">勾选上方通道即可显示对比图。</p>'; return; }
    box.innerHTML = chs.map(ch => {
      const c = CHANNELS[ch];
      const unit = (!ir && (ch === 'thr' || ch === 'brk')) ? 'G' : c.unit;
      return `<div class="chcard">
        <div class="chart-head"><span class="cname" style="color:${c.color}">${c.name}</span>
          <span class="cunit">${unit}</span><span class="grow"></span>
          <span class="cunit">蓝 #${A} · 红 #${B}</span></div>
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
        height: 210, view: v, corners: s.analysis.corners, sectors: true,
        xLabels: trA[ch].map(p => p.d), xFmt: t => Math.round(t) + 'm',
        series: [
          { name: '#' + A, color: '#3b9eff', data: d1, width: 1.7 },
          { name: '#' + B, color: '#e10600', data: d2, width: 1.7 }
        ],
        hoverIdx: v.hoverIdx,
        tip: i => [
          ['位置', trA[ch][i].d.toFixed(0) + ' m', '#e6edf3'],
          ['#' + A, d1[i].toFixed(c.dec) + ' ' + unit, '#3b9eff'],
          ['#' + B, d2[i].toFixed(c.dec) + ' ' + unit, '#e10600'],
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

  document.addEventListener('DOMContentLoaded', () => bootPage('compare.html', () => { A = B = null; render(); }));
})();
