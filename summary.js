/* 总结页：把一场 session 的所有分析浓缩成「教练诊断 + 今日训练清单」，
   目的只有一个——告诉你接下来怎么练才能最快提升圈速。 */
(function () {
  function render() {
    const s = curSession(), box = document.getElementById('content');
    if (!s) { box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`; return; }
    const a = s.analysis;
    if (!a.full.length) { box.innerHTML = `<div class="blank">这场没有识别到完整圈。</div>`; return; }
    const ir = !!a.isIR;

    const sorted = [...a.full].sort((x, y) => x.time_s - y.time_s);
    const median = sorted[sorted.length >> 1].time_s;
    const slow = a.full.filter(l => l.time_s > median * 1.06);
    const best = a.best;
    const idl = a.full.length >= 2 ? idealLap(s, 50) : null;
    const bm = best && best.metrics ? best.metrics : null;

    /* ---------- 教练诊断（规则引擎，按严重程度排序） ---------- */
    const diags = [];
    if (idl) {
      const pct = idl.gain / idl.bestTime * 100;
      if (pct > 2) diags.push({ t: 'warn', txt: `理论上你还能捡 <b>${fmtTime(idl.gain)}</b>（约 ${pct.toFixed(1)}%），这是单圈最快拼出来的，主要差在<b>出弯速度</b>——每个位置都有人比你快。` });
      else if (pct > 0.8) diags.push({ t: 'mid', txt: `可捡空间 <b>${fmtTime(idl.gain)}</b>（${pct.toFixed(1)}%），不算多了，接下来抠刹车点一致性和走线细节。` });
      else diags.push({ t: 'good', txt: `可捡空间只有 <b>${fmtTime(idl.gain)}</b>（${pct.toFixed(1)}%），一致性已经很接近极限，该把重点转向<b>稳定性</b>和每圈的复现率。` });
    }
    if (a.core_std > 0.6) diags.push({ t: 'warn', txt: `核心圈标准差 <b>${a.core_std.toFixed(2)}s</b>，节奏偏散——先求稳再求快，稳定 10 圈比你偶尔快 0.3s 更值钱。` });
    else if (a.core_std > 0.35) diags.push({ t: 'mid', txt: `核心圈标准差 ${a.core_std.toFixed(2)}s，中等水平，最快的提升方式是<b>固定刹车点</b>。` });
    else diags.push({ t: 'good', txt: `核心圈标准差仅 ${a.core_std.toFixed(2)}s，一致性很好，可以在极限边缘多试晚刹。` });
    if (slow.length) diags.push({ t: 'warn', txt: `有 <b>${slow.length}</b> 圈比中位圈慢 6% 以上（多半是出场圈/失误圈），分析时建议先排除它们。` });
    if (!diags.length) diags.push({ t: 'good', txt: '数据太少，先多跑几圈再来听总结。' });

    /* ---------- 提升机会：S1/S2/S3 可捡分解 ---------- */
    let secRows = '';
    if (idl) {
      const third = idl.segCount / 3;
      const bl = best && best.sector_times ? best.sector_times : [0, 0, 0];
      const maxPct = Math.max(1, idl.gain);
      secRows = [0, 1, 2].map(k => {
        const segs = idl.segs.filter(x => x.seg >= k * third && x.seg < (k + 1) * third);
        const opt = segs.reduce((t, x) => t + x.time, 0);
        const gain = Math.max(0, (bl[k] || 0) - opt);
        const span = cornerSpan(s, k / 3 * 100, (k + 1) / 3 * 100);
        return `<div class="secrow">
          <span class="secname"><b>S${k + 1}</b> <span class="mut">${span}</span></span>
          <span class="secbar"><span class="secfill ${gain > idl.gain / 3 ? 'hot' : ''}" style="width:${(gain / maxPct * 100).toFixed(0)}%"></span></span>
          <span class="secval">${gain > 0.0005 ? '−' + gain.toFixed(3) + 's' : '已最优'}</span>
        </div>`;
      }).join('');
    }

    /* ---------- TOP3 提升点 ---------- */
    const top = idl ? [...idl.segs].sort((x, y) => y.gain - x.gain).slice(0, 3) : [];
    const topHtml = top.length ? top.map((sg, i) => {
      const loc = segLocation(s, sg.from, sg.to);
      return `<button class="taskrow" data-i="${i}" type="button">
        <span class="taskno">${i + 1}</span>
        <span class="taskbody"><b>${loc.sector} · ${loc.label}</b>
          <span class="mut">圈内 ${sg.from.toFixed(0)}–${sg.to.toFixed(0)}% · ${loc.distFrom}–${loc.distTo} m</span></span>
        <span class="taskgain d-pos">−${sg.gain.toFixed(3)}s</span>
        <span class="tasklap">最快 #${sg.lap}</span>
      </button>`;
    }).join('') : '<p class="chint">需要至少 2 圈才能算提升点，去 <a href="ideal.html" style="color:var(--blue)">极限圈速</a> 看详情。</p>';

    /* ---------- 弯道薄弱点 ---------- */
    const worstC = [...a.corners].sort((x, y) => y.speed_loss - x.speed_loss).slice(0, 2);
    const minGc = a.corners.length ? a.corners.reduce((m, c) => c.max_g < m.max_g ? c : m) : null;
    const maxG = a.corners.length ? Math.max(...a.corners.map(c => c.max_g)) : 0;

    /* ---------- 刹车一致性 ---------- */
    const bc = a.brakeConsistency && a.brakeConsistency.length ? a.brakeConsistency[0] : null;

    /* ---------- 训练清单（按优先级排序，最多 5 条） ---------- */
    const tasks = [];
    if (bc) tasks.push({ icon: '🛑', t: `固定刹车点：进度 ${bc.progress}%`, d: `这个刹车点每圈位置波动 ±${bc.std.toFixed(1)}%，固定下来单圈立刻变稳`, href: 'laps.html', cta: '看刹车表' });
    top.forEach((sg) => {
      const loc = segLocation(s, sg.from, sg.to);
      tasks.push({ icon: '🎯', t: `练 ${loc.sector} ${loc.label}`, d: `可捡 −${sg.gain.toFixed(3)}s，去极限圈速页看这段怎么跑（还有速度对比）`, href: 'ideal.html', cta: '去极限圈速' });
    });
    if (worstC.length) tasks.push({ icon: '🅿️', t: `晚刹进 T${worstC[0].id}`, d: `入弯→弯心损失 ${worstC[0].speed_loss} km/h，是全场丢速最多的弯，试着更晚、更狠地刹车`, href: 'track.html', cta: '看赛道图' });
    if (idl) tasks.push({ icon: '✨', t: '看理论走线', d: `极限圈速 ${fmtTime(idl.idealTime)}，比最快圈快 ${(idl.gain * 1000).toFixed(0)}ms——赛道图上金色虚线就是理论最优路径`, href: 'track.html', cta: '看走线' });
    if (slow.length) tasks.push({ icon: '🧹', t: '排除慢圈再分析', d: `${slow.length} 圈比中位慢 6% 以上，先勾掉它们，结论才准`, href: 'laps.html', cta: '去圈速' });
    if (bm) tasks.push({ icon: '⚡', t: `把全油门占比 ${bm.flatout_pct}% 往上提`, d: '出弯早给油、平滑加压，是最直接的圈速来源', href: 'telemetry.html', cta: '看油门曲线' });
    const taskHtml = tasks.slice(0, 5).map(t =>
      `<div class="taskrow">
        <span class="taskno">${t.icon}</span>
        <span class="taskbody"><b>${t.t}</b><span class="mut">${t.d}</span></span>
        <a class="taskcta" href="${t.href}">${t.cta} →</a>
      </div>`).join('');

    const bestTime = best ? fmtTime(best.time_s, 3) : '—';

    box.innerHTML = `
      <div class="stats">
        <div class="statbox"><div class="v">${a.full.length}</div><div class="k">完整圈</div></div>
        <div class="statbox"><div class="v">${bestTime}</div><div class="k">最快圈 <span style="color:var(--mut)">#${best ? best.index : '-'}</span></div></div>
        <div class="statbox"><div class="v">${fmtTime(a.core_avg, 3)}</div><div class="k">核心均速</div>
          <div class="sub">去掉最快最慢</div></div>
        <div class="statbox"><div class="v" style="color:${a.gradeCol}">${a.grade}</div><div class="k">一致性</div>
          <div class="sub">标准差 ±${a.core_std}s</div></div>
        <div class="statbox"><div class="v">${a.vmax.toFixed(0)}</div><div class="k">极速 km/h</div></div>
        <div class="statbox"><div class="v">${a.corners.length}</div><div class="k">识别弯角</div></div>
      </div>

      <div class="card">
        <h3>🎓 教练诊断</h3>
        ${diags.map(d => `<div class="diag ${d.t}">${d.txt}</div>`).join('')}
      </div>

      ${idl ? `
      <div class="card">
        <h3>提升机会 <span class="cunit">理论极限 ${fmtTime(idl.idealTime, 3)} vs 你的最快圈 ${bestTime} · 还能捡 ${fmtTime(idl.gain)}</span></h3>
        <div class="secwrap">${secRows}</div>
        <p class="chint">每个赛段拆开看：红色越长的赛段越值得练。S 段已经到极限的话，建议换到稳定性和走线细节。</p>
      </div>` : `
      <div class="card"><h3>提升机会</h3>
        <p class="chint">至少需要 2 个完整圈才能算「理论极限 + 可捡时间」。<a href="index.html" style="color:var(--blue)">去车库</a>换一场 2 圈以上的数据。</p>
      </div>`}

      <div class="card">
        <h3>🎯 最值得练的 3 段 <span class="cunit">点一行跳去极限圈速页看细节</span></h3>
        ${topHtml}
        ${idl ? `<p class="chint" style="margin-top:8px">还有更多可捡段在 <a href="ideal.html" style="color:var(--blue)">极限圈速</a>（共 12 段，点开看它在赛道哪里、该怎么练）。</p>` : ''}
      </div>

      <div class="card">
        <h3>🛰 赛道走线总览 <span class="cunit">每圈一条彩线，弯前分叉越开 = 走线/刹车越不一致</span></h3>
        <div class="summap"><canvas id="sumCv"></canvas></div>
        <div class="sumlegend">${a.full.map(l => `<span class="lg"><i style="background:${cmpColor(l.index)}"></i>#${l.index}</span>`).join('')}
          <span class="lg"><i style="background:#e10600;border-radius:50%"></i>刹车点</span></div>
        <p class="chint">每条线是一圈的走线。线在弯前<b>分叉越开</b>，说明刹车点/走线每圈都不一样——这是稳定性丢时间的直接原因。
          把线收敛到同一条，圈速自然就稳了。想细看走线，去 <a href="track.html" style="color:var(--blue)">赛道图</a> 叠加对比。</p>
      </div>

      <div class="card">
        <h3>🏎 弯道与驾驶习惯</h3>
        <div class="evwrap">
          <div class="evcol">
            <h4>丢速最多的弯（最该先练）</h4>
            <table class="ctab"><thead><tr><th>弯</th><th>入弯</th><th>弯心</th><th>出弯</th><th>损失</th><th>横向G</th></tr></thead>
            <tbody>${worstC.map(c => `<tr><td><b>T${c.id}</b></td><td>${c.entry_speed}</td><td>${c.apex_speed}</td><td>${c.exit_speed}</td>
              <td class="d-pos">−${c.speed_loss} km/h</td><td>${c.max_g}</td></tr>`).join('')}</tbody></table>
          </div>
          <div class="evcol">
            <h4>抓地与习惯</h4>
            <table class="ctab"><tbody>
              <tr><td>最高横向G</td><td><b>${maxG.toFixed(2)}</b></td></tr>
              <tr><td>G 最低的弯（可晚刹）</td><td><b>T${minGc ? minGc.id : '-'}</b> · ${minGc ? minGc.max_g.toFixed(2) : '-'}G</td></tr>
              <tr><td>全油门占比（最快圈）</td><td><b>${bm ? bm.flatout_pct + '%' : '-'}</b></td></tr>
              <tr><td>峰值减速</td><td><b>${bm ? bm.peakBrakeG + (ir ? '%' : 'G') : '-'}</b></td></tr>
              <tr><td>G-Sum 峰值</td><td><b>${bm ? bm.gsumPeak : '-'}</b></td></tr>
              <tr><td>刹车点最不稳</td><td><b>${bc ? '进度 ' + bc.progress + '% ±' + bc.std.toFixed(1) + '%' : '较一致'}</b></td></tr>
            </tbody></table>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>📋 今日训练清单 <span class="cunit">按优先级排好，练完一项划掉一项</span></h3>
        <div class="tasklist">${taskHtml}</div>
      </div>

      <div class="card">
        <h3>怎么看这页</h3>
        <p class="chint">
          ① <b>教练诊断</b>：一句话告诉你现在的核心问题是什么；<br>
          ② <b>提升机会</b>：还有多少时间可捡、按 S1/S2/S3 拆到哪个赛段；<br>
          ③ <b>最值得练的 3 段</b>：具体到「S2 · T3 → T4」这种位置，直接去练；<br>
          ④ <b>弯道与习惯</b>：哪个弯丢速最多、哪个弯可以再晚刹；<br>
          ⑤ <b>训练清单</b>：把上面的结论排成今天要做的几件事，做完再来跑一场，对比圈速是否变快。
        </p>
      </div>`;

    /* 交互：点 TOP3 段 → 带 focusSeg 跳极限圈速页 */
    document.querySelectorAll('#content .taskrow[data-i]').forEach((el, i) => {
      el.onclick = () => {
        const sg = top[i]; if (!sg) return;
        localStorage.setItem('kart.focusSeg', JSON.stringify({
          from: sg.from, to: sg.to, lap: sg.lap, gain: sg.gain,
          label: segLocation(s, sg.from, sg.to)
        }));
        location.href = 'ideal.html';
      };
    });

    /* 赛道走线总览：每圈一条线 + 刹车点红点标记 */
    const sumCv = document.getElementById('sumCv');
    if (sumCv && a.full.length >= 1) {
      const markers = [];
      if (bc) markers.push({ pct: bc.progress, color: '#e10600', r: 5, label: `刹车点 ±${bc.std.toFixed(1)}%` });
      trackSketch(sumCv, s, { base: 'dark', laps: a.full.map(l => l.index), markers, corners: true });
    }
  }

  /* 赛段涵盖弯角（给 S1/S2/S3 用）：T3–T7 / T5 / — */
  function cornerSpan(s, fromPct, toPct) {
    const cs = (s.analysis.corners || []).slice().sort((x, y) => x.progress_pct - y.progress_pct)
      .filter(c => c.progress_pct >= fromPct && c.progress_pct < toPct);
    if (!cs.length) return '—';
    if (cs.length === 1) return 'T' + cs[0].id;
    return `T${cs[0].id}–T${cs[cs.length - 1].id}`;
  }

  document.addEventListener('DOMContentLoaded', () => bootPage('summary.html', render));
})();
