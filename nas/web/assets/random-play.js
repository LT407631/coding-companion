(function () {
  'use strict';
  var KEY = 'hg_random_preview_v1';
  var state = read();
  var busy = false;

  function empty() { return {context: null, trail: [], index: -1}; }
  function read() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(KEY));
      return saved && Array.isArray(saved.trail) ? saved : empty();
    } catch (_) { return empty(); }
  }
  function write() {
    try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }
  function context(value) {
    value = value || {};
    return {
      genre: ['short_play', 'comic_series', 'ai_series'].indexOf(value.genre) >= 0 ? value.genre : 'comic_series',
      order: value.order === 'hot' ? 'hot' : 'latest',
      theme: String(value.theme || '').slice(0, 80)
    };
  }
  function same(a, b) {
    return a && b && a.genre === b.genre && a.order === b.order && a.theme === b.theme;
  }
  function item(value) {
    return {
      series_id: String(value.series_id), title: String(value.title || ''), cover: String(value.cover || ''),
      episode_cnt: Math.max(1, Number(value.episode_cnt) || 1), category: String(value.category || '')
    };
  }
  function permanentExclusions() {
    var watch = window.CodingWatchState;
    if (!watch) return [];
    var values = [].concat(watch.hidden ? watch.hidden() : [], watch.favs ? watch.favs.all() : [], watch.hist ? watch.hist.all() : []);
    return values.map(function (value) { return String(value.sid || value.series_id || ''); }).filter(function (sid) { return /^\d{1,24}$/.test(sid); });
  }
  function exclusions(includeTrail) {
    var values = permanentExclusions();
    if (includeTrail !== false) values = values.concat(state.trail.map(function (value) { return value.series_id; }));
    return Array.from(new Set(values)).slice(-300);
  }
  async function request(includeTrail) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 30000);
    try {
      var response = await fetch('/library/random', {
        method: 'POST', cache: 'no-store', signal: ctl.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(Object.assign({}, state.context, {exclude: exclusions(includeTrail)}))
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.detail || '暂时无法随机选剧');
      if (!data.item || !/^\d{1,24}$/.test(String(data.item.series_id))) throw new Error('随机片单返回异常');
      return item(data.item);
    } finally { clearTimeout(timer); }
  }
  function show(value, replace) {
    var hash = '#/watch/' + encodeURIComponent(value.series_id) + '/1/random';
    if (replace) { history.replaceState({codingRoute: true}, '', hash); route(); }
    else go(hash);
  }
  async function start(value, button) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    try {
      await window.CodingWatchState.ready();
      var nextContext = context(value);
      if (!same(state.context, nextContext)) state = empty();
      state.context = nextContext;
      var selected = await request(true).catch(async function (error) {
        if (!state.trail.length) throw error;
        return request(false);
      });
      state.trail = [selected]; state.index = 0; write(); show(selected, false);
    } catch (error) { toast(error.message || '暂时无法随机选剧'); }
    finally { busy = false; if (button && button.isConnected) button.disabled = false; }
  }
  async function shift(direction) {
    if (busy || !active()) return;
    direction = direction < 0 ? -1 : 1;
    var target = state.index + direction;
    if (state.trail[target]) { state.index = target; write(); show(state.trail[target], true); return; }
    busy = true; status(direction < 0 ? '正在找上一部…' : '正在换一部…');
    try {
      var selected = await request(true).catch(function () { return request(false); });
      if (direction < 0) { state.trail.unshift(selected); state.index = 0; }
      else { state.trail.push(selected); state.index = state.trail.length - 1; }
      if (state.trail.length > 60) {
        var trim = state.index > 30 ? state.index - 30 : 0;
        state.trail = state.trail.slice(trim, trim + 60); state.index -= trim;
      }
      write(); show(selected, true);
    } catch (error) { status(error.message || '换剧失败，请重试', true); }
    finally { busy = false; }
  }
  function current() { return state.trail[state.index] || null; }
  function active() { return /^#\/watch\/\d+\/1\/random$/.test(location.hash); }
  function status(message, error) {
    if (error) toast(message);
  }
  function controls() {
    return '<section class="random-preview" aria-label="随机试看">' +
      '<div class="random-actions"><button class="ghost random-prev" type="button">↑ 上一部</button>' +
      '<button class="btn-pink random-accept" type="button">喜欢，继续看</button>' +
      '<button class="ghost random-next" type="button">↓ 换一部</button></div></section>';
  }
  function resume(sid) {
    sid = String(sid);
    var index = state.trail.findIndex(function (value) { return value.series_id === sid; });
    if (index < 0) {
      state.context = state.context || context();
      var w = typeof W === 'undefined' ? null : W;
      state.trail.push(item({series_id: sid, title: w && w.title, cover: w && w.cover, episode_cnt: w && w.eps && w.eps.length}));
      index = state.trail.length - 1;
    }
    state.index = index; write();
  }
  function bind(w) {
    var stage = document.querySelector('#stage'), previous = document.querySelector('.random-prev');
    var next = document.querySelector('.random-next'), acceptButton = document.querySelector('.random-accept');
    if (!stage || !previous || !next || !acceptButton) return;
    previous.onclick = function () { shift(-1); };
    next.onclick = function () { shift(1); };
    acceptButton.onclick = function () { accept(w); };
    var startY = null;
    stage.addEventListener('touchstart', function (event) { startY = event.touches && event.touches[0] ? event.touches[0].clientY : null; }, {passive: true});
    stage.addEventListener('touchend', function (event) {
      if (startY === null || !event.changedTouches || !event.changedTouches[0]) return;
      var delta = event.changedTouches[0].clientY - startY; startY = null;
      if (Math.abs(delta) >= 70) shift(delta > 0 ? -1 : 1);
    }, {passive: true});
  }
  function ended(w) {
    var button = document.querySelector('.random-accept');
    if (button) button.textContent = w.eps.length > 1 ? '喜欢，继续第2集' : '喜欢，查看剧集';
    status('第1集已播完；喜欢就继续，或按↓换一部');
  }
  function accept(w) {
    if (!w || !w.random || !w.sid) return;
    var video = w.video, duration = Number(video && video.duration) || 0, position = Number(video && video.currentTime) || 0;
    var finished = !!(duration && (video.ended || position >= duration - 0.5));
    var selected = current() || {};
    CodingWatchState.hist.put({
      sid: String(w.sid), title: w.title || selected.title || '', cover: w.cover || selected.cover || '',
      ep: 1, epCnt: w.eps.length, pos: finished ? duration : Math.min(position, duration || position), dur: duration, finished: finished
    });
    var hash = finished && w.eps.length > 1 ? '#/watch/' + w.sid + '/2/0' :
      finished ? '#/detail/' + w.sid : '#/watch/' + w.sid + '/1/' + Math.max(0, Math.floor(position));
    history.replaceState({codingRoute: true}, '', hash); route();
  }
  function key(event) {
    if (!active() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    var target = event.target;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Enter') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Enter') accept(typeof W === 'undefined' ? null : W);
    else shift(event.key === 'ArrowUp' ? -1 : 1);
  }
  document.addEventListener('keydown', key, true);
  window.CodingRandomPlay = {start: start, shift: shift, controls: controls, resume: resume, bind: bind, ended: ended, accept: accept, active: active};
})();
