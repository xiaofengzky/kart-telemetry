/* 圈速页：圈列表 / 一致性 / 分段 / 波动区 / 刹车点一致性 / 刹车油门事件 */
(function () {
  let selLapIdx = null;     // 事件表当前选中的圈

  function render() {
    const s = curSession(), box = document.getElementById('content');
    if (!s) { box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`; return; }
    const a = s.analysis, ir = !!a.isIR;
    if (!a.full.length) { box.innerHTML = `<div class="blank">这场没有识别到完整圈。</div>`; return; }
    if (selLapIdx == null || !a.full.some(l => l.index === selLapIdx)) selLapIdx = a.best ? a.best.index : a.full[0].index;

    const fastest = a.best_time;
    const excl = a.excluded || [];
    const sorted = [...a.full].sort((x, y) => x.time_s - y.time_s);
    const median = sorted[sorted.length >> 1].time_s;
    const notice = [];
    if (a.junkCount > 0) notice.push(`已自动丢弃 <b>${a.junkCount}</b> 个无效段（里程不足中位圈一半，起终点附近停车/蹭线/断数据，不算圈）`);
    const abn = a.full.filter(l => l.abnormal);
    if (abn.length) notice.push(`已自动排除 <b>${abn.length}</b> 个异常圈（比中位慢 8% 以上，多半是暖胎圈/出场圈/失误圈），统计里不再算它们——下方 🗑/↺ 可手动调整`);
    if (excl.length) notice.push(`你手动排除了 <b>${excl.length}</b> 圈（点 ↺ 可恢复）`);

    box.innerHTML = `
      ${notice.length ? `<div class="notice">${notice.join('；')}。</div>` : ''}
      <div class="stats">
        <div class="statbox"><div class="v">${a.validCount}/${a.full.length}</div><div class="k">有效圈/识别圈</div>
          <div class="sub">异常与手动排除的不计入</div></div>
        <div class="statbox"><div class="v">${a.best_time != null ? fmtTime(a.best_time, 3) : '-'}</div>
          <div class="k">最快圈 <span style="color:var(--mut)">#${a.best ? a.best.index : '-'}</span></div></div>
        <div class="statbox"><div class="v">${fmtTime(a.core_avg, 3)}</div><div class="k">核心均速</div>
          <div class="sub">去掉最快最慢后的平均</div></div>
        <div class="statbox"><div class="v" style="color:${a.gradeCol}">${a.grade}</div><div class="k">一致性</div>
          <div class="sub">标准差 ±${a.core_std}s</div></div>
        <div class="statbox"><div class="v">${a.vmax.toFixed(0)}</div><div class="k">极速 km/h</div></div>
      </div>

      <div class="card">
        <h3>每一圈 <span class="cunit">🗑=手动排除（不参与任何统计） · 灰色=已排除</span></h3>
        <div class="tscroll"><table class="ctab">
          <thead><tr><th>圈</th><th>圈速</th><th>差距</th><th>S1</th><th>S2</th><th>S3</th>
            <th>极速</th><th>最低速</th><th>刹车点</th><th>全油门</th><th>峰值减速</th><th>G-Sum</th><th></th></tr></thead>
          <tbody>${sorted.map(l => {
      const m = l.metrics || {};
      const d = l.time_s - (fastest != null ? fastest : l.time_s);
      const isEx = excl.includes(l.index);
      const st = l.sector_times || [0, 0, 0];
      const cls = [l.index === (a.best ? a.best.index : -1) ? 'best' : '', l.abnormal ? 'abn' : '', isEx ? 'exd' : ''].join(' ');
      const mark = l.abnormal
        ? `<span title="异常圈：比中位慢 ${l.abnormalPct != null ? l.abnormalPct.toFixed(0) : '?'}%，已自动排除（暖胎/出场圈？）" style="color:var(--amber)">⚠</span>`
        : (isEx ? '<span title="手动排除" style="color:var(--mut)">✕</span>' : '');
      return `<tr class="${cls}">
              <td><b>#${l.index}</b> ${mark}</td>
              <td>${fmtTime(l.time_s, 3)}</td>
              <td class="${deltaCls(d)}">${d < 0.0005 ? '最快' : deltaTxt(d)}</td>
              <td>${fmtTime(st[0], 2)}</td><td>${fmtTime(st[1], 2)}</td><td>${fmtTime(st[2], 2)}</td>
              <td>${l.max_speed.toFixed(1)}</td>
              <td>${m.minSpeed != null ? m.minSpeed.toFixed(1) : '-'}</td>
              <td>${m.brakeCount != null ? m.brakeCount : '-'}</td>
              <td>${m.flatout_pct != null ? m.flatout_pct + '%' : '-'}</td>
              <td>${m.peakBrakeG != null ? m.peakBrakeG + (ir ? '%' : 'G') : '-'}</td>
              <td>${m.gsumPeak != null ? m.gsumPeak : '-'}</td>
              <td><button class="exbtn" data-lap="${l.index}" title="${isEx ? '恢复这圈参与统计' : '手动排除这圈（不算进任何统计）'}">${isEx ? '↺' : '🗑'}</button></td>
            </tr>`;
    }).join('')}</tbody></table></div>
        <p class="chint"><b style="color:var(--amber)">⚠</b> = 自动检测出的异常圈（比中位慢 8% 以上，多半是暖胎圈/出场圈/失误圈），已默认排除出所有统计；
          <b style="color:var(--mut)">✕</b> = 你手动排除的圈。都可用 <b>↺</b> 恢复。<b>S1/S2/S3</b> 是 F1 风格三段赛段时间。</p>
      </div>

      ${a.sectors && a.sectors.length ? `
      <div class="card">
        <h3>分段表现 <span class="cunit">F1 风格三段赛段</span></h3>
        <table class="ctab"><thead><tr><th>赛段</th><th>平均</th><th>最快</th><th>波动 ±</th></tr></thead>
          <tbody>${a.sectors.map(s2 => `<tr>
            <td><b>${s2.name || ('S' + s2.sector)}</b></td><td>${fmtTime(s2.mean_s, 3)}</td><td>${fmtTime(s2.best_s, 3)}</td>
            <td class="${s2.std_s > 0.5 ? 'd-pos' : 'd-zero'}">±${s2.std_s}s</td></tr>`).join('')}</tbody></table>
        <p class="chint">波动大的赛段说明这一段你的跑法不稳定，是最该固定下来的地方。想具体看 S1/S2/S3 里哪个弯慢，去 <a href="compare.html" style="color:var(--blue)">多圈对比</a> 或 <a href="telemetry.html" style="color:var(--blue)">遥测通道</a>（图上已标出 S1/S2/S3 分区）。</p>
      </div>` : ''}

      ${a.worstZones && a.worstZones.length ? `
      <div class="card">
        <h3>速度波动最大的位置</h3>
        <table class="ctab"><thead><tr><th>赛道位置</th><th>平均速度</th><th>圈间波动</th></tr></thead>
          <tbody>${a.worstZones.map(z => `<tr><td>${z.progress_pct}%</td><td>${z.mean_speed} km/h</td>
            <td class="d-pos">±${z.std} km/h</td></tr>`).join('')}</tbody></table>
        <p class="chint">这些位置你每圈的速度差别最大，通常是刹车点或走线没固定。<a href="compare.html" style="color:var(--blue)">去多圈对比</a>看具体差在哪。</p>
      </div>` : ''}

      ${a.brakeConsistency && a.brakeConsistency.length ? `
      <div class="card">
        <h3>刹车点一致性 <span class="cunit">以最快圈的刹车点为基准</span></h3>
        <table class="ctab"><thead><tr><th>刹车点位置</th><th>圈间位置波动</th><th>峰值</th></tr></thead>
          <tbody>${a.brakeConsistency.map(b => `<tr><td>${b.progress}%</td>
            <td class="${b.std > 2 ? 'd-pos' : 'd-neg'}">±${b.std}%</td>
            <td>${b.peakG}${ir ? '%' : 'G'}</td></tr>`).join('')}</tbody></table>
        <p class="chint">波动最大的那个刹车点，是你最该先固定下来的——每次都在同一位置刹车，圈速自然稳。</p>
      </div>` : ''}

      <div class="card">
        <h3>刹车 / 油门事件
          <select id="evSel" class="sbsel" style="min-width:150px;margin-left:8px">
            ${sorted.map(l => `<option value="${l.index}" ${l.index === selLapIdx ? 'selected' : ''}>#${l.index} · ${fmtTime(l.time_s, 2)}</option>`).join('')}
          </select>
        </h3>
        ${eventTable(ir)}
      </div>`;

    const es = document.getElementById('evSel');
    if (es) es.onchange = e => { selLapIdx = +e.target.value; render(); };
    /* 手动排除 / 恢复某圈：改 session 的 excluded → 重新 analyze → 保存 IndexedDB */
    document.querySelectorAll('#content .exbtn').forEach(btn => {
      btn.onclick = () => {
        const i = +btn.dataset.lap;
        const ex = s.excluded || (s.excluded = []);
        const k = ex.indexOf(i);
        if (k >= 0) ex.splice(k, 1); else ex.push(i);
        s.analysis = analyze(s.points, ex);
        dbSave(s);
        render();
      };
    });
  }

  function eventTable(ir) {
    const s = curSession(); const l = s.analysis.full.find(x => x.index === selLapIdx);
    if (!l) return '<p class="chint">无数据</p>';
    const bk = l.brakeEvents || [], th = l.throttleEvents || [];
    const unit = ir ? '%' : 'G';
    const bRow = bk.length ? bk.map(e => `<tr><td>${e.progress}%</td><td>${e.peakG}${unit}</td>
      <td>${e.dist_m} m</td><td>${e.entrySpeed} → ${e.minSpeed}</td></tr>`).join('')
      : '<tr><td colspan="4" style="color:var(--mut)">未识别到刹车事件</td></tr>';
    const tRow = th.length ? th.map(e => `<tr><td>${e.progress}%</td><td>${e.peakG}${unit}</td>
      <td>${e.dist_m} m</td><td>${e.startSpeed} → ${e.endSpeed != null ? e.endSpeed : '-'}</td></tr>`).join('')
      : '<tr><td colspan="4" style="color:var(--mut)">未识别到油门事件</td></tr>';
    return `<div class="evwrap">
      <div class="evcol"><h4>刹车点</h4><table class="ctab">
        <thead><tr><th>位置</th><th>峰值</th><th>距离</th><th>速度变化</th></tr></thead>
        <tbody>${bRow}</tbody></table></div>
      <div class="evcol"><h4>油门点</h4><table class="ctab">
        <thead><tr><th>位置</th><th>峰值</th><th>距离</th><th>速度变化</th></tr></thead>
        <tbody>${tRow}</tbody></table></div>
    </div>`;
  }

  document.addEventListener('DOMContentLoaded', () => bootPage('laps.html', () => { selLapIdx = null; render(); }));
})();
