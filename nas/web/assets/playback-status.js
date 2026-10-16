(function () {
  'use strict';
  // Serial status requests: fast only while the selected episode is being prepared.
  function create(options) {
    var timer = 0, controller = null, stopped = false, delay = 2000, generation = 0;
    function schedule() {
      clearTimeout(timer);
      if (!stopped && options.live()) timer = setTimeout(poll, delay);
    }
    async function poll() {
      if (stopped || !options.live()) return;
      var snapshot = options.current(), version = generation;
      if (controller) return;
      var request = new AbortController(); controller = request;
      try {
        var data = await options.read(snapshot, request.signal);
        if (!stopped && version === generation && options.live()) options.update(data, snapshot);
      } catch (error) {
        if (!stopped && version === generation && options.live() && !request.signal.aborted) options.fail(snapshot, error);
      } finally {
        if (version === generation) { controller = null; schedule(); }
      }
    }
    return {
      state: function(value) {
        var next = value === 'queued' || value === 'working' ? 500 : 2000;
        if (next !== delay) { delay = next; if (!controller) schedule(); }
      },
      select: function() {
        generation++; if (controller) controller.abort(); controller = null;
        delay = 500; schedule();
      },
      stop: function() { stopped = true; generation++; clearTimeout(timer); if (controller) controller.abort(); controller = null; }
    };
  }
  window.CodingPlaybackStatus = {create: create};
})();

