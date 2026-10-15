'use strict';
// A settings instance owns its reads; writes retain their original NAS semantics.
let settingsPage = null;
function settingsLive(page) { return !!page && settingsPage === page && page.form.isConnected; }
function stopSettings() { if (settingsPage) { settingsPage.exit.abort(); settingsPage.read?.abort(); } settingsPage = null; }
window.CodingSettings = {stop: stopSettings};
function toggleSitePassword() {
  const panel = $('#site-password-panel'), button = $('#site-password-toggle');
  if (!panel || !button) return;
  panel.hidden = !panel.hidden;
  button.setAttribute('aria-expanded', String(!panel.hidden));
  if (panel.hidden) {
    $('#site-password-form').reset();
    $('#site-password-result').textContent = '';
    button.focus();
  } else $('#site-current').focus();
}
async function vSettings() {
  stopSettings();
  renderGtabs(true);
  const deviceSettings = DeviceMedia.settings();
  $('#view').innerHTML = `
    <div class="setbox" id="site-session-panel"><h3>登录与用户</h3>
      <div id="site-session-status" role="status">正在核验登录状态…</div>
      <div class="note" id="site-session-user"></div><div class="note" id="site-session-expiry"></div>
      <p class="note">本站使用共享网站密码。登录有效期内打开会直接进入；家庭用户用于区分各自的观看记录。</p>
      <button class="ghost" type="button" onclick="logoutSite()">退出此设备登录</button>
    </div>
    <div class="settings-password-action" style="margin-bottom:16px"><button class="ghost" id="site-password-toggle" type="button" aria-controls="site-password-panel" aria-expanded="false" onclick="toggleSitePassword()">修改密码</button></div>
    <div class="setbox" id="site-password-panel" hidden><h3>网站密码</h3>
      <div class="note">密码用于局域网和外网的网站访问。修改后，所有设备都需要重新登录。</div>
      <form id="site-password-form" style="max-width:480px;margin-top:16px" onsubmit="changeSitePassword(event)">
        <label for="site-current">当前密码</label><input id="site-current" type="password" autocomplete="current-password" required maxlength="256" style="display:block;width:100%;min-height:46px;padding:10px 12px;margin:8px 0 16px;border:1px solid var(--line);border-radius:9px;background:var(--control);color:var(--txt);font-size:16px">
        <label for="site-new">新密码（至少 8 位）</label><input id="site-new" type="password" autocomplete="new-password" required minlength="8" maxlength="256" style="display:block;width:100%;min-height:46px;padding:10px 12px;margin:8px 0 16px;border:1px solid var(--line);border-radius:9px;background:var(--control);color:var(--txt);font-size:16px">
        <label for="site-confirm">再次输入新密码</label><input id="site-confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="256" style="display:block;width:100%;min-height:46px;padding:10px 12px;margin:8px 0 16px;border:1px solid var(--line);border-radius:9px;background:var(--control);color:var(--txt);font-size:16px">
        <button class="btn-pink" id="site-password-save" type="submit">修改密码并重新登录</button>
        <div class="note" id="site-password-result" role="status" style="margin-top:10px"></div>
      </form>
    </div>
    <div class="setbox"><h3>播放服务</h3>
      <div class="kv"><span class="k">网页播放服务</span><span class="oktag" id="st1">检查中…</span></div>
      <div class="kv"><span class="k">内容获取服务</span><span id="st2">—</span></div>
      <div style="margin-top:10px"><button class="ghost" onclick="refreshSettings()">重新检查</button></div>
    </div>
    <div class="setbox"><h3>播放方式与两类缓存</h3>
      <div class="note">这里包含两套用途不同的缓存：设备缓存只属于当前浏览器，用于设备直连；NAS 视频缓存保存在服务器，供家里所有设备使用。两者不会重复占用同一处空间。</div>
      <h4 class="settings-subtitle">播放线路</h4>
      <div class="kv"><span class="k">播放模式</span><div class="theme-buttons" role="group" aria-label="播放模式">${[['auto','自动'],['nas','NAS'],['device','设备直连']].map(([mode,label])=>`<button type="button" data-play-mode="${mode}" aria-pressed="${deviceSettings.mode===mode}" onclick="setPlayMode('${mode}')">${label}</button>`).join('')}</div></div>
      <div class="note" id="device-mode-status"></div>
      <div class="note" style="margin-top:8px">自动模式按访问地址选择线路。HTTP 可使用 NAS 播放；设备直连依赖浏览器安全环境，在 HTTPS 页面可用。</div>
      <h4 class="settings-subtitle">当前设备缓存（仅此浏览器）</h4>
      <div class="kv"><label class="k" for="device-ahead">设备提前缓存集数</label><select id="device-ahead">${[1,2,3,4,5].map(n=>`<option value="${n}">${n} 集</option>`).join('')}</select></div>
      <div class="kv"><label class="k" for="device-limit">设备缓存容量上限</label><select id="device-limit">${[100,250,500,1000].map(n=>`<option value="${n}">${n} MB</option>`).join('')}</select></div>
      <div class="kv"><label for="device-previous">自然播完一集后清理本季当前及之前集</label><input id="device-previous" type="checkbox"></div>
      <div class="kv"><label for="device-cleanup">本季全部播完后清理本季设备缓存</label><input id="device-cleanup" type="checkbox"></div>
      <div class="note" id="device-usage">正在读取设备缓存…</div>
      <div class="note" style="margin-top:10px">缓存仅保存在当前浏览器，默认提前 3 集；容量不足时清理较旧缓存。退出播放页停止预缓存，已完成缓存保留。浏览器可能自行释放存储；不同访问地址的缓存不共用。直连失败不会自动切回 NAS。</div>
      <h4 class="settings-subtitle">NAS 视频缓存（家庭共享）</h4>
      <div class="note">视频在 NAS 提前下载、解密并检查。缓存和设置都保存在 NAS，同一网站下的手机、电脑和电视共同使用。</div>
      <div class="kv"><label class="k" for="cache-mode">缓存方式</label><select id="cache-mode">
        <option value="off">关闭预缓存</option><option value="ahead">提前缓存后续几集</option>
        <option value="full">缓存本季全部剩余集</option><option value="smart">智能：连续看完后缓存剩余集</option></select></div>
      <div class="kv"><label class="k" for="cache-ahead">提前缓存集数</label><select id="cache-ahead">${Array.from({length:10}, (_,i) => `<option value="${i+1}">${i+1} 集</option>`).join('')}</select></div>
      <div class="kv"><label class="k" for="cache-smart">智能模式触发条件</label><select id="cache-smart">${Array.from({length:9}, (_,i) => `<option value="${i+2}">连续看完 ${i+2} 集</option>`).join('')}</select></div>
      <div class="kv"><label class="k" for="cache-limit">视频缓存容量上限</label><select id="cache-limit">${[1,5,10,20,30,50].map(n => `<option value="${n}">${n} GB</option>`).join('')}</select></div>
      <div class="kv"><label for="cache-previous">逐集动态清理：播完当前集后清理本季当前及之前集</label><input id="cache-previous" type="checkbox"></div>
      <div class="kv"><label for="cache-cleanup">看完本季最后一集后清理视频缓存</label><input id="cache-cleanup" type="checkbox"></div>
      <div class="note" id="cache-usage">正在读取缓存设置…</div>
      <div class="note" style="margin-top:10px">默认提前 5 集。当前播放优先，后台逐集准备；退出播放页后停止排队，已完成缓存保留。智能模式只计算连续自然播完的集数，手动跳集会重新计算。<br>保留至少 2 GB 磁盘空间；达到上限时暂停预缓存。动态清理只在自然播完时触发，手动跳集不触发；开启后，整季播完也会清理本季全部视频。正在使用的视频会延后释放。不影响收藏、进度或手工下载。</div>
      <button class="ghost" id="cache-save" disabled style="margin-top:14px">保存播放与缓存设置</button>
      <button class="btn-line" onclick="clearDeviceCache()" style="margin-top:14px">清除此设备视频缓存</button>
    </div>
    <div class="setbox"><h3>一键清理</h3>
      <div class="note">清除 NAS 上的网站视频、片单、封面和全部季缓存，暂停现有播放会话的后台预缓存。正在播放的视频延后释放；切换集或重新进入播放页后恢复预缓存。收藏、观看进度、设置和手工下载保留。</div>
      <button class="btn-line" id="cache-clear" style="margin-top:14px" disabled>清除所有缓存</button>
      <div class="note" id="cache-clear-result" role="status" style="margin-top:10px"></div>
    </div>
    <div class="setbox"><h3>关于</h3>
      <div class="note">
        coding伴侣 · Vibe Coding 时，陪你看会儿剧。<br>
        NAS 网页版（非官方，与内容平台无关，仅供个人学习研究）。<br>
        内容来自红果内容服务，仅供学习研究；观看进度/收藏通过同一 NAS 同步；各设备保留本地副本。<br>
        首次播放需准备视频；已缓存的集数直接播放。预缓存可减少连播等待，源服务或网络异常时仍可能需要重试。<br>
        请勿用于商业用途或公开分发。
      </div>
    </div>`;
  CodingWatchUI.settings();
  if (window.CodingProfiles) CodingProfiles.settings();
  settingsPage = {form:$('#site-password-form'), ready:false, pending:null, read:null, exit:new AbortController()};
  loadSiteSession(settingsPage);
  initDeviceSettings();
  return refreshSettings();
}

