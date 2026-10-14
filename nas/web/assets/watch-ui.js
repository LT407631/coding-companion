(function () {
  'use strict';
  var updates = {}, refreshAt = 0, hiddenPage = 0;
  var state = window.CodingWatchState;
  function filter() {
    var excluded = new Set(state.hidden().map(function(v) { return v.sid; }));
    return function(items) { return items.filter(function(v) { return !excluded.has(String(v.series_id || v.sid)); }); };
  }
  function resume(rec) { return rec.finished && rec.ep < rec.epCnt ? rec.ep + 1 : rec.ep; }
  function play(sid, ep) {
    if (document.documentElement.classList.contains('coding-tv')) document.documentElement.classList.add('tv-fullscreen');
    go('#/watch/' + sid + '/' + ep);
  }
  function homeHTML() {
    var records = filter()(state.hist.all()).filter(function(v) { return !v.finished || v.ep < v.epCnt; }).slice(0, 6);
    return '<section class="watch-home"><div class="watch-heading"><h2>继续观看</h2><button class="ghost" id="watch-refresh">刷新记录</button><a class="ghost watch-follow-link" href="#/fav">收藏追更</a><span class="note watch-sync">' + esc(state.status()) + '</span></div>' +
      '<div class="watch-resumes">' + (records.map(function(rec) { return '<button class="watch-resume" data-sid="' + rec.sid + '" data-ep="' + resume(rec) + '"><img loading="lazy" src="' + esc(imgx(rec.cover)) + '" alt="" onerror="this.remove()"><span><b>' + esc(rec.title) + '</b><small>第' + resume(rec) + '集' + (!rec.finished && rec.pos ? ' · ' + fmtT(rec.pos) : '') + '</small></span></button>'; }).join('') || '<span class="note">观看后，这里会显示最近的剧集。</span>') + '</div></section>';
  }
  function bindHome(root) {
    var section = root.querySelector('.watch-home'); if (!section) return; checkUpdates();
    section.querySelectorAll('.watch-resume').forEach(function(button) { button.onclick = function() { play(button.dataset.sid, button.dataset.ep); }; });
    var button = section.querySelector('#watch-refresh');
    button.onclick = async function() {
      button.disabled = true; await state.sync();
      if (!section.isConnected) return;
      var box = document.createElement('div'); box.innerHTML = homeHTML(); section.replaceWith(box.firstElementChild); bindHome(root);
      root.querySelector('#watch-refresh').focus({preventScroll: true});
    };
  }
  function badge(sid) { var n = updates[String(sid)]; return n && n.new > 0 ? '<span class="watch-badge">新增' + n.new + '集</span>' : ''; }
  function decorate() {
    var link = document.querySelector('.watch-follow-link'), count = Object.keys(updates).filter(function(sid) { return updates[sid].new > 0; }).length; if (link) link.textContent = count ? '追剧更新 · ' + count + '部' : '收藏追更';
    if (location.hash === '#/fav') document.querySelectorAll('#view .card[data-sid]').forEach(function(card) {
      var old = card.querySelector('.watch-badge'), text = badge(card.dataset.sid);
      if (old) old.remove(); if (text) card.querySelector('.poster').insertAdjacentHTML('beforeend', text);
    });
  }
  async function checkUpdates() {
    if (Date.now() - refreshAt < 60000) return;
    refreshAt = Date.now();
    try {
      await state.ready();
      var options = {headers: {'X-Watch-Profile': state.profile()}}, result = await api('/watch-updates', options); updates = result.items || {}; decorate();
      if (result.checking) setTimeout(async function() { try { var d = await api('/watch-updates', options); updates = d.items || {}; decorate(); } catch (_) {} }, 4000);
    } catch (_) {}
  }
  function detail(sid, meta, episodes) {
    var buttons = document.querySelector('.hbtns'); if (!buttons) return;
    var item = {sid: String(sid), title: meta.title, cover: meta.cover, epCnt: episodes.length};
    var rec = state.hist.get(sid), next = rec ? resume(Object.assign({}, rec, {epCnt: episodes.length})) : 1;
    if (rec && rec.finished && next > rec.ep) {
      var first = buttons.querySelector('.btn-pink'); first.textContent = '继续看 第' + next + '集'; first.onclick = function() { play(sid, next); };
    }
    var holder = document.createElement('span'); holder.className = 'watch-hide-actions'; buttons.appendChild(holder);
    function render() {
      var saved = state.hidden().find(function(v) { return v.sid === String(sid); });
      holder.innerHTML = saved ? '<button class="ghost watch-restore">恢复首页显示</button>' : '<button class="ghost" data-reason="finished">已看完并隐藏</button><button class="ghost" data-reason="dislike">不感兴趣</button>';
      holder.querySelectorAll('[data-reason]').forEach(function(b) { b.onclick = function() { state.hide(item, b.dataset.reason); render(); holder.querySelector('button').focus({preventScroll: true}); toast('首页已隐藏，可在设置中恢复'); }; });
      var restore = holder.querySelector('.watch-restore'); if (restore) restore.onclick = function() { state.restore(sid); render(); holder.querySelector('button').focus({preventScroll: true}); toast('已恢复首页显示'); };
    }
    render();
  }
  function settings() {
    var view = document.querySelector('#view'); if (!view) return;
    var box = document.createElement('section'); box.className = 'setbox watch-settings';
    box.innerHTML = '<h3>观看记录与首页偏好</h3><p class="note">同一家庭用户在不同设备间同步进度和收藏，离线时先保存在本机。</p><p class="note watch-sync"></p><button class="ghost watch-sync-now">立即同步</button> <button class="ghost watch-hidden-toggle" aria-expanded="false">管理首页隐藏</button><div class="watch-hidden-list" hidden></div>';
    view.appendChild(box); box.querySelector('.watch-sync').textContent = state.status();
    box.querySelector('.watch-sync-now').onclick = function() { state.sync(); };
    box.querySelector('.watch-hidden-toggle').onclick = function() { var list = box.querySelector('.watch-hidden-list'); list.hidden = !list.hidden; this.setAttribute('aria-expanded', String(!list.hidden)); if (!list.hidden) { hiddenPage = 0; renderHidden(list); } };
  }
  function renderHidden(list) {
    var records = state.hidden(); hiddenPage = Math.min(hiddenPage, Math.max(0, Math.ceil(records.length / 20) - 1));
    list.innerHTML = records.slice(hiddenPage * 20, hiddenPage * 20 + 20).map(function(v) { return '<div class="watch-hidden-row"><span>' + esc(v.title) + ' · ' + (v.reason === 'finished' ? '已看完' : '不感兴趣') + '</span><button class="ghost" data-restore="' + v.sid + '">恢复显示</button></div>'; }).join('') || '<p class="note">没有隐藏的剧集</p>';
    if (records.length > 20) list.insertAdjacentHTML('beforeend', '<div class="watch-hidden-pages"><button class="ghost" data-page="-1" '+(!hiddenPage?'disabled':'')+'>上一页</button><span>'+(hiddenPage+1)+' / '+Math.ceil(records.length/20)+'</span><button class="ghost" data-page="1" '+((hiddenPage+1)*20>=records.length?'disabled':'')+'>下一页</button></div>');
    list.querySelectorAll('[data-restore]').forEach(function(b) { b.onclick = function() { state.restore(b.dataset.restore); renderHidden(list); (list.querySelector('button:not(:disabled)') || document.querySelector('.watch-hidden-toggle')).focus({preventScroll:true}); }; });
    list.querySelectorAll('[data-page]').forEach(function(b) { b.onclick = function() { hiddenPage += Number(b.dataset.page); renderHidden(list); list.querySelector('button:not(:disabled)').focus({preventScroll:true}); }; });
  }
  function key(el, code, focus) {
    if (!el || !el.matches || !el.matches('.watch-resume')) return false;
    var row = Array.from(document.querySelectorAll('.watch-resume')), index = row.indexOf(el);
    if (code === 21 || code === 22) { focus(row[Math.max(0, Math.min(row.length - 1, index + (code === 21 ? -1 : 1)))]); return true; }
    if (code === 20) { focus(document.querySelector('.library-order.on')); return true; }
    if (code === 19) { focus(document.querySelector('.gtab.on') || document.querySelector('#q')); return true; }
    return false;
  }
  state.subscribe(function() { document.querySelectorAll('.watch-sync').forEach(function(el) { el.textContent = state.status(); }); });
  window.CodingWatchUI = {homeHTML: homeHTML, bindHome: bindHome, filter: filter, detail: detail, settings: settings, badge: badge, checkUpdates: checkUpdates, key: key};
})();