(function () {
  'use strict';
  // Only browser playback: TV owns its native transition and rendering feedback.
  function pageFullscreen(video, hideControls, showControls) {
    var stage = video && video.parentElement;
    var userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
    var tesla = /\bTesla(?:Browser)?\/[\d.]+/i.test(userAgent) || /\bQtCarBrowser\b/i.test(userAgent);
    var theater = tesla && typeof location !== 'undefined' && /(?:^|[?&])tesla_theater=1(?:&|$)/.test(location.search || '');
    var fullscreen = stage && (stage.requestFullscreen || stage.webkitRequestFullscreen) &&
      (document.fullscreenEnabled || document.webkitFullscreenEnabled);
    if (!stage || stage.id !== 'stage' || (!tesla && !fullscreen)) return null;
    if (!document.getElementById('coding-page-fullscreen-style')) {
      var style = document.createElement('style'); style.id = 'coding-page-fullscreen-style';
      style.textContent = '.coding-page-fullscreen{position:relative}' +
        '.coding-fullscreen-button,.coding-media-bar button,.coding-media-bar select{padding:7px 10px;border:1px solid #ffffff55;border-radius:8px;background:#14141eee;color:#fff;font:14px sans-serif;cursor:pointer}' +
        '.coding-fullscreen-button{position:absolute;right:16px;top:16px;z-index:10}' +
        '.coding-media-bar{position:absolute;bottom:16px;left:16px;right:16px;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;border-radius:12px;background:#14141eee;color:#fff;font:13px sans-serif;opacity:0;pointer-events:none;transition:opacity .15s}' +
        '.coding-media-bar.is-visible{opacity:1;pointer-events:auto}' +
        '.coding-media-bar input{min-width:0;accent-color:#ff4b7d}.coding-seek{flex:1;width:80px}.coding-volume{width:70px}.coding-media-time{white-space:nowrap}' +
        'html.coding-tesla-theater body{margin:0!important;overflow:hidden!important;background:#000!important}' +
        'html.coding-tesla-theater #stage{position:fixed!important;inset:0!important;z-index:2147483000!important;width:100vw!important;height:100vh!important;height:100dvh!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important;background:#000}' +
        'html.coding-tesla-theater #stage video{position:absolute;inset:0;width:100%!important;height:100%!important;min-height:0!important;max-height:none!important;object-fit:contain}' +
        'html.coding-tesla-theater .coding-fullscreen-button{display:none!important}' +
        '@media(max-width:600px){.coding-media-bar{left:6px;right:6px;bottom:6px;padding:6px;gap:4px}.coding-media-bar .coding-volume{display:none}.coding-media-bar button,.coding-media-bar select{padding:6px;font-size:12px}}';
      [':fullscreen', ':-webkit-full-screen'].forEach(function (pseudo) {
        var selector = '.coding-page-fullscreen' + pseudo;
        style.textContent += selector + '{width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;background:#000;position:relative}' +
          selector + ' .coding-fullscreen-button:not(.is-visible):not(:focus-visible){opacity:0;pointer-events:none}' +
          selector + ' video{position:absolute;inset:0;width:100%!important;height:100%!important;max-height:none!important;object-fit:contain}';
      });
      document.head.appendChild(style);
    }
    var originalControls = video.controls, timer = 0, x = null, y = null, stopped = false, listeners = [];
    var button = document.createElement('button'), bar = document.createElement('div');
    var adapter = {enabled: true, show: reveal, hide: hide, stop: stop};
    function listen(target, event, fn) { target.addEventListener(event, fn); listeners.push([target, event, fn]); }
    function control(tag, label, className) {
      var node = document.createElement(tag); node.setAttribute('aria-label', label);
      if (tag === 'button') { node.type = 'button'; node.textContent = label; }
      if (className) node.className = className;
      bar.appendChild(node); return node;
    }
    button.type = 'button'; button.className = 'coding-fullscreen-button';
    button.textContent = tesla && !theater ? '隐藏地址栏' : '全屏';
    button.setAttribute('aria-label', tesla && !theater ? '进入特斯拉影院全屏' : '进入全屏');
    bar.className = 'coding-media-bar'; bar.setAttribute('aria-label', '播放控制');
    var play = control('button', '播放'), seek = control('input', '播放进度', 'coding-seek');
    seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.step = '1'; seek.value = '0';
    var time = control('span', '播放时间', 'coding-media-time'), mute = control('button', '静音');
    var volume = control('input', '音量', 'coding-volume'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.05';
    var speed = control('select', '播放速度');
    [.5, .75, 1, 1.25, 1.5, 1.75, 2].forEach(function (rate) { var option = document.createElement('option'); option.value = String(rate); option.textContent = rate + '倍'; speed.appendChild(option); });
    if (video.requestPictureInPicture || video.webkitSetPresentationMode) {
      var pip = control('button', '画中画');
      listen(pip, 'click', function () {
        try {
          if (video.webkitSetPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
          else { var result = document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture(); if (result && result.catch) result.catch(reveal); }
        } catch (_) { reveal(); }
      });
    }
    if (video.webkitShowPlaybackTargetPicker) { var airplay = control('button', '投屏'); listen(airplay, 'click', function () { video.webkitShowPlaybackTargetPicker(); }); }
    stage.classList.add('coding-page-fullscreen'); stage.appendChild(button); stage.appendChild(bar);
    if (theater) document.documentElement.classList.add('coding-tesla-theater');
    video.controls = false;
    function active() { return (document.fullscreenElement || document.webkitFullscreenElement) === stage; }
    function hide() { clearTimeout(timer); button.classList.remove('is-visible'); bar.classList.remove('is-visible'); }
    function reveal() {
      if (stopped) return;
      button.classList.add('is-visible'); bar.classList.add('is-visible'); clearTimeout(timer);
      timer = setTimeout(function () { if (!video.paused) hide(); }, 1800);
    }
    function format(value) { value = isFinite(value) ? Math.max(0, Math.floor(value)) : 0; return Math.floor(value / 60) + ':' + ('0' + value % 60).slice(-2); }
    function update() {
      play.textContent = video.paused ? '播放' : '暂停'; play.setAttribute('aria-label', play.textContent);
      seek.value = isFinite(video.duration) && video.duration > 0 ? String(Math.round(video.currentTime / video.duration * 1000)) : '0';
      seek.disabled = !(isFinite(video.duration) && video.duration > 0);
      time.textContent = format(video.currentTime) + ' / ' + format(video.duration);
      mute.textContent = video.muted ? '取消静音' : '静音'; mute.setAttribute('aria-label', mute.textContent);
      volume.value = String(video.muted ? 0 : video.volume); speed.value = String(video.playbackRate);
    }
    function togglePlay() { if (video.paused) { var promise = video.play(); if (promise && promise.catch) promise.catch(reveal); } else video.pause(); reveal(); }
    function changed() {
      var full = active(); button.textContent = full ? '退出全屏' : '全屏';
      button.setAttribute('aria-label', full ? '退出全屏' : '进入全屏'); button.setAttribute('aria-pressed', String(full));
      if (full) hideControls(); else showControls();
      reveal();
    }
    function failed() { if (!stopped) { showControls(); stop(); } }
    function theaterTarget() {
      var href = String(location.href), hash = String(location.hash || '');
      var base = hash ? href.slice(0, -hash.length) : href;
      var join = base.indexOf('?') < 0 ? '?' : /[?&]$/.test(base) ? '' : '&';
      return base + join + 'tesla_theater=1' + hash;
    }
    function toggle(event) {
      if (event) { event.preventDefault(); event.stopPropagation(); }
      if (tesla && !theater) {
        window.open('https://www.youtube.com/redirect?q=' + encodeURIComponent(theaterTarget()), '_blank');
        return;
      }
      if (theater) { reveal(); return; }
      try {
        var result = active() ? (document.exitFullscreen || document.webkitExitFullscreen).call(document) :
          (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage);
        if (result && result.catch) result.catch(failed);
      } catch (_) { failed(); }
    }
    function movement(event) {
      if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return;
      if (x !== null && (Math.abs(event.clientX - x) >= 4 || Math.abs(event.clientY - y) >= 4)) reveal();
      x = event.clientX; y = event.clientY;
    }
    function key(event) {
      var target = event.target;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (active() || target === video || stage.contains(target)) {
        reveal();
        if (event.key === 'f' || event.key === 'F') toggle(event);
        else if (active() && target.tagName !== 'BUTTON' && event.key === ' ') { event.preventDefault(); togglePlay(); }
      }
    }
    function stop() {
      if (stopped) return;
      stopped = true; adapter.enabled = false; clearTimeout(timer);
      listeners.forEach(function (item) { item[0].removeEventListener(item[1], item[2]); });
      button.remove(); bar.remove(); stage.classList.remove('coding-page-fullscreen', 'coding-controls-quiet'); video.controls = originalControls;
      if (theater) document.documentElement.classList.remove('coding-tesla-theater');
    }
    listen(play, 'click', togglePlay); listen(video, 'click', togglePlay);
    listen(seek, 'input', function () { if (isFinite(video.duration)) video.currentTime = Number(seek.value) / 1000 * video.duration; reveal(); });
    listen(volume, 'input', function () { video.muted = false; video.volume = Number(volume.value); reveal(); });
    listen(mute, 'click', function () { video.muted = !video.muted; reveal(); });
    listen(speed, 'change', function () { video.playbackRate = Number(speed.value); reveal(); });
    ['timeupdate', 'loadedmetadata', 'play', 'pause', 'volumechange', 'ratechange'].forEach(function (name) { listen(video, name, update); });
    listen(button, 'click', toggle); listen(button, 'focus', reveal); listen(bar, 'focusin', reveal);
    listen(bar, 'dblclick', function (event) { event.stopPropagation(); });
    listen(stage, 'dblclick', toggle); listen(stage, 'pointermove', movement);
    listen(stage, 'touchstart', reveal); listen(document, 'keydown', key);
    listen(document, 'fullscreenchange', changed); listen(document, 'webkitfullscreenchange', changed);
    update(); reveal(); return adapter;
  }
  function create(w, video, overlay) {
    var snapshot = null, replay = null, checked = 0, timer = 0, controlsTimer = 0, browserControls = null;
    var controlsSuppressed = false, controlsWereEnabled = false, controlsReady = false;
    var pointerX = null, pointerY = null, pointerOriginX = null, pointerOriginY = null, ending = false;
    var intentEvents = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
    var movementEvents = ['pointermove', 'mousemove'];
    overlay = overlay || document.querySelector('#vload');
    function cancel() { clearTimeout(timer); timer = 0; }
    function restoreControls() {
      if (!controlsSuppressed) return;
      controlsSuppressed = false;
      controlsReady = false;
      clearTimeout(controlsTimer); controlsTimer = 0;
      intentEvents.forEach(function (name) { document.removeEventListener(name, restoreControls, true); });
      if (browserControls && browserControls.enabled) browserControls.show();
      else if (controlsWereEnabled) video.controls = true;
      if (video.parentElement) video.parentElement.classList.remove('coding-controls-quiet');
      controlsWereEnabled = false;
    }
    function trackPointer(event) {
      if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return;
      pointerX = event.clientX; pointerY = event.clientY;
      if (!controlsSuppressed || !controlsReady) return;
      if (pointerOriginX === null || pointerOriginY === null) {
        pointerOriginX = pointerX; pointerOriginY = pointerY; return;
      }
      var dx = pointerX - pointerOriginX, dy = pointerY - pointerOriginY;
      if (dx * dx + dy * dy >= 16) restoreControls();
    }
    movementEvents.forEach(function (name) { document.addEventListener(name, trackPointer, true); });
    function suppressControls() {
      restoreControls();
      if (!video || !('controls' in video) || (!video.controls && !(browserControls && browserControls.enabled))) return;
      controlsWereEnabled = true;
      controlsSuppressed = true;
      controlsReady = false;
      pointerOriginX = pointerX; pointerOriginY = pointerY;
      video.controls = false;
      if (browserControls && browserControls.enabled) browserControls.hide();
      if (video.parentElement) video.parentElement.classList.add('coding-controls-quiet');
      intentEvents.forEach(function (name) { document.addEventListener(name, restoreControls, true); });
    }
    function switching(automatic) { ending = false; if (automatic) suppressControls(); else restoreControls(); }
    function show() { cancel(); restoreControls(); overlay.style.display = 'flex'; }
    function hide() { cancel(); overlay.style.display = 'none'; }
    function playing() {
      hide();
      if (!controlsSuppressed) return;
      clearTimeout(controlsTimer);
      controlsTimer = setTimeout(function () {
        controlsTimer = 0; controlsReady = true;
        pointerOriginX = pointerX; pointerOriginY = pointerY;
      }, 300);
    }
    function waiting() {
      if (timer || !w.alive) return;
      var token = w.token;
      timer = setTimeout(function () {
        timer = 0;
        if (w.alive && w.token === token) overlay.style.display = 'flex';
      }, 450);
    }
    function advances() { return w.alive && w.auto && (w.ep < w.eps.length || !!w.nextSeason); }
    function beforeEnd() {
      var remaining = video.duration - video.currentTime;
      if (advances() && !video.paused && isFinite(video.duration) && remaining >= 0 && remaining <= 1.1) {
        if (!ending) { ending = true; suppressControls(); }
      } else if (ending && remaining > 1.5) { ending = false; restoreControls(); }
    }
    function ended() { if (advances()) { ending = true; if (!controlsSuppressed) suppressControls(); } }
    if (video.addEventListener) {
      video.addEventListener('timeupdate', beforeEnd);
      video.addEventListener('ended', ended, true);
    }
    browserControls = pageFullscreen(video, function () {
      suppressControls(); if (!video.paused) playing();
    }, restoreControls);
    return {
      remember: function (data) { if (data !== replay) { snapshot = data; checked = Date.now(); } },
      select: function (n, retry) {
        cancel();
        if (retry || !snapshot || Date.now() - checked >= 8000 ||
            snapshot.episodes[n]?.state !== 'ready') return null;
        hide(); waiting();
        replay = w.mode === 'nas' ? Object.assign({}, snapshot, {current: snapshot.episodes[n]}) : null;
        return replay;
      },
      switching: switching, waiting: waiting, playing: playing, show: show, hide: hide,
      stop: function () {
        cancel(); restoreControls();
        if (browserControls) browserControls.stop();
        if (video.removeEventListener) {
          video.removeEventListener('timeupdate', beforeEnd); video.removeEventListener('ended', ended, true);
        }
        movementEvents.forEach(function (name) { document.removeEventListener(name, trackPointer, true); });
      }
    };
  }
  window.CodingWebTransition = {create: create};
})();
