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
  function create(w, video, overlay) {
    var snapshot = null, replay = null, checked = 0, timer = 0, controlsTimer = 0;
    var controlsSuppressed = false, controlsWereEnabled = false, controlsReady = false;
    var pointerX = null, pointerY = null, pointerOriginX = null, pointerOriginY = null;
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
      if (controlsWereEnabled) video.controls = true;
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
      if (!video || !('controls' in video) || !video.controls) return;
      controlsWereEnabled = true;
      controlsSuppressed = true;
      controlsReady = false;
      pointerOriginX = pointerX; pointerOriginY = pointerY;
      video.controls = false;
      intentEvents.forEach(function (name) { document.addEventListener(name, restoreControls, true); });
    }
    function switching(automatic) { if (automatic) suppressControls(); else restoreControls(); }
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
        movementEvents.forEach(function (name) { document.removeEventListener(name, trackPointer, true); });
      }
    };
  }
  window.CodingWebTransition = {create: create};
})();
