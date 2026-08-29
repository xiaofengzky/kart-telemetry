/* 极限圈速页（Optimal Lap）：把赛道切成 N 段，每段取所有圈里最快的那次耗时拼起来
   —— 得到「理论最快圈」，并指出每段还能捡多少时间、该向哪一圈学 */
(function () {
  let use = null;          // 参与计算的圈 index 数组；null = 全部
  let segCount = 50;
  let idl = null;

  function sectorTable() {
    const s = curSession(); if (!s || !idl) return '<p class="chint">暂无可计算的数据</p>';
    const a = s.analysis;
    const bestLap = a.best;
    const bl = bestLap && bestLap.sector_times ? bestLap.sector_times : [0, 0, 0];
    const third = idl.segCount / 3;
    const rows = [0, 1, 2].map(k => {
      const segs = idl.segs.filter(x => x.seg >= k * third && x.seg < (k + 1) * third);
      const opt = segs.reduce((t, x) => t + x.time, 0);
      const gain = Math.max(0, bl[k] - opt);
      const act = bl[k] || opt;
      return `<tr><td><b>S${k + 1}</b></td><td>${opt.toFixed(3)}s</td><td>${act.toFixed(3)}s</td>
        <td class="${deltaCls(gain)}">−${gain.toFixed(3)}s</td>
        <td>${(gain / Math.max(0.0001, idl.gain) * 100).toFixed(0)}%</td></tr>`;
    }).join('');
    return `<table class="ctab"><thead><tr><th>赛段</th><th>最优段组合</th><th>最快圈实际</th><th>可捡</th><th>占可捡总量</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  function render() {
    const s = curSession(), box = document.getElementById('content');
    if (!s) { box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`; return; }
    const a = s.analysis;
    if (a.full.length < 2) {
      box.innerHTML = `<div class="blank">这场只有 <b>${a.full.length}</b> 个完整圈。<br>
        极限圈速需要 2 圈以上才能拼出有意义的理论最快圈。</div>`; return;
    }
    if (!use) use = a.full.map(l => l.index);
    // 过滤掉已被删除/不存在的圈
    use = use.filter(i => a.full.some(l => l.index === i));
    if (!use.length) use = a.full.map(l => l.index);

    const laps = a.full.filter(l => use.includes(l.index));
    idl = idealLap(s, segCount, laps);

    const median = [...a.full].map(l => l.time_s).sort((x, y) => x - y)[a.full.length >> 1];
    const hasSuspect = laps.some(l => l.time_s > median * 1.06);
    const maxGain = Math.max(...idl.segs.map(x => x.gain), 0.0001);

    box.innerHTML = `
      ${hasSuspect ? `<div class="notice">⚠ 参与计算的圈里有的比中位圈慢 6% 以上（带 <b>⚠</b> 标记），
        多半是<b>出场圈/进站圈/失误圈</b>。它们的「快段」往往是出弯全油门直路，会把极限圈速算得过于乐观。
        建议<b>取消勾选</b>这些圈再看。</div>` : ''}

      <div class="stats">
        <div class="statbox"><div class="v" style="color:var(--amber)">${idl.idealTime.toFixed(3)}s</div>
          <div class="k">极限圈速（理论最快）</div><div class="sub">${segCount} 段各取最快拼接</div></div>
        <div class="statbox"><div class="v">${idl.bestTime.toFixed(3)}s</div>
          <div class="k">实际最快圈</div><div class="sub">#${idl.perLap.reduce((m, p) => p.time_s < m.time_s ? p : m).lap}</div></div>
        <div class="statbox"><div class="v d-pos">−${idl.gain.toFixed(3)}s</div>
          <div class="k">理论可捡时间</div><div class="sub">${(idl.gain / idl.bestTime * 100).toFixed(2)}% 提升空间</div></div>
        <div class="statbox"><div class="v">${laps.length}/${a.full.length}</div>
          <div class="k">参与计算的圈</div><div class="sub">点下方色块开关</div></div>
      </div>

      <div class="card">
        <h3>参与计算的圈</h3>
        <div id="lapBox" class="lapchips"></div>
        <div class="crow">
          <span class="clab">分段数
            <select id="segSel" class="sbsel" style="min-width:120px">
              ${[25, 50, 100, 200].map(n => `<option value="${n}" ${n === segCount ? 'selected' : ''}>${n} 段</option>`).join('')}
            </select></span>
          <button class="pbtn" id="allBtn">全选</button>
          <button class="pbtn" id="cleanBtn">只留正常圈</button>
        </div>
        <p class="chint">分段越细，理论极限越快（每段都取到极致），但可操作性越低。<b>50 段</b>是常用的平衡点。</p>
      </div>

      <div class="card">
        <h3>赛段最快 <span class="cunit">F1 风格 S1/S2/S3（赛道三等分）</span></h3>
        ${sectorTable()}
        <p class="chint">「最优段组合」= 该赛段内每小段取你所有圈的最快值拼起来；「最快圈实际」= 你实际最快圈在这个赛段花了多少。
          中间的差距就是这个赛段理论上还能捡的时间。捡得最多的赛段，就是你最该集中练的地方。</p>
      </div>

      <div class="card">
        <h3>哪些段最能捡时间 <span class="cunit">相对实际最快圈，红色越长=越值得练</span></h3>
        <div class="chint" style="margin-bottom:8px">下面是可捡时间最多的 ${Math.min(12, idl.segs.length)} 段。点开看这些段属于赛道的哪个位置，去针对性练。</div>
        ${idl.top.slice(0, 12).map(sg => `
          <div class="segrow">
            <span class="segno">${sg.from.toFixed(0)}–${sg.to.toFixed(0)}%</span>
            <span class="segbar"><span class="segfill" style="width:${(sg.gain / maxGain * 100).toFixed(1)}%"></span></span>
            <span class="segval d-pos">−${sg.gain.toFixed(3)}s</span>
            <span class="seglap">#${sg.lap}</span>
          </div>`).join('')}
        <p class="chint" style="margin-top:10px">最右一列是「这一段的最快成绩来自第几圈」——去那一圈看看那一段是怎么跑的。</p>
      </div>

      <div class="card">
        <h3>每一圈的分段表现 <span class="cunit">绿色=该圈在这个分段全场最快</span></h3>
        <div class="tscroll">${lapMatrix()}</div>
      </div>

      <div class="card">
        <h3>怎么看这个数</h3>
        <p class="chint">
          极限圈速是<b>把每一段单独拿出来取你跑过的最快值再拼起来</b>，所以它一定比实际最快圈快。
          但各段来自不同圈，<b>物理上未必能连着跑出来</b>（比如某段你全油门冲过去，结果下一段入弯速度过高）。<br><br>
          正确用法：<br>
          ① 看<b>可捡时间</b>有多大——如果只有零点几秒，说明你的一致性已经很好，该换练别的；<br>
          ② 看<b>哪几段最值得捡</b>——集中练那几段，别贪多；<br>
          ③ 看<b>最快段来自哪圈</b>——去那一圈复现那段操作。<br><br>
          想看具体某一圈跟另一圈的差距，去 <a href="compare.html" style="color:var(--blue)">多圈对比</a> 看 Delta 曲线。
        </p>
      </div>`;

    renderLapChips(document.getElementById('lapBox'), a.full, use, toggleLap, true);
    document.getElementById('segSel').onchange = e => { segCount = +e.target.value; render(); };
    document.getElementById('allBtn').onclick = () => { use = a.full.map(l => l.index); render(); };
    document.getElementById('cleanBtn').onclick = () => {
      use = a.full.filter(l => l.time_s <= median * 1.06).map(l => l.index);
      if (!use.length) use = a.full.map(l => l.index);
      render();
    };
  }

  function toggleLap(i) {
    if (!use) return;
    const k = use.indexOf(i);
    if (k >= 0) { if (use.length > 1) use.splice(k, 1); }   // 至少留一圈
    else use.push(i);
    render();
  }

  /* 每圈 × 每段的耗时矩阵（每行一圈，绿色格=该段全场最快） */
  function lapMatrix() {
    const s = curSession(), a = s.analysis;
    const laps = a.full.filter(l => use.includes(l.index));
    if (!idl || laps.length > 14) {
      return `<table class="ctab"><thead><tr><th>圈</th><th>圈速</th><th>最快段数</th><th>最快段占比</th></tr></thead><tbody>
        ${laps.map(l => {
        const mine = idl.segs.filter(sg => sg.lap === l.index).length;
        return `<tr><td>#${l.index}</td><td>${l.time_s.toFixed(3)}s</td><td>${mine}</td>
            <td>${(mine / segCount * 100).toFixed(0)}%</td></tr>`;
      }).join('')}</tbody></table>
        <p class="chint">圈数较多时只显示汇总，避免表格过宽。</p>`;
    }
    const step = Math.max(1, Math.ceil(segCount / 40));   // 最多 40 列，避免太宽
    let cols = [];
    for (let k = 0; k < segCount; k += step) cols.push(k);
    // 每段最快来自哪圈
    const winner = {};
    idl.segs.forEach(sg => { winner[sg.seg] = sg.lap; });
    const head = cols.map(k => `<th title="${(k / segCount * 100).toFixed(0)}%">${(k / segCount * 100).toFixed(0)}</th>`).join('');
    const body = laps.map(l => {
      const pl = idl.perLap.find(p => p.lap === l.index);
      const tds = cols.map(k => {
        let t = 0; for (let j = k; j < Math.min(k + step, segCount); j++) t += pl.times[j];
        const isBest = winner[k] === l.index;
        return `<td class="${isBest ? 'best' : ''}" title="#${l.index} ${(k / segCount * 100).toFixed(0)}% 段 ${t.toFixed(3)}s">${t.toFixed(2)}</td>`;
      }).join('');
      const mine = idl.segs.filter(sg => sg.lap === l.index).length;
      return `<tr><td class="lapno">#${l.index}</td><td class="lapt">${l.time_s.toFixed(3)}s</td>${tds}
        <td class="mine">${mine}</td></tr>`;
    }).join('');
    return `<table class="ctab mtx"><thead><tr><th>圈</th><th>圈速</th>${head}<th>最快段</th></tr></thead><tbody>${body}</tbody></table>
      <p class="chint">数字是该段的耗时（秒），<b style="color:#3fb950">绿色格</b>表示这一段你在这一圈跑得最快。</p>`;
  }

  document.addEventListener('DOMContentLoaded', () => bootPage('ideal.html', () => { use = null; render(); }));
})();
