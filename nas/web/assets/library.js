(function () {
  'use strict';
  var active = null, views = new Map(), store = window.CodingLibraryStore;
  function compact(it) { return {series_id: String(it.series_id), title: it.title, cover: it.cover, category: it.category, hot: it.hot, play_cnt: it.play_cnt, score: it.score, episode_cnt: it.episode_cnt}; }
  function heat(it) {
    var text = String(it.hot || '').replace(/[,，\s]/g, '');
    var match = text.match(/^(\d+(?:\.\d+)?)(亿|万|千)?(?:热度|次播放|播放)?$/);
    if (match) return Number(match[1]) * ({亿: 100000000, 万: 10000, 千: 1000}[match[2]] || 1);
    if (text) return -1;
    var count = Number(it.play_cnt);
    return Number.isFinite(count) && count >= 0 ? count : -1;
  }
  function empty() { return {items: [], cursor: '', more: true, loaded: false, seen: new Set(), scroll: 0, focus: '', created: Date.now()}; }
  function head(data) { return JSON.stringify([data.items.map(function(it) { return [String(it.series_id), it.title, it.cover, it.episode_cnt, it.hot]; }), data.next_cursor]); }
  function sameHead(previous, data) {
    var next = head(data);
    if (previous === next) return true;
    try {
      var oldItems = JSON.parse(previous)[0], newItems = JSON.parse(next)[0];
      // An 18-to-24 page-size upgrade must not reset a cached list or its scroll position.
      return oldItems.length > 0 && oldItems.length < newItems.length && JSON.stringify(oldItems) === JSON.stringify(newItems.slice(0, oldItems.length));
    } catch (_) { return false; }
  }
  function tv() { return document.documentElement.classList.contains('coding-tv'); }
  function save() {
    if (!active) return;
    active.state.scroll = window.scrollY;
    var card = document.activeElement && document.activeElement.closest('.library-grid .card');
    if (card && active.root.contains(card)) { active.state.focus = card.dataset.sid; active.state.offset = card.getBoundingClientRect().top; }
  }
  function stop() {
    save();
    if (active && active.controller) active.controller.abort();
    if (active && active.renderer) active.renderer.destroy();
    if (active) {
      active.scroller.destroy(); clearTimeout(active.saveTimer); clearTimeout(active.restoreTimer);
      if (active.refreshController) active.refreshController.abort();
      if (!active.expired) store.write(active.key, active.fresh || active.state);
    }
    active = null;
  }
  function remember(key, state) {
    views.delete(key); views.set(key, state);
    while (views.size > 2) views.delete(views.keys().next().value);
  }
  function mount(root, options) {
    stop();
    var order = localStorage.getItem('hg_library_order') === 'hot' ? 'hot' : 'latest';
    var theme = localStorage.getItem('hg_library_theme_' + options.genre) || '';
    var themes = options.themes || [];
    if (!themes.some(function(t) { return t.name === theme; })) theme = '';
    function open(newOrder, newTheme, restore, selected) {
      stop(); order = newOrder; theme = newTheme;
      localStorage.setItem('hg_library_order', order);
      localStorage.setItem('hg_library_theme_' + options.genre, theme);
      var key = JSON.stringify([location.origin, options.genre, order, theme]);
      var state = views.get(key);
      if (!state || Date.now() - state.created > 300000) state = empty();
      remember(key, state);
      if (!restore || !state.loaded) window.scrollTo(0, 0);
      var esc = options.esc;
      root.innerHTML = '<section class="library" aria-label="首页剧集">' +
        '<div class="library-toolbar"><div class="library-orders" role="group" aria-label="剧集排序">' +
        ['latest', 'hot'].map(function(value) { return '<button class="ghost library-order' + (value === order ? ' on' : '') + '" data-order="' + value + '" aria-pressed="' + (value === order) + '">' + (value === 'latest' ? '最新上架' : '热门剧集') + '</button>'; }).join('') +
        '<button class="ghost library-refresh" hidden>发现新内容 · 刷新</button></div><span class="note library-count" aria-live="polite"></span></div>' +
        '<div class="chips library-themes"><button class="chip' + (!theme ? ' on' : '') + '" data-theme="">全部</button>' +
        themes.map(function(t) { return '<button class="chip' + (t.name === theme ? ' on' : '') + '" data-theme="' + esc(t.name) + '">' + esc(t.name) + '</button>'; }).join('') + '</div>' +
        '<div class="grid library-grid"></div><div class="library-footer"><span class="note library-status" role="status"></span><button class="ghost library-more">继续浏览</button></div></section>';
      var current = {root: root, state: state, busy: false, anchor: null, error: false, controller: null, renderer: null, scroller: window.CodingLibraryScroll(), key: key, saveTimer: 0, hydrating: !state.loaded, filter: window.CodingWatchUI ? CodingWatchUI.filter() : function(items) { return items; }};
      active = current; if (window.CodingWatchUI) CodingWatchUI.checkUpdates();
      var grid = root.querySelector('.library-grid'), more = root.querySelector('.library-more');
      function render() {
        var focused = document.activeElement && document.activeElement.closest('.library-grid .card');
        var sid = focused && grid.contains(focused) ? focused.dataset.sid : '';
        current.display = current.filter(state.items).slice();
        if (order === 'hot') current.display.sort(function(a, b) { return heat(b) - heat(a); });
        var first = current.renderer.plan().first;
        // Some upstream rank pages remain 18 items. Join pages before the first non-empty grid.
        current.renderer.set(current.display.length >= first || !state.more || current.initialReady ? current.display : []);
        if (current.display.length >= first || !state.more) current.initialReady = true;
        if (sid && !grid.contains(focused)) {
          var index = current.display.findIndex(function(it) { return String(it.series_id) === sid; });
          var target = current.renderer.at(index);
          if (target) target.focus({preventScroll: true});
        }
      }
      function live() { return active === current && root.contains(grid); }
      current.renderer = window.CodingLibraryGrid(grid, {html: options.cardHTML, cover: options.cover, more: function(plan) { prepare(plan); }});
      function prepare(plan) {
        if (!live() || current.error || current.hydrating || current.refreshing || current.busy || !state.more) return;
        plan = plan || current.renderer.plan();
        if (!current.target || current.screen !== plan.screen) {
          current.screen = plan.screen;
          current.target = Math.max(plan.first, plan.end + plan.screen * 2);
        } else if (current.display.length >= current.target && plan.end >= current.target - plan.screen) {
          // Half of the two-screen reserve has been consumed: refill by two screens.
          current.target = Math.max(current.target + plan.screen * 2, plan.end + plan.screen * 2);
        }
        if (current.display.length < current.target) load();
      }
      function persist() {
        clearTimeout(current.saveTimer);
        current.saveTimer = setTimeout(function() { if (live()) { save(); store.write(key, current.fresh || state); } }, 700);
      }
      function focusIndex(index) {
        var target = current.renderer.at(index);
        if (!target) return;
        clearTimeout(current.restoreTimer); current.scroller.focus(target); persist();
      }
      current.focusIndex = focusIndex;
      function status(error) {
        root.querySelector('.library-count').textContent = state.items.length ? '已显示 ' + state.items.length + ' 部' : '';
        root.querySelector('.library-status').textContent = error || (current.busy ? '正在加载更多剧集…' : !state.more ? (state.items.length ? '已经浏览完当前片单' : '当前分类暂无剧集') : '继续往下，发现更多剧集');
        more.hidden = !state.more && !error;
        more.textContent = current.expired ? '重新加载片单' : error ? '重试加载' : current.busy ? '加载中…' : '继续浏览';
        more.setAttribute('aria-disabled', String(current.busy));
      }
      function moveAnchor() {
        var origin = current.anchor;
        current.anchor = null;
        if (!origin || document.activeElement !== origin) return;
        var index = Number(origin.dataset.index), cols = current.renderer.columns();
        if (index + cols < current.display.length) focusIndex(index + cols);
        else if (Math.floor(index / cols) < Math.floor((current.display.length - 1) / cols)) focusIndex(current.display.length - 1);
      }
      async function load() {
        if (!live() || current.hydrating || current.refreshing || current.busy || current.expired || !state.more) return;
        current.busy = true; current.error = false; current.controller = new AbortController(); status();
        var footerFocused = document.activeElement === more;
        try {
          var params = new URLSearchParams({genre: options.genre, order: order, theme: theme});
          if (state.cursor) params.set('cursor', state.cursor);
          var data = await options.api('/library?' + params, {revalidate: true, signal: current.controller.signal});
          if (!live()) return;
          if (!Array.isArray(data.items) || (data.has_more && (!data.next_cursor || data.next_cursor === state.cursor))) throw new Error('分页异常，请重新打开首页');
          if (!state.loaded) state.head = head(data);
          var added = data.items.filter(function(it) { var id = String(it.series_id); if (state.seen.has(id)) return false; state.seen.add(id); return true; });
          added.forEach(function(it) { state.items.push(compact(it)); }); state.cursor = data.next_cursor || ''; state.more = !!data.has_more; state.loaded = true;
          render(); current.busy = false; status(); moveAnchor(); persist();
          if (footerFocused && document.activeElement === more && added.length) {
            focusIndex(Math.max(0, current.display.length - added.length));
          }

        } catch (error) {
          if (!live()) return;
          current.busy = false; current.anchor = null; current.error = true;
          current.expired = (error.message || '').includes('片单已更新');
          status(error.message || '加载失败，请重试');
        } finally { current.controller = null; }
      }
      current.load = load;
      render(); status();
      more.addEventListener('click', async function() {
        if (current.expired) { if (current.resetting) return; current.resetting = true; views.delete(key); await store.remove(key); if (live()) open(order, theme, false, '.library-orders .on'); }
        else load();
      });
      root.querySelectorAll('[data-order]').forEach(function(button) {
        button.addEventListener('click', function() { if (button.dataset.order !== order) open(button.dataset.order, theme, false, '[data-order="' + button.dataset.order + '"]'); });
      });
      root.querySelectorAll('[data-theme]').forEach(function(button, index) {
        button.addEventListener('click', function() { if (button.dataset.theme !== theme) open(order, button.dataset.theme, false, '.library-themes button:nth-child(' + (index + 1) + ')'); });
      });
      root.querySelector('.library-refresh').onclick = function() {
        if (!current.fresh) return;
        remember(key, current.fresh); open(order, theme, false, '.library-order.on');
      };
      async function refresh() {
        current.refreshing = true; current.refreshController = new AbortController();
        try {
          var params = new URLSearchParams({genre: options.genre, order: order, theme: theme});
          var data = await options.api('/library?' + params, {revalidate: true, signal: current.refreshController.signal});
          if (!live() || !Array.isArray(data.items) || (data.has_more && !data.next_cursor)) return;
          if (sameHead(state.head, data)) { state.head = head(data); state.created = Date.now(); persist(); return; }
          var fresh = empty();
          fresh.items = data.items.map(compact); fresh.seen = new Set(data.items.map(function(it) { return String(it.series_id); }));
          fresh.cursor = data.next_cursor || ''; fresh.more = !!data.has_more; fresh.loaded = true; fresh.head = head(data);
          current.fresh = fresh; remember(key, fresh); store.write(key, fresh);
          root.querySelector('.library-refresh').hidden = false;
        } catch (_) { /* Cached rows remain usable during an outage. */ }
        finally { current.refreshing = false; if (live()) render(); }
      }
      function resume() {
        if (!live()) return;
        current.hydrating = false;
        render(); status();
        if (state.loaded) {
          if (restore) current.restoreTimer = setTimeout(function() {
            if (!live()) return;
            var index = current.display.findIndex(function(it) { return it.series_id === state.focus; });
            var target = index >= 0 && tv() ? current.renderer.at(index) : null;
            var position = target && Number.isFinite(state.offset) ? scrollY + target.getBoundingClientRect().top - state.offset : state.scroll;
            window.scrollTo(0, position);
            if (target) target.focus({preventScroll: true});
            render();
          }, 80);
          refresh();
        } else load();
        if (selected && tv()) setTimeout(function() { if (live()) root.querySelector(selected).focus({preventScroll: true}); }, 40);
      }
      if (state.loaded) resume();
      else store.read(key).then(function(cached) {
        if (!live()) return;
        if (cached) {
          state = Object.assign(empty(), cached, {loaded: true, seen: new Set(cached.items.map(function(it) { return it.series_id; }))});
          current.state = state; remember(key, state);
        }
        resume();
      });
    }
    open(order, theme, true);
  }
  function key(el, code, focus) {
    if (!active || !el || !el.closest) return false;
    var card = el.closest('.library-grid .card');
    if (!card || !active.root.contains(card)) return false;
    var index = Number(card.dataset.index), cols = active.renderer.columns(), total = active.display.length;
    if (code === 19) {
      if (index >= cols) { active.focusIndex(index - cols); return true; }
      active.scroller.cancel(); window.scrollTo(0, 0);
      focus(active.root.querySelector('.library-themes .on') || active.root.querySelector('.library-order.on'));
      return true;
    }
    if (code === 20) {
      if (index + cols < total) active.focusIndex(index + cols);
      else if (Math.floor(index / cols) < Math.floor((total - 1) / cols)) active.focusIndex(total - 1);
      else if (active.error) {
        var retry = active.root.querySelector('.library-more');
        if (focus) focus(retry); else { retry.focus({preventScroll: true}); retry.scrollIntoView({block: 'nearest'}); }
      } else if (active.state.more && !active.expired) { active.anchor = card; active.load(); }
      return true;
    }
    if (code === 21 && index % cols) { active.focusIndex(index - 1); return true; }
    if (code === 22) { if (index % cols < cols - 1 && index + 1 < total) active.focusIndex(index + 1); return true; }
    return false;
  }
  window.addEventListener('pagehide', function() { save(); if (active) { clearTimeout(active.saveTimer); if (!active.expired) store.write(active.key, active.fresh || active.state); } });
  // The published 1.0.14 APK still calls down() before geometric navigation.
  window.CodingLibrary = {mount: mount, stop: stop, key: key, down: function(el) { return key(el, 20); }};
})();
