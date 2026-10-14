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
    var snapshot = null, replay = null, checked = 0, timer = 0;
    overlay = overlay || document.querySelector('#vload');
    function cancel() { clearTimeout(timer); timer = 0; }
    function show() { cancel(); overlay.style.display = 'flex'; }
    function hide() { cancel(); overlay.style.display = 'none'; }
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
      waiting: waiting, show: show, hide: hide, stop: cancel
    };
  }
  window.CodingWebTransition = {create: create};
})();
