// Season discovery shared by detail and playback routes.
const seasonSearchHints = new Map();
function rememberSeasonSearch(query, results) {
  const hint = String(query || '').trim().slice(0, 100);
  if (!hint) return;
  (results || []).forEach(item => {
    const sid = String(item.series_id);
    seasonSearchHints.delete(sid); seasonSearchHints.set(sid, hint);
  });
  while (seasonSearchHints.size > 80) seasonSearchHints.delete(seasonSearchHints.keys().next().value);
}
async function fetchSeasons(sid, refresh = false) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const hint = seasonSearchHints.get(String(sid));
    const response = await fetch('/seasons?series_id=' + encodeURIComponent(sid) + (refresh ? '&refresh=true' : '') + (hint ? '&search_hint=' + encodeURIComponent(hint) : ''), { signal: ctl.signal });
    if (!response.ok) throw new Error('获取失败');
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function loadSeasons(sid, slot, refresh = false, keepContent = false) {
  clearTimeout(slot._seasonPoll);
  if (!keepContent) slot.innerHTML = '<h3>全部季</h3><div class="season-note" role="status">首次查找其他季，结果会保存到 NAS…</div>';
  try {
    const data = await fetchSeasons(sid, refresh);
    if (!slot.isConnected || location.hash !== '#/detail/' + sid) return;
    slot.innerHTML = `<h3>${data.membership === 'title' ? '相关季' : '全部季'}（${data.items.length}）</h3><div class="season-list"></div>`;
    const refreshButton = document.createElement('button'); refreshButton.className = 'season-retry';
    refreshButton.type = 'button'; refreshButton.textContent = '刷新季列表';
    refreshButton.disabled = !!data.refreshing;
    refreshButton.onclick = () => loadSeasons(sid, slot, true, true);
    slot.querySelector('h3').appendChild(refreshButton);
    const list = slot.querySelector('.season-list');
    data.items.forEach(item => {
      const button = document.createElement('button');
      const current = String(item.series_id) === String(sid);
      button.type = 'button'; button.className = 'season-btn' + (current ? ' on' : '');
      button.textContent = (item.season ? '第' + item.season + '季' : item.title) + (current ? ' · 当前' : '') + (item.available === false ? ' · 暂无剧集' : '');
      button.title = item.title + ' · 全' + item.episode_cnt + '集';
      if (current) button.setAttribute('aria-current', 'page');
      button.onclick = () => go('#/detail/' + item.series_id);
      list.appendChild(button);
    });
    if (data.cached || data.partial || data.items.length <= 1 || data.refreshing) {
      const note = document.createElement('div'); note.className = 'season-note';
      note.textContent = data.refreshing ? '已显示缓存，正在后台更新…' : data.refresh_error ? '更新失败，已保留缓存。' :
        data.cached ? '已缓存，下次打开直接读取。' : '季列表已保存到 NAS。';
      if (data.membership === 'title') note.textContent += ' 当前季暂缺平台关联，其他季按同名查找。';
      else if (!data.refreshing && data.partial) note.textContent += ' 列表可能不完整，可手动刷新。';
      if (!data.refreshing && !data.partial && data.items.length <= 1) note.textContent += ' 暂未找到其他季。';
      slot.appendChild(note);
    }
    if (data.refreshing) slot._seasonPoll = setTimeout(() => {
      if (slot.isConnected && location.hash === '#/detail/' + sid) loadSeasons(sid, slot, false, true);
    }, 2000);
  } catch (error) {
    if (!slot.isConnected || location.hash !== '#/detail/' + sid) return;
    if (keepContent) toast('更新失败，已保留显示的季列表');
    else {
      slot.innerHTML = '<h3>全部季</h3><div class="season-note">暂时无法获取其他季。</div>';
      addSeasonRetry(slot, sid, slot.querySelector('.season-note'));
    }
  }
}
function addSeasonRetry(slot, sid, note) {
  const button = document.createElement('button'); button.className = 'season-retry';
  button.type = 'button'; button.textContent = '重试'; button.onclick = () => loadSeasons(sid, slot, true);
  note.appendChild(button);
}
async function bindNextSeasonButton(sid, button, onChange) {
  clearTimeout(button._seasonPoll);
  button.hidden = true; button.disabled = true; button.onclick = null;
  try {
    const data = await fetchSeasons(sid);
    if (!button.isConnected || !location.hash.startsWith('#/watch/' + sid + '/')) return;
    if (data.membership === 'title') { onChange?.(null); return null; }
    const items = Array.isArray(data.items) ? data.items.filter(item => item.available !== false) : [];
    const current = items.find(item => String(item.series_id) === String(sid));
    if (!current) return;
    const currentSeason = Number(current.season) || 0;
    let next = currentSeason > 0 ? items
      .filter(item => String(item.series_id) !== String(sid) && Number(item.season) > currentSeason)
      .sort((a, b) => Number(a.season) - Number(b.season))[0] : null;
    if (!next) {
      const ordered = items.slice().sort((a, b) => (Number(a.season) || Number.MAX_SAFE_INTEGER) - (Number(b.season) || Number.MAX_SAFE_INTEGER));
      const index = ordered.findIndex(item => String(item.series_id) === String(sid));
      if (currentSeason <= 0 && index >= 0) next = ordered[index + 1];
    }
    if (next) {
      button.hidden = false; button.disabled = false;
      button.title = '播放' + (next.title || '下一季') + '第1集';
      button.setAttribute('aria-label', button.title);
      button.onclick = () => go('#/watch/' + next.series_id + '/1/0');
      onChange?.(next);
    } else if (data.refreshing) {
      button._seasonPoll = setTimeout(() => {
        if (button.isConnected && location.hash.startsWith('#/watch/' + sid + '/')) bindNextSeasonButton(sid, button, onChange);
      }, 2000);
    } else {
      onChange?.(null);
    }
    return next || null;
  } catch (_) { onChange?.(null); return null; }
}
