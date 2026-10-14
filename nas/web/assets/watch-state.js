(function () {
  'use strict';
  var cachedLists = {}, boot, KEY, profile, active = false, listeners = [], timer = 0, flight = null, status = '本机保存，正在连接 NAS';
  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_) { return fallback; } }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { status = '本机存储空间不足'; return false; } }
  var saved, rows, pending, server, cursor;
  // Capture legacy shared mirrors before any non-default profile can replace them.
  if (!read('hg_watch_legacy_default', null)) write('hg_watch_legacy_default', {history: read('hg_hist', []), favorite: read('hg_favs', [])});
  function configure() {
    profile = window.CodingProfiles ? CodingProfiles.id() : 'default'; KEY = 'hg_watch_sync_v2:' + profile;
    saved = read(KEY, profile === 'default' ? read('hg_watch_sync_v1', {}) : {});
    rows = saved.rows || {}; pending = saved.pending || {}; server = saved.server || ''; cursor = saved.cursor || 0; cachedLists = {};
  }
  configure();
  function id(sid) { return /^\d{1,24}$/.test(String(sid)); }
  function key(kind, sid) { return kind + ':' + sid; }
  function cover(url) { try { return typeof originalCover === 'function' ? originalCover(url) : url || ''; } catch (_) { return ''; } }
  function compact(kind, value) {
    if (!value) return null;
    var v = {sid: String(value.sid || value.series_id), title: String(value.title || '').slice(0, 500), cover: cover(value.cover), ts: value.ts || Date.now()};
    if (kind === 'history') Object.assign(v, {ep: Number(value.ep) || 1, epCnt: Number(value.epCnt) || 1, pos: Number(value.pos) || 0, dur: Number(value.dur) || 0, finished: !!value.finished});
    if (kind === 'favorite') v.epCnt = Number(value.epCnt) || 0;
    if (kind === 'hidden') v.reason = value.reason;
    return v;
  }
  function persist() { write(KEY, {server: server, cursor: cursor, rows: rows, pending: pending}); }
  function emit() { listeners.slice().forEach(function(fn) { fn(); }); }
  function all(kind) {
    if (cachedLists[kind]) return cachedLists[kind];
    var result = {};
    Object.keys(rows).forEach(function(k) { if (rows[k].kind === kind && rows[k].value) result[rows[k].sid] = rows[k].value; });
    Object.keys(pending).forEach(function(k) { var op = pending[k]; if (op.kind !== kind) return; if (op.value) result[op.sid] = op.value; else delete result[op.sid]; });
    return cachedLists[kind] = Object.keys(result).map(function(sid) { return result[sid]; }).sort(function(a, b) { return b.ts - a.ts; });
  }
  function mirror() { write('hg_hist', all('history').slice(0, 200)); write('hg_favs', all('favorite')); }
  function change(kind, sid, value, seed) {
    sid = String(sid); if (!id(sid)) return;
    var k = key(kind, sid), previous = pending[k];
    if (Object.keys(pending).length >= 1000 && !previous) { status = '待同步记录较多，请连接 NAS 后重试'; emit(); return; }
    pending[k] = {kind: kind, sid: sid, value: compact(kind, value), base: previous ? previous.base : (rows[k] || {}).rev || 0,
      seed: !!seed, local: Date.now() + ':' + Math.random()};
    cachedLists = {}; persist(); mirror(); emit(); schedule(kind === 'history' ? 5000 : 200);
  }
  function schedule(ms) { if (!timer) timer = setTimeout(function() { timer = 0; sync(); }, ms); }
  async function request(path, body) {
    var ctl = new AbortController(), timeout = setTimeout(function() { ctl.abort(); }, 10000);
    try {
      var r = await fetch(path, {method: body ? 'POST' : 'GET', cache: 'no-store', signal: ctl.signal,
        headers: Object.assign({'X-Watch-Profile': profile}, body ? {'Content-Type': 'application/json'} : {}), body: body ? JSON.stringify(body) : undefined});
      if (!r.ok) { var error = new Error('sync unavailable'); if (r.status === 400 || r.status === 413) { var problem = await r.json(); error.userMessage = typeof problem.detail === 'string' ? problem.detail : '同步内容无效'; } throw error; }
      return await r.json();
    } finally { clearTimeout(timeout); }
  }
  function absorb(list) { cachedLists = {}; (list || []).forEach(function(row) { if (id(row.sid) && ['history', 'favorite', 'hidden'].includes(row.kind)) rows[key(row.kind, row.sid)] = row; }); }
  function sync() {
    if (!active) return boot || Promise.resolve();
    if (!flight) flight = runSync().finally(function() { flight = null; });
    return flight;
  }
  async function runSync() {
    clearTimeout(timer); timer = 0;
    try {
      var data = await request('/watch-state?since=' + cursor);
      if (!data.server || !Array.isArray(data.rows)) throw Error('invalid response');
      if (server && server !== data.server) {
        // A different NAS must not receive queued writes created for the old server.
        write(KEY + '_previous_' + server, {rows: rows, pending: pending}); rows = {}; pending = {}; cachedLists = {}; cursor = 0;
        data = await request('/watch-state?since=0');
      }
      server = data.server; cursor = data.cursor; absorb(data.rows);
      var batch = Object.keys(pending).slice(0, 10).map(function(k) { return pending[k]; });
      if (batch.length) {
        var response = await request('/watch-state', {server: server, operations: batch.map(function(op) { return {kind: op.kind, sid: op.sid, base: op.base, value: op.value, seed: op.seed}; })});
        if (!Array.isArray(response.rows) || response.rows.length !== batch.length) throw Error('invalid response');
        response.rows.forEach(function(row, index) {
          var op = batch[index], k = key(op.kind, op.sid), current = pending[k];
          if (!current) return;
          if (current.local === op.local || !row.ok) delete pending[k];
          else pending[k].base = row.rev;
        });
        absorb(response.rows);
      }
      status = Object.keys(pending).length ? '正在同步观看记录…' : '已与 NAS 同步';
      persist(); mirror(); emit();
      if (Object.keys(pending).length) schedule(200);
    } catch (error) { status = error.userMessage ? '同步未完成：' + error.userMessage : '本机已保存，连接 NAS 后自动同步'; emit(); }
  }
  function migrate() {
    if (profile !== 'default' || saved.migrated || localStorage.getItem('hg_watch_imported_v1')) return;
    ['history', 'favorite'].forEach(function(kind) {
      var name = kind === 'history' ? 'hg_hist' : 'hg_favs', old = read('hg_watch_legacy_default', {})[kind] || [];
      if (!Array.isArray(old)) return;
      if (!localStorage.getItem(name + '_before_sync')) write(name + '_before_sync', old);
      old.forEach(function(value) { var sid = String(value.sid || value.series_id || ''); if (id(sid) && !rows[key(kind, sid)] && !pending[key(kind, sid)]) {
        pending[key(kind, sid)] = {kind: kind, sid: sid, base: 0, value: compact(kind, value), seed: true, local: 'import'};
      } });
    });
    cachedLists = {}; persist(); write('hg_watch_imported_v1', true);
  }
  function value(kind, sid) { var k = key(kind, sid); return pending[k] ? pending[k].value : rows[k] && rows[k].value; }
  var favs = {all: function() { return all('favorite'); }, has: function(sid) { return !!value('favorite', sid); },
    remove: function(sid) { change('favorite', sid, null); }, toggle: function(value) { var on = !favs.has(value.sid); change('favorite', value.sid, on ? value : null); return on; }};
  var hist = {all: function() { return all('history').slice(0, 200); }, get: function(sid) { return value('history', sid); },
    put: function(value) { change('history', value.sid, value); }, remove: function(sid) { change('history', sid, null); },
    clear: function() { all('history').forEach(function(v) { change('history', v.sid, null); }); }};
  window.CodingWatchState = {favs: favs, hist: hist, hidden: function() { return all('hidden'); },
    hide: function(value, reason) { change('hidden', value.sid, Object.assign({}, value, {reason: reason})); },
    restore: function(sid) { change('hidden', sid, null); }, sync: sync, status: function() { return status; },
    subscribe: function(fn) { listeners.push(fn); return function() { listeners = listeners.filter(function(f) { return f !== fn; }); }; },
    ready: function() { return Promise.race([boot || Promise.resolve(), new Promise(function(resolve) { setTimeout(resolve, 1200); })]); },
    profile: function() { return profile; },
    start: function() { if (boot) return boot; boot = (window.CodingProfiles ? CodingProfiles.ready() : Promise.resolve()).then(function() {
      if (window.CodingProfiles && profile !== CodingProfiles.id()) configure();
      active = true; migrate(); mirror(); return sync();
    }); return boot; }};
  setInterval(function() { if (!document.hidden) sync(); }, 30000);
  window.addEventListener('online', function() { sync(); });
  document.addEventListener('visibilitychange', function() { if (!document.hidden) sync(); else persist(); });
  window.addEventListener('pagehide', persist);
})();
