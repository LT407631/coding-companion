(function () {
  'use strict';
  var database, opening, age = 7 * 86400000, limit = 2000;
  function open() {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise(function(resolve) {
      var request, settled = false;
      function finish(db) { if (settled) { if (db) db.close(); return; } settled = true; clearTimeout(timer); resolve(db); }
      var timer = setTimeout(function() { finish(null); }, 1000);
      try { request = indexedDB.open('coding-library-v1', 2); } catch (_) { finish(null); return; }
      request.onupgradeneeded = function() { var db = request.result; if (!db.objectStoreNames.contains('views')) { var store = db.createObjectStore('views', {keyPath: 'key'}); store.createIndex('used', 'used'); } if (!db.objectStoreNames.contains('filters')) db.createObjectStore('filters', {keyPath: 'key'}); };
      request.onerror = function() { finish(null); };
      request.onsuccess = function() {
        if (!settled) { database = request.result; database.onversionchange = function() { database.close(); database = opening = null; }; }
        finish(request.result);
      };
    });
    return opening;
  }
  function valid(value) {
    return value && value.version === 1 && Number.isFinite(value.created) && Date.now() - value.created < age &&
      Array.isArray(value.items) && value.items.length > 0 && value.items.length <= limit && typeof value.cursor === 'string' &&
      value.cursor.length <= 256 && typeof value.more === 'boolean' && (!value.more || !!value.cursor) &&
      value.items.every(function(it) { return it && typeof it.series_id === 'string' && it.series_id.length <= 128 && typeof it.title === 'string' && it.title.length <= 500 && (!it.cover || (typeof it.cover === 'string' && it.cover.length <= 4096)); });
  }
  async function read(key) {
    var db = await open(); if (!db) return null;
    return new Promise(function(resolve) {
      try {
        var tx = db.transaction('views', 'readonly'), request = tx.objectStore('views').get(key);
        request.onsuccess = function() { resolve(valid(request.result) ? request.result : null); };
        request.onerror = tx.onabort = function() { resolve(null); };
      } catch (_) { resolve(null); }
    });
  }
  async function write(key, state) {
    // Keep a complete pagination chain. Never truncate items while retaining its end cursor.
    if (!state.loaded || state.items.length > limit) return false;
    if (!state.items.length) { await remove(key); return false; }
    var value = {key: key, version: 1, created: state.created, used: Date.now(), items: state.items.slice(), cursor: state.cursor,
      more: state.more, head: state.head || '', scroll: Math.max(0, Number(state.scroll) || 0), focus: state.focus || '', offset: Number.isFinite(state.offset) ? state.offset : null};
    if (!valid(value)) return false;
    var db = await open(); if (!db) return false;
    return new Promise(function(resolve) {
      try {
        var tx = db.transaction('views', 'readwrite'), store = tx.objectStore('views');
        store.put(value);
        var count = 0, cursor = store.index('used').openCursor(null, 'prev');
        cursor.onsuccess = function() {
          var row = cursor.result; if (!row) return;
          if (++count > 4 || Date.now() - row.value.created >= age) row.delete();
          row.continue();
        };
        tx.oncomplete = function() { resolve(true); };
        tx.onerror = tx.onabort = function() { resolve(false); };
      } catch (_) { resolve(false); }
    });
  }
  async function remove(key) {
    var db = await open(); if (!db) return;
    return new Promise(function(resolve) {
      try { var tx = db.transaction('views', 'readwrite'); tx.objectStore('views').delete(key); tx.oncomplete = tx.onabort = tx.onerror = function() { resolve(); }; } catch (_) { resolve(); }
    });
  }
  async function filters(key, value) {
    if (!['short_play', 'comic_series', 'ai_series'].includes(key)) return null;
    var db = await open(); if (!db) return null;
    return new Promise(function(resolve) {
      try {
        var tx = db.transaction('filters', value ? 'readwrite' : 'readonly'), records = tx.objectStore('filters');
        if (value) {
          if (!Array.isArray(value.rows) || JSON.stringify(value).length > 65536) { resolve(null); return; }
          records.put({key: key, created: Date.now(), value: value}); tx.oncomplete = function() { resolve(value); };
        } else {
          var request = records.get(key);
          request.onsuccess = function() { var result = request.result; resolve(result && Date.now() - result.created < age ? result.value : null); };
        }
        tx.onerror = tx.onabort = function() { resolve(null); };
      } catch (_) { resolve(null); }
    });
  }
  window.CodingLibraryStore = {read: read, write: write, remove: remove, filters: filters};
})();
