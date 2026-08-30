/* 极限圈速页（Optimal Lap）：把赛道切成 N 段，每段取所有圈里最快的那次耗时拼起来
   —— 得到「理论最快圈」，并指出每段还能捡多少时间、该向哪一圈学 */
(function () {
  let use = null;          // 参与计算的圈 index 数组；null = 全部
  let segCount = 50;
  let idl = null;
  let focusSeg = null;     // 当前展开查看的段 index（点行/点图都会设置）

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
      const span = sectorSpan(s, k / 3 * 100, (k + 1) / 3 * 100);
      return `<tr><td><b>S${k + 1}</b></td><td class="loc">${span}</td><td>${fmtTime(opt, 3)}</td><td>${fmtTime(act, 3)}</td>
        <td class="${deltaCls(gain)}">−${gain.toFixed(3)}s</td>
        <td>${(gain / Math.max(0.0001, idl.gain) * 100).toFixed(0)}%</td></tr>`;
    }).join('');
    return `<table class="ctab"><thead><tr><th>赛段</th><th>涵盖弯角</th><th>最优段组合</th><th>最快圈实际</th><th>可捡</th><th>占可捡总量</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  /* 一个进度区间里涵盖了哪几个弯：T3–T7 / T5 / — */
  function sectorSpan(s, fromPct, toPct) {
    const cs = (s.analysis.corners || []).slice().sort((x, y) => x.progress_pct - y.progress_pct)
      .filter(c => c.progress_pct >= fromPct && c.progress_pct < toPct);
    if (!cs.length) return '—';
    if (cs.length === 1) return 'T' + cs[0].id;
    return `T${cs[0].id}–T${cs[cs.length - 1].id}`;
  }

  function render() {
    const s = curSession(), box = document.getElementById('content');
    if (!s) { box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`; return; }
    const a = s.analysis;
    const excl = a.excluded || [];
    if (a.full.filter(l => !l.abnormal && !excl.includes(l.index)).length < 2) {
      box.innerHTML = `<div class="blank">这场只有 <b>${a.full.length}</b> 个完整圈。<br>
        极限圈速需要 2 圈以上才能拼出有意义的理论最快圈。</div>`; return;
    }
    if (!use) use = a.full.filter(l => !l.abnormal && !(a.excluded || []).includes(l.index)).map(l => l.index);
    // 过滤掉已被删除/不存在的圈
    use = use.filter(i => a.full.some(l => l.index === i));
    if (!use.length) use = a.full.map(l => l.index);

    const laps = a.full.filter(l => use.includes(l.index));
    idl = idealLap(s, segCount, laps);

    const median = [...a.full].map(l => l.time_s).sort((x, y) => x - y)[a.full.length >> 1];
    const hasSuspect = laps.some(l => l.time_s > median * 1.06);
    const maxGain = Math.max(...idl.segs.map(x => x.gain), 0.0001);
    // ⚠ 别用 idl.top：它只截了前 24 段，且排序口径应与当前 segCount 一致，这里自己排最稳
    const topList = [...idl.segs].sort((x, y) => y.gain - x.gain).slice(0, 12);

    box.innerHTML = `
      ${hasSuspect ? `<div class="notice">⚠ 参与计算的圈里有的比中位圈慢 6% 以上（带 <b>⚠</b> 标记），
        多半是<b>出场圈/进站圈/失误圈</b>。它们的「快段」往往是出弯全油门直路，会把极限圈速算得过于乐观。
        建议<b>取消勾选</b>这些圈再看。</div>` : ''}

      <div class="stats">
        <div class="statbox"><div class="v" style="color:var(--amber)">${fmtTime(idl.idealTime, 3)}</div>
          <div class="k">极限圈速（理论最快）</div><div class="sub">${segCount} 段各取最快拼接</div></div>
        <div class="statbox"><div class="v">${fmtTime(idl.bestTime, 3)}</div>
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
        <h3>哪些段最能捡时间 <span class="cunit">点一行（或点图上任意位置）→ 高亮它在赛道哪儿</span></h3>
        <div class="segfind">
          <div class="segmap">
            <canvas id="sketchCv"></canvas>
            <div class="sketchhint" id="sketchHint">点右侧任一段，看它落在赛道哪里</div>
          </div>
          <div class="seglist" id="segList">
            ${topList.map(sg => {
              const loc = segLocation(s, sg.from, sg.to);
              return `<button class="segrow" data-seg="${sg.seg}" type="button">
                <span class="segloc"><b class="secs">${loc.sector}</b>${loc.label}</span>
                <span class="segpct">${sg.from.toFixed(0)}–${sg.to.toFixed(0)}% · ${loc.distFrom}–${loc.distTo} m</span>
                <span class="segbar"><span class="segfill" style="width:${(sg.gain / maxGain * 100).toFixed(1)}%"></span></span>
                <span class="segval d-pos">−${sg.gain.toFixed(3)}s</span>
                <span class="seglap">#${sg.lap}</span>
              </button>`;
            }).join('')}
          </div>
        </div>
        <div id="segDetail" class="segdetail">${segDetailHtml(null)}</div>
        <p class="chint" style="margin-top:10px">「#N」是这一段的最快成绩来自第几圈。位置列给出 <b>S1/S2/S3 赛段</b> 和 <b>T几号弯到几号弯</b>，
          照着去赛道上针对性练那一段就行。</p>
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
    document.getElementById('segSel').onchange = e => { segCount = +e.target.value; focusSeg = null; render(); };
    document.getElementById('allBtn').onclick = () => { use = a.full.map(l => l.index); render(); };
    document.getElementById('cleanBtn').onclick = () => {
      use = a.full.filter(l => l.time_s <= median * 1.06).map(l => l.index);
      if (!use.length) use = a.full.map(l => l.index);
      render();
    };
    bindSegFinder(topList);
  }

  /* ---------- 「最能捡时间的段」交互：点行 / 点小地图 → 高亮 + 出详情 ---------- */
  function bindSegFinder(topList) {
    const s = curSession(); if (!s) return;
    const listBox = document.getElementById('segList');
    const cv = document.getElementById('sketchCv');
    const hint = document.getElementById('sketchHint');
    const detail = document.getElementById('segDetail');

    function paint() {
      const hi = [];
      if (focusSeg != null && idl.segs[focusSeg]) {
        hi.push({ from: idl.segs[focusSeg].from, to: idl.segs[focusSeg].to, color: '#e10600', width: 9 });
      }
      for (const sg of topList) {
        if (focusSeg === sg.seg) continue;
        hi.push({ from: sg.from, to: sg.to, color: '#e3a008', width: 5 });
      }
      trackSketch(cv, s, {
        highlights: hi,
        corners: focusSeg == null,
        onPick: pct => {
          // 点在图上 → 落到包含该进度的那一段
          const k = Math.min(segCount - 1, Math.floor(pct / 100 * segCount));
          focusSeg = (focusSeg === k) ? null : k;
          apply();
        }
      });
      [...listBox.querySelectorAll('.segrow')].forEach(el => {
        el.classList.toggle('on', +el.dataset.seg === focusSeg);
      });
    }

    function apply() {
      paint();
      const sg = focusSeg == null ? null : idl.segs[focusSeg];
      detail.innerHTML = segDetailHtml(sg);
      if (hint) {
        hint.textContent = sg
          ? `已选 ${sg.from.toFixed(0)}–${sg.to.toFixed(0)}% · 再点一次取消`
          : '点右侧任一段，看它落在赛道哪里';
      }
      const jump = document.getElementById('segJump'), cmp = document.getElementById('segCmp');
      if (jump) jump.onclick = () => {
        localStorage.setItem('kart.focusSeg', JSON.stringify({
          from: sg.from, to: sg.to, lap: sg.lap, gain: sg.gain,
          label: segLocation(s, sg.from, sg.to)
        }));
        location.href = 'track.html';
      };
      if (cmp) cmp.onclick = () => {
        // sa/sb = 当前 session id：对比页据此选中正确的「节」
        localStorage.setItem('kart.focusCmp', JSON.stringify({
          sa: s.id, a: idl.perLap.reduce((m, p) => p.time_s < m.time_s ? p : m).lap,
          sb: s.id, b: sg.lap
        }));
        location.href = 'compare.html';
      };
    }

    listBox.onclick = e => {
      const el = e.target.closest('.segrow'); if (!el) return;
      const k = +el.dataset.seg;
      focusSeg = (focusSeg === k) ? null : k;
      apply();
    };
    apply();
  }

  /* 选中某段后的详情：位置 / 能捡多少 / 快慢两圈在这段差在哪 */
  function segDetailHtml(sg) {
    const s = curSession();
    if (!s || !sg) return `<span class="chint">👆 点上面任一段，这里会告诉你它在赛道的哪个位置、该向第几圈学。</span>`;
    const a = s.analysis;
    const loc = segLocation(s, sg.from, sg.to);
    const bestLap = idl.perLap.reduce((m, p) => p.time_s < m.time_s ? p : m);
    const bl = a.full.find(l => l.index === bestLap.lap);
    const fl = a.full.find(l => l.index === sg.lap);
    const myT = bestLap.times[sg.seg];
    const st = segStats(s, bl, sg.from, sg.to), sf = segStats(s, fl, sg.from, sg.to);
    const dEnd = sf.vEnd - st.vEnd, dMin = sf.vmin - st.vmin;
    const tip = dEnd > 1.5 ? `出段速度比你快 <b class="d-neg">${dEnd.toFixed(1)} km/h</b>——多半是<b>出弯给油更早</b>。`
      : dMin > 1.5 ? `最低速度比你高 <b class="d-neg">${dMin.toFixed(1)} km/h</b>——<b>弯心速度更快</b>，刹车点可以更晚。`
        : dEnd < -1.5 ? `它出段反而更慢，但这一段整体更快——可能是<b>进弯前刹车更晚、弯前速度更高</b>。`
          : '两段速度曲线很接近，差距主要来自走线/节奏，建议直接叠两圈看 Delta。';
    return `<div class="sdhead">
        <span class="sdtag">${loc.sector}</span>
        <b>${loc.label}</b>
        <span class="sdpct">圈内 ${sg.from.toFixed(1)}–${sg.to.toFixed(1)}% · ${loc.distFrom}–${loc.distTo} m</span>
        <span class="grow"></span>
        <button class="pbtn" id="segJump">在赛道图上查看</button>
        <button class="pbtn" id="segCmp">对比这两圈</button>
      </div>
      <div class="sdgrid">
        <div class="sdcell"><div class="k">这一段能捡</div><div class="v d-pos">−${sg.gain.toFixed(3)}s</div></div>
        <div class="sdcell"><div class="k">这段最快（#${sg.lap}）</div><div class="v">${fmtTime(sg.time, 3)}</div></div>
        <div class="sdcell"><div class="k">你最快圈 #${bestLap.lap}</div><div class="v">${fmtTime(myT, 3)}</div></div>
        <div class="sdcell"><div class="k">最低速 #${sg.lap} / #${bestLap.lap}</div>
          <div class="v">${sf.vmin.toFixed(0)} <span class="mut">vs</span> ${st.vmin.toFixed(0)} km/h</div></div>
        <div class="sdcell"><div class="k">出段速度 #${sg.lap} / #${bestLap.lap}</div>
          <div class="v">${sf.vEnd.toFixed(0)} <span class="mut">vs</span> ${st.vEnd.toFixed(0)} km/h</div></div>
        <div class="sdcell"><div class="k">最高速 #${sg.lap} / #${bestLap.lap}</div>
          <div class="v">${sf.vmax.toFixed(0)} <span class="mut">vs</span> ${st.vmax.toFixed(0)} km/h</div></div>
      </div>
      <div class="sdtip">💡 ${tip}</div>`;
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
        return `<tr><td>#${l.index}</td><td>${fmtTime(l.time_s, 3)}</td><td>${mine}</td>
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
    const head = cols.map(k => {
      const p0 = k / segCount * 100, p1 = Math.min(100, (k + step) / segCount * 100);
      const loc = segLocation(s, p0, p1);
      return `<th title="${p0.toFixed(0)}–${p1.toFixed(0)}% · ${loc.sector} · ${loc.label}">${p0.toFixed(0)}</th>`;
    }).join('');
    const body = laps.map(l => {
      const pl = idl.perLap.find(p => p.lap === l.index);
      const tds = cols.map(k => {
        let t = 0; for (let j = k; j < Math.min(k + step, segCount); j++) t += pl.times[j];
        const isBest = winner[k] === l.index;
        const p0 = k / segCount * 100, p1 = Math.min(100, (k + step) / segCount * 100);
        const loc = segLocation(s, p0, p1);
        return `<td class="${isBest ? 'best' : ''}" title="#${l.index} ${p0.toFixed(0)}–${p1.toFixed(0)}% · ${loc.sector} ${loc.label} · ${t.toFixed(3)}s">${t.toFixed(2)}</td>`;
      }).join('');
      const mine = idl.segs.filter(sg => sg.lap === l.index).length;
      return `<tr><td class="lapno">#${l.index}</td><td class="lapt">${fmtTime(l.time_s, 3)}</td>${tds}
        <td class="mine">${mine}</td></tr>`;
    }).join('');
    return `<table class="ctab mtx"><thead><tr><th>圈</th><th>圈速</th>${head}<th>最快段</th></tr></thead><tbody>${body}</tbody></table>
      <p class="chint">数字是该段的耗时（秒），<b style="color:#3fb950">绿色格</b>表示这一段你在这一圈跑得最快。</p>`;
  }

  document.addEventListener('DOMContentLoaded', () => bootPage('ideal.html', () => { use = null; render(); }));
})();
