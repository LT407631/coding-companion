// Season discovery and refresh UI; playback stays in the existing detail route.
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
async function loadSeasons(sid, slot, refresh = false, keepContent = false) {
  clearTimeout(slot._seasonPoll);
  if (!keepContent) slot.innerHTML = '<h3>全部季</h3><div class="season-note" role="status">首次查找其他季，结果会保存到 NAS…</div>';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const hint = seasonSearchHints.get(String(sid));
    const response = await fetch('/seasons?series_id=' + encodeURIComponent(sid) + (refresh ? '&refresh=true' : '') + (hint ? '&search_hint=' + encodeURIComponent(hint) : ''), { signal: ctl.signal });
    if (!response.ok) throw new Error('获取失败');
    const data = await response.json();
    if (!slot.isConnected || location.hash !== '#/detail/' + sid) return;
    slot.innerHTML = `<h3>全部季（${data.items.length}）</h3><div class="season-list"></div>`;
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
      button.textContent = (item.season ? '第' + item.season + '季' : item.title) + (current ? ' · 当前' : '');
      button.title = item.title + ' · 全' + item.episode_cnt + '集';
      if (current) button.setAttribute('aria-current', 'page');
      button.onclick = () => go('#/detail/' + item.series_id);
      list.appendChild(button);
    });
    if (data.cached || data.partial || data.items.length <= 1 || data.refreshing) {
      const note = document.createElement('div'); note.className = 'season-note';
      note.textContent = data.refreshing ? '已显示缓存，正在后台更新…' : data.refresh_error ? '更新失败，已保留缓存。' :
        data.cached ? '已缓存，下次打开直接读取。' : '季列表已保存到 NAS。';
      if (!data.refreshing && data.partial) note.textContent += ' 列表可能不完整，可手动刷新。';
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
  } finally { clearTimeout(timer); }
}
function addSeasonRetry(slot, sid, note) {
  const button = document.createElement('button'); button.className = 'season-retry';
  button.type = 'button'; button.textContent = '重试'; button.onclick = () => loadSeasons(sid, slot, true);
  note.appendChild(button);
}
