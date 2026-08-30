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
    // 极限圈速只基于有效圈（自动/手动排除的异常圈不参与）
    const validLaps = a.full.filter(l => !l.abnormal && !(a.excluded || []).includes(l.index));
    const idl = validLaps.length >= 2 ? idealLap(s, 50, validLaps) : null;
    const bm = best && best.metrics ? best.metrics : null;
    const tire = tireAnalysis(s);          // 无轮胎通道时返回 null（VBO）

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
    if (slow.length) diags.push({ t: 'warn', txt: `有 <b>${slow.length}</b> 圈比中位圈慢（暖胎圈/出场圈/失误圈），已<b>自动排除</b>出统计——如果某圈排错了，去<a href="laps.html" style="color:var(--blue)">圈速</a>页点 ↺ 恢复。` });
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
    if (slow.length) tasks.push({ icon: '🧹', t: '检查被排除的圈', d: `${slow.length} 圈被自动排除（比中位慢），去圈速页确认排得对不对，误排就点 ↺ 恢复`, href: 'laps.html', cta: '去圈速' });
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
        <h3>💬 直接问 <span class="cunit">本地规则引擎，不联网、不需要 API key</span></h3>
        <div class="qarow">
          <input id="qaInput" type="text" placeholder="比如：我还能提升哪里？刹车有什么问题？轮胎温度正常吗？">
          <button class="pbtn" id="qaAsk">问</button>
        </div>
        <div class="qachips">${QA_RULES.map(r => `<button class="chip" data-q="${esc(r.title)}">${esc(r.title)}</button>`).join('')}</div>
        <div id="qaAns">${qaHtml(s, '我还能提升多少', idl)}</div>
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
        <h3>🔥 轮胎与刹车 <span class="cunit">长距离胎温 · ABS 介入 · 磨损（仅 iRacing）</span></h3>
        ${tireCard(s, tire)}
      </div>

      <div class="card">
        <h3>📋 今日训练清单 <span class="cunit">按优先级排好，练完一项划掉一项</span></h3>
        <div class="tasklist">${taskHtml}</div>
      </div>

      <div class="card">
        <h3>怎么看这页</h3>
        <p class="chint">
          ① <b>直接问</b>：输入问题（或点预置问题），本地算出答案，不联网；<br>
          ② <b>教练诊断</b>：一句话告诉你现在的核心问题是什么；<br>
          ③ <b>提升机会</b>：还有多少时间可捡、按 S1/S2/S3 拆到哪个赛段；<br>
          ④ <b>最值得练的 3 段</b>：具体到「S2 · T3 → T4」这种位置，直接去练；<br>
          ⑤ <b>轮胎与刹车</b>：胎温有没有进窗口、内外温差、ABS 是不是踩太深、磨损均不均；<br>
          ⑥ <b>训练清单</b>：把上面的结论排成今天要做的几件事，做完再来跑一场，对比圈速是否变快。
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

    /* 问答：输入 / 预置问题 / 回车 */
    const qi = document.getElementById('qaInput');
    const doAsk = () => {
      const q = (qi.value || '').trim();
      if (!q) return;
      document.getElementById('qaAns').innerHTML = qaHtml(s, q, idl);
    };
    if (qi) {
      document.getElementById('qaAsk').onclick = doAsk;
      qi.onkeydown = e => { if (e.key === 'Enter') doAsk(); };
    }
    document.querySelectorAll('#content .qachips .chip').forEach(c => {
      c.onclick = () => {
        if (qi) qi.value = c.dataset.q;
        document.getElementById('qaAns').innerHTML = qaHtml(s, c.dataset.q, idl);
      };
    });
    document.querySelectorAll('#content .qasug').forEach(x => {
      x.onclick = () => {
        if (qi) qi.value = x.textContent;
        document.getElementById('qaAns').innerHTML = qaHtml(s, x.textContent, idl);
      };
    });

    /* 轮胎趋势图 */
    const tt = document.getElementById('tireTrend');
    if (tt && tire && tire.laps.length > 1) drawTireTrend(tt, tire);
  }

  /* 问答答案渲染 */
  function qaHtml(s, q, idl) {
    const res = askQuestion(s, q, { idl });
    if (!res) return '';
    if (res.fallback) {
      return `<div class="qabox mid"><div class="qatext">这个我还不会，试试这些：</div>
        <div>${res.suggestions.map(x => `<span class="qasug">${esc(x)}</span>`).join('')}</div></div>`;
    }
    const ans = res.ans || {};
    return `<div class="qabox ${ans.tone || 'mid'}">
      <div class="qatitle">${esc(res.rule.title)}</div>
      <div class="qatext">${ans.txt || ''}</div>
      ${ans.tip ? `<div class="qatip">💡 ${ans.tip}</div>` : ''}
      ${ans.link ? `<a class="qalink" href="${ans.link.href}">${esc(ans.link.label)} →</a>` : ''}
    </div>`;
  }

  /* 轮胎与刹车卡片 */
  function tireCard(s, t) {
    if (!t) {
      return `<p class="chint">这份数据没有轮胎/ABS 通道——卡丁车 VBO 文件物理上没有胎温、轮速传感器；
        iRacing 的 .ibt 才有。想要这块分析，去跑一场 iRacing 再导出遥测。</p>`;
    }
    const rows = t.wheels.map(w => `<tr>
      <td><b>${w.name}</b></td>
      <td>${w.avg}°C</td>
      <td class="${w.peak > t.TIRE_HOT ? 'd-pos' : ''}">${w.peak}°C</td>
      <td>${w.outer}°C</td>
      <td>${w.inner}°C</td>
      <td class="${Math.abs(w.delta) >= 12 ? 'd-pos' : ''}">${w.delta > 0 ? '+' : ''}${w.delta}°C</td>
    </tr>`).join('');
    const hot = t.abs.hotspots.length
      ? t.abs.hotspots.map(h => `${h.pct}–${h.pct + 5}%${h.cornerId != null ? '（T' + h.cornerId + '）' : ''}`).join('、') : '—';
    const wearRows = t.wear.perLap.slice(0, 12).map(w =>
      `<tr><td>#${w.lap}</td><td>${w.mid.toFixed(2)}</td><td>${w.outer.toFixed(2)}</td><td>${w.inner.toFixed(2)}</td></tr>`).join('');
    return `<div class="evwrap">
      <div class="evcol">
        <h4>四轮胎温（全程）</h4>
        <table class="ctab"><thead><tr><th>轮</th><th>平均</th><th>峰值</th><th>外侧</th><th>内侧</th><th>外−内</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <p class="chint">工作窗口约 ${t.TIRE_WARM}–${t.TIRE_HOT}°C。外−内为正=外侧更热（外倾不足或胎压低）；为负=内侧更热（外倾偏大或胎压高）。</p>
      </div>
      <div class="evcol">
        <h4>ABS 与滑移</h4>
        <table class="ctab"><tbody>
          <tr><td>轻触 ABS 占刹车</td><td><b>${t.abs.brakePct}%</b></td></tr>
          <tr><td>深度介入（削减&gt;5%）</td><td class="${t.abs.deepPct > 20 ? 'd-pos' : ''}"><b>${t.abs.deepPct}%</b></td></tr>
          <tr><td>平均削减</td><td><b>${t.abs.avgCut}%</b></td></tr>
          <tr><td>最大滑移</td><td class="${t.abs.maxSlip > 12 ? 'd-pos' : ''}"><b>${t.abs.maxSlip}%</b></td></tr>
          <tr><td>介入最深的位置</td><td><b>${hot}</b></td></tr>
        </tbody></table>
        <p class="chint">GT3 重刹时 ABS 轻触属于正常；<b>深度介入占比高</b>才说明刹车踩过头（轮胎在打滑边界）。</p>
      </div>
    </div>
    ${t.laps.length > 1 ? `<h4 style="margin:14px 0 6px;font-size:12px">长距离胎温趋势（每圈平均）</h4>
      <canvas id="tireTrend" class="chart"></canvas>` : ''}
    ${wearRows ? `<h4 style="margin:14px 0 6px;font-size:12px">磨损（每圈掉几个百分点）</h4>
      <table class="ctab"><thead><tr><th>圈</th><th>中层</th><th>外侧</th><th>内侧</th></tr></thead><tbody>${wearRows}</tbody></table>
      <p class="chint">全程累计 <b>${t.wear.total.toFixed(2)}</b> 个百分点，内外磨损差 <b>${Math.abs(t.wear.outerInner).toFixed(2)}</b>（${t.wear.outerInner > 0 ? '外侧多' : '内侧多'}）。</p>` : ''}
    <div style="margin-top:10px">${t.verdicts.map(v => `<div class="diag ${v.t}" style="margin-bottom:6px">${v.txt}</div>`).join('')}</div>`;
  }

  /* 长距离胎温 + ABS 趋势 */
  function drawTireTrend(cv, t) {
    const laps = t.laps.slice(-30);
    const cfg = {
      height: 220,
      xLabels: laps.map(l => l.lap), xFmt: v => '#' + v,
      series: [
        { name: '胎温 °C', color: '#e3a008', data: laps.map(l => l.temp), width: 2 },
        { name: 'ABS 深度介入 %', color: '#e10600', data: laps.map(l => l.absPct), width: 1.4 }
      ],
      tip: i => [
        ['圈', '#' + laps[i].lap],
        ['平均胎温', laps[i].temp.toFixed(1) + ' °C', '#e3a008'],
        ['ABS', laps[i].absPct.toFixed(1) + '%', '#e10600'],
        ['最大滑移', laps[i].maxSlip.toFixed(1) + '%']
      ]
    };
    drawTraces(cv, cfg);
    bindTraceChart(cv, () => cfg, () => drawTraces(cv, cfg));
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
