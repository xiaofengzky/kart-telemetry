/* 车库页：上传 / 会话列表 / 删除 / 进入分析 */
(function () {
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
    cnt.textContent = SESSIONS.length + ' 场';
    list.innerHTML = SESSIONS.map(s => {
      const a = s.analysis;
      const ir = s.source === 'iracing';
      return `<div class="gitem ${s.id === curId ? 'on' : ''}">
        <div class="gmain">
          <div class="gtop">
            <span class="gname">${esc(s.name)}</span>
            <i class="src ${ir ? 'iracing' : 'vbo'}">${ir ? 'iRacing' : 'VBOX'}</i>
          </div>
          <div class="gmeta">
            <span>最快 <b>${a.best_time != null ? a.best_time.toFixed(2) + 's' : '-'}</b></span>
            <span>圈数 <b>${a.full.length}</b></span>
            <span>极速 <b>${a.vmax.toFixed(0)}</b> km/h</span>
            <span>最高G <b>${a.corners.length ? Math.max(...a.corners.map(c => c.max_g)).toFixed(2) : '-'}</b></span>
            <span class="gdate">${esc(s.date)}</span>
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
    }).join('');
    list.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.del;
        const s = SESSIONS.find(x => x.id === id);
        if (!confirm('删除「' + s.name + '」？此操作不可撤销。')) return;
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
    if (!item || e.target.closest('.gbtn')) return;
    const id = item.querySelector('[data-del]');
    if (id) { setCurSession(id.dataset.del); renderSessionBar(render); render(); }
  });

  document.addEventListener('DOMContentLoaded', () => {
    bootPage('index.html', render);
    setupUpload('fileInput', render);
  });
})();
