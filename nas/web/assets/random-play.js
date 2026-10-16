(function () {
  'use strict';
  var KEY = 'hg_random_preview_v1';
  var POOL_SIZE = 10;
  var state = read();
  var busy = false, refillPromise = null, transitionFrame = '', transitionCover = false, handoff = null;
  var poolToken = token(), poolGeneration = 0, poolActive = 0, poolQueue = [];
  var poolClients = new Map(), poolWanted = new Set(), prepared = new Map();

  function empty() { return {context: null, trail: [], index: -1}; }
  function token() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
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
  function currentContext() {
    var genre = localStorage.getItem('hg_genre') || 'comic_series';
    return context({
      genre: genre,
      order: localStorage.getItem('hg_library_order') || 'latest',
      theme: localStorage.getItem('hg_library_theme_' + genre) || ''
    });
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
  async function request(includeTrail, count) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 30000);
    try {
      var response = await fetch('/library/random', {
        method: 'POST', cache: 'no-store', signal: ctl.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(Object.assign({}, state.context, {exclude: exclusions(includeTrail), count: Math.max(1, Math.min(POOL_SIZE, count || 1))}))
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.detail || '暂时无法随机选剧');
      var rows = Array.isArray(data.items) ? data.items : data.item ? [data.item] : [];
      var seen = new Set();
      rows = rows.filter(function (value) {
        var sid = String(value && value.series_id || '');
        if (!/^\d{1,24}$/.test(sid) || seen.has(sid)) return false;
        seen.add(sid); return true;
      }).map(item);
      if (!rows.length) throw new Error('随机片单返回异常');
      return rows;
    } finally { clearTimeout(timer); }
  }
  function show(value, replace) {
    var hash = '#/watch/' + encodeURIComponent(value.series_id) + '/1/random';
    if (replace) { history.replaceState({codingRoute: true}, '', hash); route(); }
    else go(hash);
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  async function json(path, options, timeout) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, timeout || 30000);
    try {
      var response = await fetch(path, Object.assign({cache: 'no-store', signal: ctl.signal}, options || {}));
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.detail || '缓存服务连接失败');
      return data;
    } finally { clearTimeout(timer); }
  }
  function post(path, body) {
    return json(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}, 30000);
  }
  function closeHandoff() {
    if (handoff) closeClient(handoff.client);
    handoff = null;
  }
  async function ensureReady(value) {
    var sid = value.series_id, client = 'random-switch-' + poolToken + '-' + sid;
    closeHandoff();
    var body = {client: client, series_id: sid, ep: 1, completed: 0, retry: false, preview: true, background: false};
    var metadata = json('/episodes?series_id=' + encodeURIComponent(sid), {}, 30000).then(function (data) {
      return {data: data};
    }).catch(function (error) { return {error: error}; });
    try {
      var data = await post('/playback/prepare', body), retried = false, deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        var current = data && data.current || {};
        if (current.state === 'ready') {
          var result = await metadata;
          if (result.error) throw result.error;
          if (!result.data || !Array.isArray(result.data.episodes) || !result.data.episodes.length) throw new Error('暂时无法取得这部剧的选集信息');
          prepared.set(sid, result.data); handoff = {sid: sid, client: client}; return;
        }
        if (current.state === 'error') {
          if (retried) throw new Error(current.message || '这部剧暂时无法播放');
          retried = true; body.retry = true; data = await post('/playback/prepare', body); continue;
        }
        await sleep(500);
        data = await json('/playback/status?series_id=' + encodeURIComponent(sid) + '&ep=1', {}, 10000);
      }
      throw new Error('下一部准备超时，已保留当前播放');
    } catch (error) {
      closeClient(client);
      throw error;
    }
  }
  function captureFrame() {
    var before = current();
    transitionFrame = before && before.cover || ''; transitionCover = !!transitionFrame;
    var video = document.querySelector('#video');
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    try {
      var canvas = document.createElement('canvas'), width = Math.min(1280, video.videoWidth);
      canvas.width = width; canvas.height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      transitionFrame = canvas.toDataURL('image/jpeg', 0.85); transitionCover = false;
    } catch (_) {}
  }
  function attr(value) { return String(value || '').replace(/[&"'<>]/g, function (char) { return {'&':'&amp;','"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'}[char]; }); }
  function frame() { return transitionFrame ? '<img class="random-transition-frame' + (transitionCover ? ' random-transition-cover' : '') + '" src="' + attr(transitionFrame) + '" alt="">' : ''; }
  function clearFrame() {
    var image = document.querySelector('.random-transition-frame');
    if (image && image.parentNode) image.parentNode.removeChild(image);
    transitionFrame = ''; transitionCover = false;
  }
  function takePrepared(sid) { var value = prepared.get(String(sid)); prepared.delete(String(sid)); return value || null; }
  function closeClient(client) {
    if (!client) return;
    var body = JSON.stringify({client: client, finished: false});
    if (navigator.sendBeacon) navigator.sendBeacon('/playback/close', new Blob([body], {type: 'application/json'}));
    else fetch('/playback/close', {method: 'POST', keepalive: true, headers: {'Content-Type': 'application/json'}, body: body}).catch(function () {});
  }
  function closePool() {
    poolGeneration++; poolWanted = new Set(); poolQueue = [];
    poolClients.forEach(function (entry) { closeClient(entry.client); });
    poolClients.clear(); poolToken = token();
  }
  function poolClient(sid) { return 'random-pool-' + poolToken + '-' + sid; }
  function queuePool(value) {
    var sid = value.series_id, existing = poolClients.get(sid), now = Date.now();
    if (existing && now - existing.last < 300000) return;
    var entry = existing || {client: poolClient(sid), last: 0};
    entry.last = now; poolClients.set(sid, entry);
    poolQueue.push({sid: sid, client: entry.client, generation: poolGeneration});
    pumpPool();
  }
  function pumpPool() {
    while (poolActive < 2 && poolQueue.length) {
      var job = poolQueue.shift();
      if (job.generation !== poolGeneration || !poolWanted.has(job.sid)) continue;
      poolActive++;
      (function (currentJob) {
        var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 30000);
        fetch('/playback/prepare', {
          method: 'POST', cache: 'no-store', signal: ctl.signal,
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({client: currentJob.client, series_id: currentJob.sid, ep: 1, completed: 0,
            retry: false, preview: true, background: true})
        }).catch(function () {}).finally(function () {
          clearTimeout(timer); poolActive--;
          if (currentJob.generation !== poolGeneration || !poolWanted.has(currentJob.sid)) closeClient(currentJob.client);
          pumpPool();
        });
      })(job);
    }
  }
  function syncPool(startBackground) {
    if (!active()) return;
    var desired = state.trail.slice(state.index + 1, state.index + POOL_SIZE);
    poolWanted = new Set(desired.map(function (value) { return value.series_id; }));
    poolClients.forEach(function (entry, sid) {
      if (!poolWanted.has(sid)) { closeClient(entry.client); poolClients.delete(sid); }
    });
    if (startBackground) desired.forEach(queuePool);
  }
  function refill() {
    if (refillPromise || !active()) return refillPromise;
    var missing = POOL_SIZE - Math.max(0, state.trail.length - state.index);
    if (missing <= 0) return null;
    var generation = poolGeneration;
    refillPromise = request(true, missing).then(function (rows) {
      if (generation !== poolGeneration || !active()) return;
      var known = new Set(state.trail.map(function (value) { return value.series_id; }));
      rows.forEach(function (value) { if (!known.has(value.series_id)) { state.trail.push(value); known.add(value.series_id); } });
      write(); syncPool(false);
    }).catch(function () {}).finally(function () { refillPromise = null; });
    return refillPromise;
  }
  async function start(value, button) {
    if (busy) return;
    busy = true;
    if (button) button.setAttribute('aria-busy', 'true');
    try {
      await window.CodingWatchState.ready();
      var nextContext = context(value);
      if (!same(state.context, nextContext)) state = empty();
      closePool(); state.context = nextContext;
      var selected = await request(true, POOL_SIZE).catch(async function (error) {
        if (!state.trail.length) throw error;
        return request(false, POOL_SIZE);
      });
      state.trail = selected; state.index = 0; write(); show(selected[0], false); syncPool(false);
    } catch (error) { toast(error.message || '暂时无法随机选剧'); }
    finally { busy = false; if (button && button.isConnected) button.removeAttribute('aria-busy'); }
  }
  function startCurrent(button) { return start(currentContext(), button); }
  async function shift(direction) {
    if (busy || !active()) return;
    direction = direction < 0 ? -1 : 1;
    var target = state.index + direction;
    busy = true;
    try {
      var selected = state.trail[target];
      if (!selected) {
        selected = (await request(true, 1).catch(function () { return request(false, 1); }))[0];
        if (direction < 0) { state.trail.unshift(selected); target = 0; }
        else { state.trail.push(selected); target = state.trail.length - 1; }
      }
      await ensureReady(selected);
      captureFrame(); state.index = target;
      if (state.trail.length > 60) {
        var trim = state.index > 30 ? state.index - 30 : 0;
        state.trail = state.trail.slice(trim, trim + 60); state.index -= trim;
      }
      write(); show(selected, true); syncPool(false); refill();
    } catch (error) { status(error.message || '换剧失败，已保留当前播放', true); }
    finally { busy = false; }
  }
  function current() { return state.trail[state.index] || null; }
  function active() { return /^#\/watch\/\d+\/1\/random$/.test(location.hash); }
  function status(message, error) { if (error) toast(message); }
  function controls() {
    return '<section class="random-preview" aria-label="随机试看"><div class="random-actions">' +
      '<button class="ghost random-prev" type="button">↑ 上一部</button>' +
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
    state.index = index; write(); syncPool(false); refill();
  }
  function bind(w) {
    var stage = document.querySelector('#stage'), previous = document.querySelector('.random-prev');
    var next = document.querySelector('.random-next'), acceptButton = document.querySelector('.random-accept');
    if (!stage || !previous || !next || !acceptButton) return;
    previous.onclick = function () { shift(-1); };
    next.onclick = function () { shift(1); };
    acceptButton.onclick = function () { accept(w); };
    var startY = null, wheelAt = 0;
    stage.addEventListener('wheel', function (event) {
      var vertical = Number(event.deltaY) || 0;
      if (Math.abs(vertical) < 10 || Math.abs(vertical) < Math.abs(Number(event.deltaX) || 0)) return;
      event.preventDefault(); event.stopPropagation();
      if (Date.now() - wheelAt < 700) return;
      wheelAt = Date.now(); shift(vertical < 0 ? -1 : 1);
    }, {passive: false});
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
    closePool();
    var hash = finished && w.eps.length > 1 ? '#/watch/' + w.sid + '/2/0' :
      finished ? '#/detail/' + w.sid : '#/watch/' + w.sid + '/1/' + Math.max(0, Math.floor(position));
    history.replaceState({codingRoute: true}, '', hash); route();
  }
  function routeState(isRandom) { if (!isRandom) { closePool(); closeHandoff(); clearFrame(); } }
  function foregroundReady(sid) {
    if (handoff && handoff.sid === String(sid || '')) closeHandoff();
    syncPool(true);
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
  window.addEventListener('pagehide', closePool);
  window.CodingRandomPlay = {start: start, startCurrent: startCurrent, shift: shift, controls: controls, frame: frame,
    takePrepared: takePrepared,
    clearFrame: clearFrame, resume: resume, bind: bind, ended: ended, accept: accept, active: active, route: routeState,
    foregroundReady: foregroundReady};
})();
