/* 车库页：按赛道分组展示会话（iRacing 自动按赛道分；VBOX 归「未分类赛道」）
   点赛道大类展开 → 显示这一赛道每一场什么时候跑的 → 点卡片进分析 */
(function () {
  /* 会话列表渲染（赛道分组视图） */
  function render() {
    const list = document.getElementById('list');
    const cnt = document.getElementById('cnt');
    const dz = document.getElementById('dropZone');
    if (!SESSIONS.length) {
      cnt.textContent = '';
      list.innerHTML = `<div class="blank">还没有数据。<br>拖入一个 .vbo 或 .ibt 文件就能开始分析。</div>`;
      if (dz) dz.style.display = 'block';
      return;
    }
    if (dz) dz.style.display = 'none';

    // 按赛道分组（保持稳定顺序：有会话的赛道按最近活动排序）
    const groups = new Map();
    for (const s of SESSIONS) {
      const t = sessionTrack(s) || '未分类赛道';
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(s);
    }
    const order = [...groups.entries()].sort((a, b) => {
      const la = a[1].map(x => x.date || '').sort().pop() || '';
      const lb = b[1].map(x => x.date || '').sort().pop() || '';
      return String(lb).localeCompare(String(la));
    });
    const activeTrack = curId ? sessionTrack(SESSIONS.find(x => x.id === curId)) : null;

    cnt.textContent = SESSIONS.length + ' 场 · ' + groups.size + ' 条赛道';
    list.innerHTML = order.map(([track, sessions]) => {
      const zh = trackZh(track);
      const best = sessions.map(s => s.analysis.best_time).filter(t => t != null);
      const bestT = best.length ? fmtTime(Math.min(...best), 2) : '—';
      const recent = (sessions.map(x => x.date || '').sort().pop() || '').replace(/^iRacing /, '');
      const open = track === activeTrack || sessions.length <= 3;
      const items = sessions.map(s => gitem(s)).join('');
      return `<div class="trkgroup ${open ? 'open' : ''}">
        <button class="trkhead" type="button">
          <span class="trkflag">🏁</span>
          <span class="trkname">${esc(zh)}</span>
          <span class="trkmeta">${sessions.length} 场 · 最快 <b>${bestT}</b> · 最近 ${esc(String(recent).replace(/^iRacing /, ''))}</span>
          <span class="trkarrow">▾</span>
        </button>
        <div class="trkbody">${items}</div>
      </div>`;
    }).join('');

    list.querySelectorAll('.trkhead').forEach(h => {
      h.onclick = () => h.closest('.trkgroup').classList.toggle('open');
    });
    bindActions();
  }

  /* 单个会话卡片 */
  function gitem(s) {
    const a = s.analysis;
    const ir = s.source === 'iracing';
    const zh = trackZh(sessionTrack(s) || '未分类赛道');
    return `<div class="gitem ${s.id === curId ? 'on' : ''}" data-id="${s.id}">
      <div class="gmain">
        <div class="gtop">
          <span class="gname">${esc(zh)} <span class="gdate2">${esc(String(s.date).replace(/^iRacing /, ''))}</span></span>
          <i class="src ${ir ? 'iracing' : 'vbo'}">${ir ? 'iRacing' : 'VBOX'}</i>
        </div>
        <div class="gmeta">
          <span>最快 <b>${a.best_time != null ? fmtTime(a.best_time, 2) : '-'}</b></span>
          <span>有效圈 <b>${a.validCount != null ? a.validCount : a.full.length}/${a.full.length}</b></span>
          <span>极速 <b>${a.vmax.toFixed(0)}</b> km/h</span>
          <span>最高G <b>${a.corners.length ? Math.max(...a.corners.map(c => c.max_g)).toFixed(2) : '-'}</b></span>
        </div>
        <div class="gactions">
          <a class="gbtn primary" href="laps.html">圈速</a>
          <a class="gbtn" href="telemetry.html">遥测通道</a>
          <a class="gbtn" href="compare.html">多圈对比</a>
          <a class="gbtn" href="ideal.html">极限圈速</a>
          <a class="gbtn" href="track.html">赛道图</a>
          <button class="gbtn danger" data-del="${s.id}">删除</button>
        </div>
      </div>
    </div>`;
  }

  function bindActions() {
    const list = document.getElementById('list');
    list.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        const id = b.dataset.del;
        const s = SESSIONS.find(x => x.id === id);
        if (!confirm('删除「' + trackZh(sessionTrack(s)) + ' · ' + s.date + '」？此操作不可撤销。')) return;
        dbDelete(id);
        const i = SESSIONS.findIndex(x => x.id === id);
        if (i >= 0) SESSIONS.splice(i, 1);
        if (curId === id) { curId = SESSIONS.length ? SESSIONS[SESSIONS.length - 1].id : null; saveCurId(curId); }
        renderSessionBar(render);
        render();
      };
    });
  }

  // 卡片点击（非按钮区域）= 选中该会话
  document.addEventListener('click', e => {
    const item = e.target.closest ? e.target.closest('.gitem') : null;
    if (!item || e.target.closest('.gbtn') || e.target.closest('.trkhead')) return;
    setCurSession(item.dataset.id);
    renderSessionBar(render);
    render();
  });

  document.addEventListener('DOMContentLoaded', () => {
    bootPage('index.html', render);
    setupUpload('fileInput', render);
  });
})();
