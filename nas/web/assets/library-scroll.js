(function () {
  'use strict';
  window.CodingLibraryScroll = function () {
    var stopped = false, lastInput = 0;
    // Let WebView animate on its scrolling path instead of repainting from a JS RAF loop.
    function cancel() { window.scrollTo({top: window.scrollY, left: 0, behavior: 'auto'}); }
    function focus(el) {
      if (stopped || !el) return;
      var now = performance.now(), repeated = now - lastInput < 220; lastInput = now;
      cancel(); el.focus({preventScroll: true});
      var rect = el.getBoundingClientRect(), header = document.querySelector('.top');
      var safeTop = header ? header.getBoundingClientRect().bottom + 12 : 12;
      var from = window.scrollY, to = from;
      if (rect.top < safeTop) to += rect.top - safeTop;
      else if (rect.bottom > innerHeight - 16) to += rect.bottom - innerHeight + 16;
      to = Math.max(0, Math.min(to, document.documentElement.scrollHeight - innerHeight));
      if (Math.abs(to - from) < 1) { cancel(); return; }
      var smooth = !repeated && Math.abs(to - from) < innerHeight * 0.75 && document.documentElement.classList.contains('coding-tv') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Single steps ease into place; held keys catch up immediately instead of building visual lag.
      window.scrollTo({top: to, left: 0, behavior: smooth ? 'smooth' : 'auto'});
    }
    function manual() { cancel(); }
    window.addEventListener('wheel', manual, {passive: true});
    window.addEventListener('touchstart', manual, {passive: true});
    window.addEventListener('resize', manual);
    return {focus: focus, cancel: cancel, destroy: function() {
      stopped = true; cancel(); window.removeEventListener('wheel', manual); window.removeEventListener('touchstart', manual); window.removeEventListener('resize', manual);
    }};
  };
})();
