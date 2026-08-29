/* 赛道图页：卫星图 + 速度热力着色 + 多圈走线对比 + 理论走线极限 + 弯角明细表 + 场地对齐 */
(function () {
  let lapSel = null;          // 选中的走线圈（Set of lap index）
  let showIdeal = false;      // 理论走线极限（默认关，需要对比时再开）
  let lapOverlay = null;      // L.layerGroup 走线叠加层
  let focusSeg = null;        // 从「极限圈速」页点过来的重点段 {from,to,lap,gain,label}
  let focusFitted = false;    // 只自动缩放到重点段一次，否则重绘时视野会被反复拉回

  function loadFocus() {
    try { focusSeg = JSON.parse(localStorage.getItem('kart.focusSeg') || 'null'); }
    catch (e) { focusSeg = null; }
    focusFitted = false;
  }

  function render() {
    const s = curSession(), box = document.getElementById('content');
    if (!s) {
      box.innerHTML = `<div class="blank">还没有数据。<br><a href="index.html">去车库上传一个 .vbo 或 .ibt 文件</a></div>`;
      return;
    }
    if (!map) initMap();
    drawTrack(s);
    const a = s.analysis;
    document.getElementById('mapBadge').textContent = '卫星图 · ' + s.name;
    // 走线对比状态初始化：默认最快圈 + 理论走线
    if (!lapSel) lapSel = new Set();   // 默认不叠走线，先看清按速度着色的赛道图
    lapSel = new Set([...lapSel].filter(i => a.full.some(l => l.index === i)));
    drawLapOverlays(s);

    const cen = centroidPlot(s);
    const al = document.getElementById('alignLat'), ao = document.getElementById('alignLon');
    if (al) al.value = cen.lat.toFixed(5);
    if (ao) ao.value = cen.lon.toFixed(5);

    const worst = a.corners.length
      ? [...a.corners].sort((x, y) => y.speed_loss - x.speed_loss).slice(0, 3).map(c => `C${c.id}（−${c.speed_loss} km/h）`).join('、')
      : '—';
    const minG = a.corners.length ? a.corners.reduce((m, c) => c.max_g < m.max_g ? c : m) : null;

    box.innerHTML = `
      <div class="stats">
        <div class="statbox"><div class="v">${a.corners.length}</div><div class="k">识别弯角</div></div>
        <div class="statbox"><div class="v">${a.vmax.toFixed(0)}</div><div class="k">极速 km/h</div></div>
        <div class="statbox"><div class="v">${a.corners.length ? Math.max(...a.corners.map(c => c.max_g)).toFixed(2) : '-'}</div>
          <div class="k">最高横向G</div></div>
        <div class="statbox"><div class="v">${(a.corners.reduce((t, c) => t + c.speed_loss, 0) / (a.corners.length || 1)).toFixed(1)}</div>
          <div class="k">平均每个弯损失 km/h</div></div>
      </div>

      <div class="card">
        <h3>走线对比 <span class="cunit">每圈一条线：颜色=圈，灰色=未选中，金色虚线=理论走线极限</span></h3>
        <div id="trackLapChips" class="lapchips"></div>
        <div class="crow">
          <button class="pbtn ${showIdeal ? 'on' : ''}" id="idealToggle" style="--c:#e3a008">✨ 理论走线极限</button>
          <button class="pbtn" id="tlAll">全选</button>
          <button class="pbtn" id="tlBest">只看最快圈</button>
        </div>
        <p class="chint"><b>理论走线极限</b> = 把赛道分成 50 小段，每段取你跑得最快那一次的实际轨迹拼起来（金色虚线），
          表示"理论上最优的路径"。对比你各圈的走线，能看到哪个弯你走得偏宽、哪个弯切早了——走线差异是圈速差异的最大来源。</p>
      </div>

      <div class="card">
        <h3>弯角明细 <span class="cunit">按最快圈统计</span></h3>
        ${a.corners.length ? `<div class="tscroll"><table class="ctab">
          <thead><tr><th>弯</th><th>位置</th><th>入弯</th><th>弯心</th><th>出弯</th><th>损失</th><th>最高G</th><th>长度</th></tr></thead>
          <tbody>${a.corners.map(c => `<tr>
            <td><b>C${c.id}</b></td><td>${c.progress_pct}%</td>
            <td>${c.entry_speed}</td><td>${c.apex_speed}</td><td>${c.exit_speed}</td>
            <td class="d-pos">−${c.speed_loss}</td><td>${c.max_g}</td><td>${c.length_m} m</td>
          </tr>`).join('')}</tbody></table></div>
          <p class="chint"><b>损失最多的弯：</b>${worst}<br>
            ${minG ? `<b>横向G 最低的弯：</b>C${minG.id}（仅 ${minG.max_g}G）——说明这个弯没把抓地力用满，可以试着再晚一点刹车、多带点速度进去。` : ''}</p>`
        : '<p class="chint">没有识别到弯角（可能是场地太小或速度太低）。</p>'}
      </div>

      <div class="card">
        <h3>坐标与对齐</h3>
        <p class="chint">
          ${s.source === 'iracing'
          ? 'iRacing 的 .ibt 坐标是模拟器输出的精确 WGS84，赛道会直接落在真实场地上，通常不需要对齐。'
          : 'VBO 的经纬度按官方格式（十进制分钟、经度正数为西经）解析，赛道已落在真实场地位置。若仍有几米误差属 GPS 正常漂移，可用上方「对齐场地」微调。'}<br>
          当前场地中心：<b>${cen.lat.toFixed(5)}, ${cen.lon.toFixed(5)}</b>
        </p>
      </div>`;
    bindTrackLaps(s);
  }

  /* ---------- 多圈走线叠加 ---------- */
  function drawLapOverlays(s) {
    if (lapOverlay) map.removeLayer(lapOverlay);
    lapOverlay = L.layerGroup().addTo(map);
    const a = s.analysis, off = s.offset;
    // ⚠ 不要 bringToFront / 不要盖住基础速度热力：用户主要看的是按速度着色的赛道图
    // （L.layerGroup 也没有 bringToFront 方法，调用会抛异常导致 render() 中断）
    for (const l of a.full) {
      if (!lapSel.has(l.index)) continue;              // 只画勾选的圈，默认不干扰热力图
      const line = [];
      const dec = Math.max(1, Math.floor((l.endIdx - l.startIdx) / 1800));
      for (let i = l.startIdx; i <= l.endIdx; i += dec) {
        const p = s.points[i];
        line.push([p.lat + off.dLat, p.lon + off.dLon]);
      }
      if (line.length > 1) L.polyline(line, {
        color: cmpColor(l.index), weight: 2.2, opacity: .8, lineCap: 'round'
      }).addTo(lapOverlay);
    }
    // 理论走线极限（金色虚线，仅在需要对比时开启）
    if (showIdeal && a.full.length >= 2) {
      const tr = idealTrackTrace(s, 50);
      if (tr.length > 1) L.polyline(tr.map(p => [p[0] + off.dLat, p[1] + off.dLon]), {
        color: '#ffd23f', weight: 2.6, dashArray: '7 5', opacity: .85, lineCap: 'round'
      }).addTo(lapOverlay);
    }
    // 从「极限圈速」页跳过来要看的重点段：粗红线 + 白色虚线芯，并自动缩放到这一段
    if (focusSeg && a.best) {
      const b = a.best, cum = a.cum, P = s.points;
      const D = b.distance_m, d0 = cum[b.startIdx];
      const da = d0 + focusSeg.from / 100 * D, db = d0 + focusSeg.to / 100 * D;
      const line = [];
      for (let i = b.startIdx; i <= b.endIdx; i++) {
        if (cum[i] < da || cum[i] > db) continue;
        line.push([P[i].lat + off.dLat, P[i].lon + off.dLon]);
      }
      if (line.length > 1) {
        L.polyline(line, { color: '#e10600', weight: 9, opacity: .55, lineCap: 'round' }).addTo(lapOverlay);
        L.polyline(line, { color: '#ff5b5b', weight: 4, opacity: .95, lineCap: 'round' }).addTo(lapOverlay);
        L.polyline(line, { color: '#fff', weight: 1.6, opacity: .9, dashArray: '4 6' }).addTo(lapOverlay);
        if (!focusFitted) {
          focusFitted = true;
          try { map.fitBounds(L.latLngBounds(line), { padding: [50, 50], maxZoom: 18 }); } catch (e) { }
        }
      }
    }
    renderFocusBar(s);
  }

  /* 重点段提示条 */
  function renderFocusBar(s) {
    const bar = document.getElementById('focusBar');
    if (!bar) return;
    const badge = document.getElementById('mapBadge');
    if (!focusSeg || !s.analysis.best) { bar.style.display = 'none'; if (badge) badge.style.display = ''; return; }
    if (badge) badge.style.display = 'none';        // 提示条和 badge 会叠在一起，二选一
    let loc = focusSeg.label;
    if (!loc || typeof loc === 'string') loc = segLocation(s, focusSeg.from, focusSeg.to);
    bar.style.display = '';
    bar.innerHTML = `🔴 <b>${loc.sector} · ${loc.label}</b>
      <span class="mut">圈内 ${focusSeg.from.toFixed(0)}–${focusSeg.to.toFixed(0)}% · ${loc.distFrom}–${loc.distTo} m</span>
      · 可捡 <b class="d-pos">−${(focusSeg.gain || 0).toFixed(3)}s</b>，最快来自 <b>#${focusSeg.lap}</b>
      <button class="mini" id="focusClear" style="margin-left:8px">清除</button>`;
    const cl = document.getElementById('focusClear');
    if (cl) cl.onclick = () => {
      focusSeg = null; focusFitted = false;
      localStorage.removeItem('kart.focusSeg');
      renderFocusBar(s); drawLapOverlays(s);
    };
  }
  function bindTrackLaps(s) {
    const box = document.getElementById('trackLapChips');
    if (!box) return;
    const a = s.analysis;
    renderLapChips(box, a.full, [...lapSel], i => {
      if (lapSel.has(i)) { if (lapSel.size > 1) lapSel.delete(i); } else lapSel.add(i);
      box.querySelectorAll('.lapchip').forEach(c => c.classList.toggle('on', lapSel.has(+c.dataset.lap)));
      drawLapOverlays(s);
    }, false);
    const it = document.getElementById('idealToggle');
    if (it) it.onclick = () => { showIdeal = !showIdeal; it.classList.toggle('on', showIdeal); drawLapOverlays(s); };
    const all = document.getElementById('tlAll');
    if (all) all.onclick = () => { lapSel = new Set(a.full.map(l => l.index)); bindTrackLaps(s); drawLapOverlays(s); };
    const best = document.getElementById('tlBest');
    if (best) best.onclick = () => { lapSel = new Set(a.best ? [a.best.index] : [a.full[0].index]); bindTrackLaps(s); drawLapOverlays(s); };
  }

  function bindMapUI() {
    const mm = document.getElementById('mapModule');
    const exp = document.getElementById('mmExpand');
    if (exp) exp.onclick = () => {
      const m = document.getElementById('map');
      m.classList.toggle('tall');
      setTimeout(() => map && map.invalidateSize(), 60);
      exp.textContent = m.classList.contains('tall') ? '⤢ 收起' : '⤢ 放大';
    };
    const al = document.getElementById('mmAlign');
    if (al) al.onclick = () => {
      const b = document.getElementById('alignBox');
      if (b) { b.classList.toggle('show'); al.classList.toggle('on', b.classList.contains('show')); }
    };
    const ap = document.getElementById('applyAlign');
    if (ap) ap.onclick = () => {
      const s = curSession(); if (!s) return;
      const la = parseFloat(document.getElementById('alignLat').value);
      const lo = parseFloat(document.getElementById('alignLon').value);
      if (!isFinite(la) || !isFinite(lo)) { note('请输入有效的经纬度'); return; }
      applyAlign(s, la, lo);
      note('已对齐到 ' + la.toFixed(5) + ', ' + lo.toFixed(5));
    };
    const pk = document.getElementById('pickAlign');
    if (pk) pk.onclick = () => { picking = !picking; pk.classList.toggle('ghost', !picking); note(picking ? '在地图上点击场地中心…' : ''); };
    const rs = document.getElementById('resetAlign');
    if (rs) rs.onclick = () => {
      const s = curSession(); if (!s) return;
      s.offset.dLat = 0; s.offset.dLon = 0; drawTrack(s);
      const c = centroidPlot(s);
      document.getElementById('alignLat').value = c.lat.toFixed(5);
      document.getElementById('alignLon').value = c.lon.toFixed(5);
      note('已重置为原始坐标');
    };
    const lb = document.getElementById('locateBtn');
    if (lb) lb.onclick = () => locateMe();
  }
  function note(t) {
    const n = document.getElementById('alignNote');
    if (!n) return;
    n.textContent = t || ''; n.style.display = t ? 'block' : 'none';
  }

  document.addEventListener('DOMContentLoaded', () => {
    bootPage('track.html', () => { loadFocus(); render(); });
    bindMapUI();
  });
})();