function refreshSettings() {
  const page = settingsPage;
  if (!settingsLive(page)) return;
  if (page.pending) return page.pending;
  page.read = new AbortController();
  $('#st1').textContent = '检查中…'; $('#st2').textContent = '检查中…';
  page.pending = Promise.all([loadCacheSettings(page, page.read.signal), checkContentService(page, page.read.signal)]).finally(() => {
    if (settingsLive(page)) { page.pending = null; page.read = null; }
  });
  return page.pending;
}
async function checkContentService(page, signal) {
  try {
    await api('/healthz', {signal});
    if (!settingsLive(page)) return;
    $('#st2').textContent = '运行中'; $('#st2').className = 'oktag'; $('#st2').style.color = '';
  } catch (_) { if (settingsLive(page)) { $('#st2').textContent = '未连接'; $('#st2').style.color = '#e0304e'; } }
}
async function loadCacheSettings(page, signal) {
  try {
    const data = await api('/playback/settings', {signal});
    if (!settingsLive(page)) return;
    if (!page.ready) {
      const c = data.settings;
      $('#cache-mode').value = c.mode; $('#cache-ahead').value = c.ahead;
      $('#cache-smart').value = c.smart_after; $('#cache-limit').value = c.limit_gb;
      $('#cache-cleanup').checked = c.cleanup;
      $('#cache-previous').checked = !!c.cleanup_previous;
      const cleanupOptions = () => {
        const dynamic = $('#cache-previous').checked;
        if (dynamic) $('#cache-cleanup').checked = true;
        $('#cache-cleanup').disabled = dynamic;
      };
      $('#cache-previous').addEventListener('change', cleanupOptions); cleanupOptions();
      const options = () => { $('#cache-ahead').disabled = ['off','full'].includes($('#cache-mode').value); $('#cache-smart').disabled = $('#cache-mode').value !== 'smart'; };
      $('#cache-mode').addEventListener('change', options); options();
      const clear = $('#cache-clear'); clear.disabled = false;
      clear.onclick = async () => {
        if (!settingsLive(page)) return;
        if (!confirm('清除 NAS 上所有网站缓存？视频、片单、封面、季列表需重新获取。收藏、观看进度、设置和手工下载保留。正在播放的视频会延后清理。')) return;
        clear.disabled = true; $('#cache-clear-result').textContent = '正在清理…';
        try {
          const response = await fetch('/cache/clear', {method:'POST'});
          if (!response.ok) throw new Error('清理失败');
          const result = await response.json();
          cache.filters = {}; cache.eps = {}; cache.meta = {};
          if (!settingsLive(page)) return;
          const usage = await api('/playback/settings', {signal:page.exit.signal});
          if (!settingsLive(page)) return;
          $('#cache-usage').textContent = `视频缓存已用 ${(usage.used_bytes / 1024**3).toFixed(2)} GB · NAS 可用 ${(usage.free_bytes / 1024**3).toFixed(1)} GB`;
          $('#cache-clear-result').textContent = result.deferred_videos ? `已清理。${result.deferred_videos} 个正在使用或准备的视频将在释放后清理；后台预缓存已暂停。` : '所有网站缓存已清理，后台预缓存已暂停。';
          toast('缓存清理完成');
        } catch (_) { if (settingsLive(page)) $('#cache-clear-result').textContent = '清理失败，请重试'; }
        finally { if (settingsLive(page)) clear.disabled = false; }
      };
      const save = $('#cache-save'); save.disabled = false;
      save.onclick = async () => {
        if (!settingsLive(page)) return;
        save.disabled = true;
        try {
          const response = await fetch('/playback/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode:$('#cache-mode').value, ahead:+$('#cache-ahead').value, smart_after:+$('#cache-smart').value, limit_gb:+$('#cache-limit').value, cleanup:$('#cache-cleanup').checked, cleanup_previous:$('#cache-previous').checked})});
          if (!response.ok) throw new Error('保存失败');
          DeviceMedia.save({ahead:+$('#device-ahead').value,limit:+$('#device-limit').value,previous:$('#device-previous').checked,cleanup:$('#device-cleanup').checked});
          if (settingsLive(page)) toast('播放与缓存设置已保存，播放页会自动采用');
        } catch (_) { if (settingsLive(page)) toast('设置保存失败，请重试'); } finally { if (settingsLive(page)) save.disabled = false; }
      };
      page.ready = true;
    }
    $('#cache-usage').textContent = `视频缓存已用 ${(data.used_bytes / 1024**3).toFixed(2)} GB · NAS 可用 ${(data.free_bytes / 1024**3).toFixed(1)} GB`;
    $('#st1').textContent = '已连接';
  } catch (_) { if (settingsLive(page)) { $('#cache-usage').textContent = '无法读取缓存设置，请重新检查服务'; $('#st1').textContent = '未连接'; } }
}
function setPlayMode(mode, persist = true) {
  if (!settingsLive(settingsPage)) return;
  if (persist && DeviceMedia.settings().mode !== mode) DeviceMedia.save({mode});
  document.querySelectorAll('[data-play-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.playMode===mode)));
  $('#device-mode-status').textContent = `当前生效模式：${DeviceMedia.mode()==='device'?'设备直连':'NAS 播放'} · 设置立即保存，下次进入播放页生效`;
}
async function initDeviceSettings(page = settingsPage) {
  if (!settingsLive(page)) return;
  const s=DeviceMedia.settings();
  $('#device-ahead').value=s.ahead; $('#device-limit').value=s.limit;
  $('#device-previous').checked=s.previous; $('#device-cleanup').checked=s.cleanup;
  setPlayMode(s.mode, false);
  try {const usage=await DeviceMedia.usage();if(settingsLive(page)) $('#device-usage').textContent=`此设备已缓存 ${usage.episodes} 集 · ${(usage.bytes/1024**2).toFixed(1)} MB`;} catch (_) {if(settingsLive(page)) $('#device-usage').textContent='此浏览器无法使用设备缓存；NAS 模式仍可使用';}
}
async function clearDeviceCache() {
  const page = settingsPage;
  try {await DeviceMedia.clear();if (!settingsLive(page)) return;await initDeviceSettings(page);if (settingsLive(page)) toast('此设备视频缓存已清理');} catch (_) {if (settingsLive(page)) toast('设备缓存清理失败，请重试');}
}


async function loadSiteSession(page) {
  try {
    const response = await fetch('/auth/session', {cache:'no-store', signal:page.exit.signal});
    if (!response.ok) throw new Error('无法核验登录状态');
    const session = await response.json();
    if (!session.authenticated || session.auth_type !== 'shared_password') throw new Error('登录状态无效');
    if (window.CodingProfiles) await CodingProfiles.ready();
    if (!settingsLive(page)) return;
    $('#site-session-status').textContent = '网站登录：已登录（共享密码验证）';
    $('#site-session-user').textContent = '当前家庭用户：' + (window.CodingProfiles ? CodingProfiles.name() : '默认用户');
    $('#site-session-expiry').textContent = '此设备登录有效至：' + new Date(session.expires_at * 1000).toLocaleString();
  } catch (error) {
    if (settingsLive(page) && error.name !== 'AbortError') $('#site-session-status').textContent = '暂时无法核验登录状态，请重新打开设置';
  }
}
