(function () {
  'use strict';
  // Keep catalogue metadata, but mount only nearby rows and the focused row.
  // Separate network look-ahead from mounted rows; never retain the whole feed.
  function posterWarmer(urlFor) {
    var wanted = new Set(), completed = new Set(), retry = new Map(), pending = new Map(), queue = [], timer = 0, stopped = false, visible = new Set(), limit = 1, primed = false;
    function pump() {
      timer = 0;
      if (stopped) return;
      while (pending.size < limit && queue.length) {
        var url = queue.shift();
        if (!wanted.has(url) || completed.has(url) || pending.has(url)) continue;
        start(url);
      }
    }
    function start(url) {
      var entry = {controller: new AbortController(), timeout: 0};
      pending.set(url, entry);
      entry.timeout = setTimeout(function() { entry.controller.abort(); }, 10000);
      // Prime the browser's HTTP cache with compressed bytes. Do not construct/decode spare Images.
      fetch(url, {cache: 'force-cache', credentials: 'same-origin', signal: entry.controller.signal, priority: 'low'})
        .then(function(response) { if (!response.ok) throw Error('cover unavailable'); return response.arrayBuffer(); })
        .then(function() { if (!stopped && pending.get(url) === entry && !entry.controller.signal.aborted && wanted.has(url)) completed.add(url); })
        .catch(function() { if (!entry.controller.signal.aborted && pending.get(url) === entry) retry.set(url, Date.now() + 15000); })
        .finally(function() {
          if (pending.get(url) !== entry) return;
          pending.delete(url); clearTimeout(entry.timeout);
          if (!timer && !stopped) timer = setTimeout(pump, 0);
        });
    }
    return {
      update: function(items, from, to, direction, visibleFrom, visibleTo, foregroundReady) {
        if (!urlFor || stopped) return;
        if (foregroundReady) primed = true;
        limit = primed ? 4 : 1;
        var urls = [];
        for (var i = from; i < to; i++) { var url = urlFor(items[i]); if (url) urls.push(url); }
        if (direction < 0) urls.reverse();
        wanted = new Set(urls); visible = new Set();
        for (var j = visibleFrom; j < visibleTo; j++) {
          var onscreen = urlFor(items[j]);
          if (onscreen) { wanted.add(onscreen); visible.add(onscreen); }
        }
        completed.forEach(function(url) { if (!wanted.has(url)) completed.delete(url); });
        retry.forEach(function(at, url) { if (!wanted.has(url)) retry.delete(url); });
        pending.forEach(function(entry, url) {
          if (!wanted.has(url)) { clearTimeout(entry.timeout); entry.controller.abort(); pending.delete(url); }
        });
        queue = urls.filter(function(url) { return !completed.has(url) && !pending.has(url) && !(retry.get(url) > Date.now()); });
        if (!timer) timer = setTimeout(pump, 0);
      },
      destroy: function() {
        stopped = true; clearTimeout(timer); queue = []; wanted.clear(); visible.clear(); completed.clear(); retry.clear();
        pending.forEach(function(entry) { clearTimeout(entry.timeout); entry.controller.abort(); }); pending.clear();
      }
    };
  }
  window.CodingLibraryGrid = function (grid, options) {
    var items = [], nodes = new Map(), spaces = new Map(), columns = 1, pitch = 0, gap = 0;
    var warmer = posterWarmer(options.cover), lastScroll = window.scrollY, direction = 1, previousRow = -1, lastRowAt = 0;
    var frame = 0, stopped = false, top = 0, dirty = true, signature = '', priorityRange = '', parked = new Map();
    var appearance = new MutationObserver(function() { dirty = true; schedule(); });
    appearance.observe(document.documentElement, {attributes: true, attributeFilter: ['class']});
    function card(index) {
      if (nodes.has(index)) return nodes.get(index);
      if (parked.has(index)) { var reused = parked.get(index); parked.delete(index); nodes.set(index, reused); return reused; }
      var holder = document.createElement('div');
      holder.innerHTML = options.html(items[index]);
      var el = holder.firstElementChild;
      el.dataset.index = index; el.dataset.sid = items[index].series_id;
      el.tabIndex = 0; el.setAttribute('role', 'button');
      var img = el.querySelector('img');
      if (img) { img.setAttribute('decoding', 'async'); img.addEventListener('load', schedule); }
      if (document.documentElement.classList.contains('coding-tv')) {
        var button = el.querySelector('.favbtn');
        if (button) {
          var saved = button.classList.contains('on'), label = document.createElement('span');
          label.className = 'tv-fav-state' + (saved ? ' on' : ''); label.tabIndex = -1;
          label.textContent = saved ? '已收藏' : '未收藏'; button.replaceWith(label);
        }
      }
      nodes.set(index, el); return el;
    }
    function discard(el) {
      var img = el.querySelector('img');
      if (img) { img.removeEventListener('load', schedule); img.removeAttribute('src'); }
    }
    function spacer(start, end) {
      var key = start + ':' + end, el = spaces.get(key);
      if (!el) { el = document.createElement('div'); el.className = 'library-spacer'; el.setAttribute('aria-hidden', 'true'); spaces.set(key, el); }
      el.style.height = Math.max(0, (end - start) * pitch - gap) + 'px';
      return el;
    }
    function layout() {
      if (!dirty) return;
      var style = getComputedStyle(grid), next = style.gridTemplateColumns.split(' ').length;
      columns = Math.max(1, next); gap = parseFloat(style.rowGap) || 0;
      top = grid.getBoundingClientRect().top + window.scrollY;
      if (!items.length) return;
      if (!nodes.size) grid.appendChild(card(0));
      var first = nodes.values().next().value;
      pitch = first.getBoundingClientRect().height + gap;
      top = grid.getBoundingClientRect().top + window.scrollY;
      dirty = false; signature = '';
    }
    function render(target) {
      if (stopped || !items.length) return;
      layout();
      if (!pitch) return;
      var rows = Math.ceil(items.length / columns), keepRows = new Set();
      if (window.scrollY !== lastScroll) direction = window.scrollY > lastScroll ? 1 : -1;
      lastScroll = window.scrollY;
      var visibleStart = Math.max(0, Math.floor((window.scrollY - top) / pitch));
      var visibleEnd = Math.max(visibleStart + 1, Math.ceil((window.scrollY + innerHeight - top) / pitch));
      var screenRows = Math.max(1, Math.ceil(innerHeight / pitch));
      var aheadStart = direction > 0 ? visibleEnd + 2 : Math.max(0, visibleStart - screenRows * 3);
      var aheadEnd = direction > 0 ? visibleEnd + screenRows * 3 : Math.max(0, visibleStart - 2);
      var now = Date.now(), moving = previousRow >= 0 && visibleStart !== previousRow;
      var fast = moving && now - lastRowAt < 600;
      if (moving || previousRow < 0) lastRowAt = now;
      previousRow = visibleStart;
      function warm() {
        var foregroundReady = true;
        nodes.forEach(function(el, index) { if (index >= visibleStart * columns && index < visibleEnd * columns) { var img = el.querySelector('img'); if (img && (!img.complete || !img.naturalWidth)) foregroundReady = false; } });
        warmer.update(items, Math.min(items.length, aheadStart * columns), Math.min(items.length, aheadEnd * columns), direction, Math.min(items.length, Math.max(0, visibleStart - 2) * columns), Math.min(items.length, (visibleEnd + 2) * columns), foregroundReady);
      }
      function prioritize(el, index) {
        var img = el.querySelector('img');
        if (!img) return;
        var row = Math.floor(index / columns), onscreen = row >= visibleStart && row < visibleEnd;
        // Do not leave newly visible posters waiting for browser lazy-load heuristics.
        img.setAttribute('fetchpriority', onscreen ? 'high' : 'low');
        if (onscreen) img.setAttribute('loading', 'eager');
      }
      var nextPriority = visibleStart + ':' + visibleEnd;
      if (priorityRange !== nextPriority) { nodes.forEach(prioritize); priorityRange = nextPriority; }
      var firstRow = Math.max(0, Math.floor((window.scrollY - top) / pitch) - 2);
      var lastRow = Math.min(rows, Math.ceil((window.scrollY + innerHeight - top) / pitch) + 2);
      for (var row = firstRow; row < lastRow; row++) keepRows.add(row);
      var focused = document.activeElement && document.activeElement.closest('.library-grid .card');
      if (focused && grid.contains(focused)) keepRows.add(Math.floor(Number(focused.dataset.index) / columns));
      if (target !== undefined) keepRows.add(Math.floor(target / columns));
      var rowOrder = Array.from(keepRows).sort(function(a, b) { return a - b; });
      var nextSignature = items.length + ':' + rowOrder.join(',');
      if (signature === nextSignature) { warm(); return; }
      signature = nextSignature;
      var desired = [], keep = new Set(), usedSpaces = new Set(), previous = 0;
      rowOrder.forEach(function(row) {
        if (row < 0 || row >= rows) return;
        if (row > previous) { var blank = spacer(previous, row); desired.push(blank); usedSpaces.add(previous + ':' + row); }
        for (var i = row * columns; i < Math.min(items.length, (row + 1) * columns); i++) { var el = card(i); prioritize(el, i); desired.push(el); keep.add(i); }
        previous = row + 1;
      });
      if (previous < rows) { desired.push(spacer(previous, rows)); usedSpaces.add(previous + ':' + rows); }
      nodes.forEach(function(el, index) { if (!keep.has(index)) { el.remove(); nodes.delete(index); parked.set(index, el); } });
      // Two detached rows absorb direction reversals without retaining the whole catalogue.
      while (parked.size > columns * 2) { var old = parked.keys().next().value; discard(parked.get(old)); parked.delete(old); }
      spaces.forEach(function(el, key) { if (!usedSpaces.has(key)) { el.remove(); spaces.delete(key); } });
      var cursor = grid.firstChild;
      desired.forEach(function(el) { if (el === cursor) cursor = cursor.nextSibling; else grid.insertBefore(el, cursor); });
      grid.dataset.total = items.length; warm();
    }
    function plan() {
      layout();
      var estimated = pitch || (grid.clientWidth / Math.max(1, columns) * 10 / 7 + 90);
      var screen = columns * Math.max(1, Math.ceil(innerHeight / estimated));
      var start = Math.max(0, Math.floor((window.scrollY - top) / estimated)) * columns;
      var firstRows = Math.max(1, Math.ceil(Math.max(0, innerHeight - Math.max(0, top - window.scrollY)) / estimated));
      return {screen: screen, first: Math.max(24, columns * firstRows), end: start + screen};
    }
    function schedule() {
      if (frame || stopped) return;
      frame = requestAnimationFrame(function() { frame = 0; render(); options.more(plan()); });
    }
    function set(next) {
      function invalidate(collection) {
        collection.forEach(function(el, index) {
          if (!next[index] || el.dataset.sid !== String(next[index].series_id)) { discard(el); el.remove(); collection.delete(index); signature = ''; }
        });
      }
      invalidate(nodes); invalidate(parked);
      items = next; render(); schedule();
    }
    function at(index) { if (index < 0 || index >= items.length) return null; if (!nodes.has(index) || dirty) render(index); return nodes.get(index); }
    function resize() {
      if (!pitch || !items.length) { schedule(); return; }
      var row = Math.max(0, Math.floor((window.scrollY - top) / pitch)), index = Math.min(items.length - 1, row * columns);
      var offset = window.scrollY - top - row * pitch;
      dirty = true; layout(); render(index);
      window.scrollTo(0, Math.max(0, top + Math.floor(index / columns) * pitch + Math.max(0, Math.min(offset, pitch))));
      schedule();
    }
    function destroy() {
      stopped = true; warmer.destroy(); cancelAnimationFrame(frame); appearance.disconnect();
      window.removeEventListener('scroll', schedule); window.removeEventListener('resize', resize);
      nodes.forEach(discard); parked.forEach(discard); nodes.clear(); parked.clear(); spaces.clear(); items = []; grid.innerHTML = '';
    }
    window.addEventListener('scroll', schedule, {passive: true});
    window.addEventListener('resize', resize);
    return {set: set, at: at, plan: plan, columns: function() { layout(); return columns; }, destroy: destroy};
  };
})();
