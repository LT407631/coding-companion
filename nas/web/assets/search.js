(function () {
  'use strict';
  var active = null, views = new Map();
  function empty() { return {items: [], seen: new Set(), cursor: '', more: true, restart: false, loaded: false, scroll: 0, focus: '', created: Date.now()}; }
  function remember(query, state) {
    views.delete(query);
    if (state.items.length <= 400) views.set(query, state);
    while (views.size > 2) views.delete(views.keys().next().value);
  }
  function stop() {
    if (!active) return;
    active.state.scroll = window.scrollY;
    var card = document.activeElement && document.activeElement.closest('.search-grid .card');
    active.state.focus = card && active.root.contains(card) ? card.dataset.sid : '';
    remember(active.query, active.state);
    if (active.controller) active.controller.abort();
    clearTimeout(active.restoreTimer); active = null;
  }
  function mount(root, query, options) {
    stop();
    var state = views.get(query);
    if (!state || Date.now() - state.created > 300000) state = empty();
    var current = {root: root, query: query, state: state, busy: false, expired: !!state.restart, controller: null};
    active = current;
    root.innerHTML = '<div class="sechead"><h2>“' + options.esc(query) + '” 的搜索结果</h2></div>' +
      '<div id="sbox"><div class="grid search-grid"></div><div class="empty search-empty" hidden>暂无内容</div></div>' +
      '<div class="library-footer"><span class="note search-status" role="status" aria-live="polite"></span><button class="ghost search-more" type="button">加载更多</button></div>';
    var grid = root.querySelector('.search-grid'), more = root.querySelector('.search-more'), note = root.querySelector('.search-status');
    function live() { return active === current && grid.isConnected; }
    function status(error) {
      grid.hidden = !state.items.length;
      root.querySelector('.search-empty').hidden = !state.loaded || !!state.items.length || current.busy || !!error;
      note.textContent = error || (current.busy ? (state.loaded ? '正在加载更多…' : '正在搜索…') : current.expired ? '显示已缓存结果，重新搜索可检查最新内容' : state.more ? '已显示 ' + state.items.length + ' 部，可加载更多' : state.items.length ? '已显示全部 ' + state.items.length + ' 部' : '');
      more.hidden = !state.more && !error && !current.expired;
      more.setAttribute('aria-disabled', String(current.busy));
      more.textContent = current.expired ? '重新搜索' : error ? '重试加载' : current.busy ? '加载中…' : '加载更多';
    }
    function append(items) { if (items.length) grid.insertAdjacentHTML('beforeend', items.map(function(item) { return options.cardHTML(item); }).join('')); }
    async function load() {
      if (!live() || current.busy || !state.more) return;
      var footerFocused = document.activeElement === more;
      current.busy = true; current.controller = new AbortController(); status();
      var cursor = state.cursor;
      try {
        var params = new URLSearchParams({q: query}); if (cursor) params.set('cursor', cursor);
        var data = await options.api('/search/page?' + params, {signal: current.controller.signal});
        if (!live()) return;
        if (data.query !== query || !Array.isArray(data.results) || (data.has_more && (typeof data.next_cursor !== 'string' || data.next_cursor.length !== 64 || data.next_cursor === cursor))) throw new Error('搜索分页异常，请重新搜索');
        var added = data.results.filter(function(item) {
          var id = String(item.series_id || ''); if (!id || state.seen.has(id)) return false;
          state.seen.add(id); return true;
        });
        state.items.push.apply(state.items, added); state.cursor = data.next_cursor || ''; state.more = !!data.has_more; state.restart = !!data.restart_required; state.loaded = true; current.expired = state.restart;
        options.remember(query, state.items); append(added); current.busy = false; status();
        if (more.hidden && footerFocused && (document.activeElement === more || document.activeElement === document.body) && state.items.length) {
          var cards = grid.querySelectorAll('.card'), target = cards[Math.max(0, cards.length - Math.max(1, added.length))];
          target.tabIndex = 0; target.focus({preventScroll: true});
        }
      } catch (error) {
        if (!live()) return;
        current.busy = false; current.expired = error.status === 410; state.restart = current.expired;
        status(current.expired ? '搜索缓存已更新，请重新搜索；已显示结果仍可打开' : error.message || '搜索失败，请重试');
      } finally { if (live()) current.controller = null; }
    }
    more.onclick = function() {
      if (current.busy) return;
      if (current.expired) { stop(); views.delete(query); mount(root, query, options); }
      else load();
    };
    append(state.items); status();
    if (state.loaded) {
      options.remember(query, state.items);
      current.restoreTimer = setTimeout(function() {
        if (!live()) return;
        window.scrollTo(0, state.scroll);
        if (state.focus && document.documentElement.classList.contains('coding-tv')) {
          var card = Array.from(grid.querySelectorAll('.card')).find(function(item) { return item.dataset.sid === state.focus; });
          if (card) card.focus({preventScroll: true});
        }
      }, 80);
    } else load();
  }
  window.CodingSearch = {mount: mount, stop: stop};
})();
