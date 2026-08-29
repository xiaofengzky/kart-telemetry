/* 赛道图页：卫星图 + 速度热力着色 + 弯角标注 + 弯角明细表 + 场地对齐 */
(function () {
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
    bootPage('track.html', render);
    bindMapUI();
  });
})();
