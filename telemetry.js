/* 遥测通道页（Garage61 风格）：速度 / 油门 / 刹车 / 转向 / 档位 / 转速 / 横向G / 纵向G
   每个通道单独一张图，X 轴统一用圈内距离，可叠加多圈对比，可缩放拖拽悬停读数 */
(function () {
  const N = 1000;
  let sel = [];                 // 选中的圈 index（可多选叠加）
  let show = { speed: true, thr: true, brk: true, steer: false, gear: false, rpm: false, latg: false, long: false };
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

    const chBtns = Object.keys(show).filter(ch => ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer'))
      .map(ch => `<button class="pbtn ov ${show[ch] ? 'on' : ''}" data-ch="${ch}" style="--c:${CHANNELS[ch].color}">${CHANNELS[ch].name}</button>`).join('');
    const chs = Object.keys(show).filter(ch => show[ch] && (ir || (ch !== 'gear' && ch !== 'rpm' && ch !== 'steer')));

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
      const cfg = {
        height: ch === 'speed' ? base + 50 : base,
        view: v, corners: s.analysis.corners,
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

  document.addEventListener('DOMContentLoaded', () => bootPage('telemetry.html', () => { sel = []; render(); }));
})();
