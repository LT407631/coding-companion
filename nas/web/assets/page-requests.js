(function () {
  'use strict';
  var active = null;
  function stop() { if (active) active.abort(); active = null; }
  function start() {
    stop();
    var controller = new AbortController(); active = controller;
    return {
      signal: controller.signal,
      live: function () { return active === controller && !controller.signal.aborted; },
      done: function () { if (active === controller) active = null; }
    };
  }
  window.CodingPageRequests = {start: start, stop: stop};
})();
