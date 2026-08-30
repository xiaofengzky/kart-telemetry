/* 遥测通道页（Garage61 风格）：速度 / 油门 / 刹车 / 转向 / 档位 / 转速 / 横向G / 纵向G
   每个通道单独一张图，X 轴统一用圈内距离，可叠加多圈对比，可缩放拖拽悬停读数 */
(function () {
  const N = 1000;
  let sel = [];                 // 选中的圈 index（可多选叠加）
  let show = { speed: true, thr: true, brk: true, steer: false, gear: false, rpm: false, latg: false, long: false, ref: true };
  let tr = {};                  // tr[ch][lapIdx] = trace
  const views = {};
  const view = k => (views[k] || (views[k] = { i0: 0, i1: N }));

  function build() {
    const s = curSession(); if (!s) return;
    tr = {};
    for (const ch in show) {
      if (!show[ch]) continue;
      tr[ch] = {};
      for (const li of sel) {
        const l = s.analysis.full.find(x => x.index === li);
        if (l) tr[ch][li] = lapTrace(s, l, ch, N);
      }
    }
  }

  function render() {
    const s = curSession(), box = document.getElementById('content');
    if (!s) { box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`; return; }
    const a = s.analysis, ir = !!a.isIR;
    if (!a.full.length) { box.innerHTML = `<div class="blank">这场没有识别到完整圈，无法做逐圈遥测分析。</div>`; return; }
    if (!sel.length || !sel.every(i => a.full.some(l => l.index === i))) sel = [a.best ? a.best.index : a.full[0].index];
    build();
    const tire = tireAnalysis(s);   // 无轮胎通道时返回 null（VBO / 旧版 iRacing 数据）

    const chBtns = Object.keys(show).filter(ch => ch !== 'ref' && (ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer')))
      .map(ch => `<button class="pbtn ov ${show[ch] ? 'on' : ''}" data-ch="${ch}" style="--c:${CHANNELS[ch].color}">${CHANNELS[ch].name}</button>`).join('')
      + `<button class="pbtn ov ${show.ref ? 'on' : ''}" data-ch="ref" style="--c:#e3a008" title="每个位置取你所有圈里速度最快那次的值（金色虚线）">✨ 自我基准参考</button>`;
    const chs = Object.keys(show).filter(ch => ch !== 'ref' && show[ch] && (ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer')));

    box.innerHTML = `
      <div class="card">
        <h3>选择要看的圈 <span class="cunit">可多选，同色对比</span></h3>
        <div id="lapBox" class="lapchips"></div>
        <div class="crow">
          <button class="pbtn" id="fastBtn">只看最快圈</button>
          <button class="pbtn" id="allBtn">全选</button>
          <span class="clab">图高
            <select id="hSel" class="sbsel" style="min-width:110px">
              <option value="190">紧凑</option><option value="230" selected>标准</option><option value="320">加长</option>
            </select></span>
        </div>
      </div>

      <div class="card">
        <h3>显示哪些通道</h3>
        <div class="pcgroup" id="chBtns">${chBtns}</div>
        ${ir ? '' : '<p class="chint">VBO 数据没有踏板 / 档位 / 转向传感器，油门与刹车由纵向 G 推导（数值为 G，非开度%），已自动隐藏其它不可用通道。</p>'}
      </div>

      <div id="chArea" class="chgrid"></div>

      <div class="card">
        <h3>🔥 轮胎与刹车 <span class="cunit">${tire ? '胎温 · 内外温差 · ABS · 磨损' : '仅 iRacing 有这些通道'}</span></h3>
        ${tireCard(s)}
      </div>

      <div class="card">
        <h3>怎么看</h3>
        <p class="chint">
          X 轴是<b>圈内距离（米）</b>，所有圈按赛道进度对齐，所以不同圈可以直接叠在一起看。<br>
          · <b>油门</b>：出弯给油越早越平滑越快；曲线突然掉下去说明弯中在收油（速度损失）。<br>
          · <b>刹车</b>：峰值越高越晚刹；松刹车的过程越平滑，说明 trail braking 用得好。<br>
          · <b>速度</b>：弯心最低速是关键指标，比入弯速度更能反映走线质量。<br>
          · <b>转向</b>：抖动多说明在修方向，平滑才是快。<br><br>
          想看两圈之间的<b>时间差</b>，去 <a href="compare.html" style="color:var(--blue)">多圈对比</a> 看 Delta 曲线。
        </p>
      </div>`;

    renderLapChips(document.getElementById('lapBox'), a.full, sel, toggleLap, false);
    document.getElementById('fastBtn').onclick = () => { sel = [a.best ? a.best.index : a.full[0].index]; render(); };
    document.getElementById('allBtn').onclick = () => { sel = a.full.map(l => l.index); render(); };
    const cb = document.getElementById('chBtns');
    if (cb) cb.onclick = e => {
      const b = e.target.closest ? e.target.closest('[data-ch]') : null; if (!b) return;
      const ch = b.dataset.ch; show[ch] = !show[ch]; b.classList.toggle('on', show[ch]); render();
    };
    drawAll(chs);
    /* 轮胎趋势图放在所有通道图之后画：canvas 是 CSS width:100%，
       先画再让 #chArea 填充内容会触发重新布局，浏览器重置 canvas 位图导致画好的线被清空。 */
    const ttCv = document.getElementById('tireTrend');
    if (ttCv && tire && tire.laps.length > 1) drawTireTrend(ttCv, tire);
  }

  function toggleLap(i) {
    const k = sel.indexOf(i);
    if (k >= 0) { if (sel.length > 1) sel.splice(k, 1); }
    else sel.push(i);
    render();
  }

  function drawAll(chs) {
    const s = curSession(); if (!s) return;
    const ir = !!s.analysis.isIR;
    const hSel = document.getElementById('hSel');
    const base = hSel ? +hSel.value : 230;
    const area = document.getElementById('chArea');
    if (!area) return;
    if (!chs.length) { area.innerHTML = '<div class="card"><p class="chint">勾选上方通道即可显示曲线。</p></div>'; return; }

    area.innerHTML = chs.map(ch => {
      const c = CHANNELS[ch];
      const unit = (!ir && (ch === 'thr' || ch === 'brk')) ? 'G' : c.unit;
      return `<div class="card chcard">
        <div class="chart-head"><span class="cname" style="color:${c.color}">${c.name}</span>
          <span class="cunit">${unit}</span><span class="grow"></span>
          <span class="cunit">${sel.map((li, k) => `<i style="color:${cmpColor(li)};font-style:normal">■</i> #${li}`).join('  ')}</span></div>
        <canvas id="ch_${ch}" class="chart"></canvas>
      </div>`;
    }).join('');
    if (hSel) hSel.onchange = () => render();

    for (const ch of chs) {
      const cv = document.getElementById('ch_' + ch); if (!cv) continue;
      const c = CHANNELS[ch];
      const unit = (!ir && (ch === 'thr' || ch === 'brk')) ? 'G' : c.unit;
      const v = view('ch_' + ch);
      const series = sel.map(li => ({
        name: '#' + li, color: cmpColor(li), data: (tr[ch][li] || []).map(p => p.v),
        width: sel.length > 6 ? 1.2 : 1.8,
        fill: sel.length === 1 ? hexA(c.color, .16) : null,
        forceZero: ch === 'thr' || ch === 'brk' || ch === 'speed' || ch === 'latg'
      })).filter(s2 => s2.data && s2.data.length);
      // 自我基准参考线：每个位置取选中圈里「速度最快」那圈的本通道值（金色虚线）
      if (show.ref) {
        const ref = bestRef(ch);
        if (ref) series.push({ name: '✨参考', color: '#e3a008', data: ref, width: 1.5, dash: [6, 4] });
      }
      const cfg = {
        height: ch === 'speed' ? base + 50 : base,
        view: v, corners: s.analysis.corners, sectors: true,
        xLabels: (tr[ch][sel[0]] || []).map(p => p.d), xFmt: t => Math.round(t) + 'm',
        series,
        hoverIdx: v.hoverIdx,
        tip: i => {
          const rows = [['位置', ((tr[ch][sel[0]] || [])[i] ? tr[ch][sel[0]][i].d.toFixed(0) : '-') + ' m', '#e6edf3']];
          for (const li of sel) {
            const t = tr[ch][li];
            if (t && t[i]) rows.push(['#' + li, t[i].v.toFixed(c.dec) + ' ' + unit, cmpColor(li)]);
          }
          if (sel.length === 2) {
            const d = (tr[ch][sel[1]][i].v - tr[ch][sel[0]][i].v);
            rows.push(['差值', (d >= 0 ? '+' : '') + d.toFixed(c.dec), d >= 0 ? '#3fb950' : '#ff6b6b']);
          }
          return rows;
        }
      };
      drawTraces(cv, cfg);
      bindTraceChart(cv, () => cfg, () => drawTraces(cv, cfg));
      const head = cv.closest('.chcard') ? cv.closest('.chcard').querySelector('.chart-head') : null;
      if (head) chartTools(head, cv, () => cfg, () => drawTraces(cv, cfg));
    }
  }
  /* #rrggbb + alpha → rgba() */
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ---------- 轮胎与刹车面板 ---------- */
  function tireCard(s) {
    const t = tireAnalysis(s);
    if (!t) {
      /* 区分三种情况，别一股脑都甩一句"没有通道"：
         ① 卡丁车 VBO —— 物理上没有胎温传感器
         ② 旧版本上传的 iRacing —— points 里没存 tt，原文件也不在库里，只能重传
         ③ 真的解析到了但车没这些通道 */
      if (tireNeedsReupload(s)) {
        return `<div class="diag warn">这场是<b>旧版本上传的</b>，当时没保存轮胎/ABS 通道。<br>
          重新上传一次原 .ibt 文件就能看到这块（会作为新会话追加，已有的圈速数据不受影响）。</div>`;
      }
      return `<p class="chint">这份数据没有轮胎/ABS 通道——卡丁车 VBO 文件物理上没有胎温、轮速传感器；
        iRacing 的 .ibt 才有。想要这块分析，去跑一场 iRacing 再导出遥测。</p>`;
    }
    const rows = t.wheels.map(w => `<tr>
      <td><b>${w.name}</b></td>
      <td>${w.avg}°C</td>
      <td class="${w.peak > t.TIRE_HOT + 25 ? 'd-pos' : ''}">${w.peak}°C</td>
      <td>${w.outer}°C</td>
      <td>${w.inner}°C</td>
      <td class="${Math.abs(w.delta) >= 12 ? 'd-pos' : ''}">${w.delta > 0 ? '+' : ''}${w.delta}°C</td>
    </tr>`).join('');
    const hot = t.abs.hotspots.length
      ? t.abs.hotspots.map(h => `${h.pct}–${h.pct + 5}%${h.cornerId != null ? '（T' + h.cornerId + '）' : ''}`).join('、') : '—';
    const wearRows = t.wear.usable ? t.wear.perLap.slice(0, 12).map(w =>
      `<tr><td>#${w.lap}</td><td>${w.mid.toFixed(2)}</td><td>${w.outer.toFixed(2)}</td><td>${w.inner.toFixed(2)}</td></tr>`).join('') : '';
    const settledTxt = t.settled
      ? `已稳定在 <b>${t.plateauTemp}°C</b>`
      : `还在爬坡（有效圈前段→后段 <b>${t.climb > 0 ? '+' : ''}${t.climb}°C</b>，当前 ${t.plateauTemp}°C）`;
    return `<div class="evwrap">
      <div class="evcol">
        <h4>四轮胎温 <span style="font-weight:400;color:var(--mut)">${t.srcLabel} · 只算有效圈</span></h4>
        <table class="ctab"><thead><tr><th>轮</th><th>平均</th><th>峰温</th><th>外侧</th><th>内侧</th><th>外−内</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <p class="chint">窗口约 ${t.TIRE_WARM}–${t.TIRE_HOT}°C，${settledTxt}。<br>
          「外−内」用的是<b>${t.geoLabel}</b>三层：为正=外侧更热（外倾不足或胎压低）；为负=内侧更热（外倾偏大或胎压高）。</p>
      </div>
      <div class="evcol">
        <h4>ABS 与滑移</h4>
        <table class="ctab"><tbody>
          <tr><td>ABS 触发占刹车时间</td><td class="${t.abs.brakePct > 60 ? 'd-pos' : ''}"><b>${t.abs.brakePct}%</b></td></tr>
          <tr><td>刹车时平均滑移</td><td class="${t.abs.avgSlip > 8 ? 'd-pos' : ''}"><b>${t.abs.avgSlip}%</b></td></tr>
          <tr><td>峰值滑移</td><td><b>${t.abs.maxSlip}%</b></td></tr>
          <tr><td>锁死次数</td><td class="${t.abs.lockCount > 0 ? 'd-pos' : ''}"><b>${t.abs.lockCount}</b></td></tr>
          <tr><td>触发最频繁的弯</td><td><b>${hot}</b></td></tr>
        </tbody></table>
        <p class="chint">GT3 重刹时 ABS 触发属正常；<b>占比过高</b>或<b>出现锁死</b>才说明刹车踩过头（轮胎在打滑边界）。</p>
      </div>
    </div>
    ${t.laps.length > 1 ? `<h4 style="margin:14px 0 6px;font-size:12px">长距离胎温趋势（每圈平均，虚线为非有效圈）</h4>
      <canvas id="tireTrend" class="chart"></canvas>` : ''}
    ${wearRows ? `<h4 style="margin:14px 0 6px;font-size:12px">磨损（每圈掉几个百分点）</h4>
      <table class="ctab"><thead><tr><th>圈</th><th>中层</th><th>外侧</th><th>内侧</th></tr></thead><tbody>${wearRows}</tbody></table>
      <p class="chint">全程累计 <b>${t.wear.total.toFixed(2)}</b> 个百分点，内外磨损差 <b>${Math.abs(t.wear.outerInner).toFixed(2)}</b>（${t.wear.outerInner > 0 ? '外侧多' : '内侧多'}）。</p>`
      : `<p class="chint" style="margin-top:10px">这场<b>没有磨损变化</b>——iRacing 在练习/测试节不模拟轮胎损耗，磨损通道全程是固定值。想看长距离衰减，得跑一场有胎耗的比赛。</p>`}
    <div style="margin-top:10px">${t.verdicts.map(v => `<div class="diag ${v.t}" style="margin-bottom:6px">${v.txt}</div>`).join('')}</div>`;
  }

  /* 长距离胎温 + ABS 趋势（逐圈） */
  function drawTireTrend(cv, t) {
    const laps = t.laps.slice(-30);
    const cfg = {
      height: 220,
      xLabels: laps.map(l => l.lap), xFmt: v => '#' + v,
      series: [
        { name: '胎温 °C', color: '#e3a008', data: laps.map(l => l.temp), width: 2 },
        { name: 'ABS 触发 %', color: '#e10600', data: laps.map(l => l.absPct), width: 1.4 }
      ],
      tip: i => [
        ['圈', '#' + laps[i].lap + (laps[i].fly ? '' : '（非有效圈）')],
        ['平均胎温', laps[i].temp != null ? laps[i].temp.toFixed(1) + ' °C' : '-', '#e3a008'],
        ['ABS', laps[i].absPct.toFixed(1) + '%', '#e10600'],
        ['峰值滑移', laps[i].maxSlip.toFixed(1) + '%']
      ]
    };
    drawTraces(cv, cfg);
    bindTraceChart(cv, () => cfg, () => drawTraces(cv, cfg));
  }

  /* 自我基准参考线：对每个位置（进度%），找选中圈中速度最快的那圈，取其指定通道的值。
     速度通道 = 每个位置你跑出的最高速度；油门/刹车 = 那一次对应位置的表现。
     这样"参考线"= 你曾经做到过的最优表现，作为改进方向。 */
  function bestRef(ch) {
    const s = curSession(); if (!s || !sel.length) return null;
    const laps = sel.map(i => s.analysis.full.find(l => l.index === i)).filter(Boolean);
    if (!laps.length) return null;
    const N = 1000;
    const spd = laps.map(l => lapTrace(s, l, 'speed', N));
    const tr = ch === 'speed' ? spd : laps.map(l => lapTrace(s, l, ch, N));
    const out = [];
    for (let k = 0; k <= N; k++) {
      let bi = 0;
      for (let i = 1; i < spd.length; i++) if (spd[i][k].v > spd[bi][k].v) bi = i;
      out.push(tr[bi][k].v);
    }
    return out;
  }

  document.addEventListener('DOMContentLoaded', () => bootPage('telemetry.html', () => { sel = []; render(); }));
})();
