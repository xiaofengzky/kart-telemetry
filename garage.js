/* 车库页：按赛道分组展示会话（iRacing 自动按赛道分；VBOX 无名会话按轨迹形状
   自动归「场地 A/B/…」，同一场地不同日期会归在一起）。点赛道大类展开 →
   显示这一赛道每一场什么时候跑的 → 点卡片进分析 */
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

    // 已带名的按赛道名分组；无名的按轨迹指纹聚簇成 场地 A/B/…
    const desc = describeTracks(SESSIONS).sort((a, b) => {
      const la = a.sessions.map(x => x.date || '').sort().pop() || '';
      const lb = b.sessions.map(x => x.date || '').sort().pop() || '';
      return String(lb).localeCompare(String(la));
    });
    const hasFp = desc.some(g => g.key.indexOf('fp:') === 0);

    cnt.textContent = SESSIONS.length + ' 场 · ' + desc.length + ' 条赛道';
    list.innerHTML = (hasFp ? `<div class="chint">✨ 无名场次已按轨迹形状自动分成 场地 A/B/…（同一场地不同日期会自动归在一起）。点每场的 ✏️ 填上真实赛道名后，就会并入对应命名分组。</div>` : '')
      + desc.map(g => {
        const zh = g.label;
        const sessions = g.sessions;
        const best = sessions.map(s => s.analysis.best_time).filter(t => t != null);
        const bestT = best.length ? fmtTime(Math.min(...best), 2) : '—';
        const recent = (sessions.map(x => x.date || '').sort().pop() || '').replace(/^iRacing /, '');
        const open = sessions.some(s => s.id === curId) || sessions.length <= 3;
        const items = sessions.map(s => gitem(s, zh, g.key.indexOf('fp:') === 0)).join('');
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

  /* 单个会话卡片。zhOverride:该会话所在分组的显示名;fp:是否指纹自动分组 */
  function gitem(s, zhOverride, fp) {
    const a = s.analysis;
    const ir = s.source === 'iracing';
    const track = sessionTrack(s);
    const unnamed = !track;
    const zh = zhOverride != null ? zhOverride : trackZh(track || '未分类赛道');
    const tip = unnamed ? (fp ? '按轨迹形状自动归组的场地。点 ✏️ 填上真实赛道名后会并入命名分组' : '未分类赛道，点 ✏️ 改名') : '';
    return `<div class="gitem ${s.id === curId ? 'on' : ''}" data-id="${s.id}">
      <div class="gmain">
        <div class="gtop">
          <span class="gname ${unnamed ? 'gname-unnamed' : ''}" title="${tip}">${esc(zh)} <span class="gdate2">${esc(String(s.date).replace(/^iRacing /, ''))}</span></span>
          <i class="src ${ir ? 'iracing' : 'vbo'}">${ir ? 'iRacing' : 'VBOX'}</i>
          <button class="gedit" data-rename="${s.id}" title="修改赛道名（用于卡丁车 VBOX 改名：英文或中文都行，留空=未分类）">✏️ 改名</button>
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
    /* ✏️ 改名：用于卡丁车 VBOX / iRacing 自定义赛道名。留空=归「未分类赛道」 */
    list.querySelectorAll('[data-rename]').forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        const id = b.dataset.rename;
        const s = SESSIONS.find(x => x.id === id);
        const cur = s.track || '';
        const nv = prompt('给这节设置赛道名（英文或中文都行；常见 iRacing 赛道会自动翻译；留空=归「未分类赛道」）：', cur);
        if (nv == null) return;                                  // 取消
        const v = nv.trim();
        s.track = v;
        dbSave(s);
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
