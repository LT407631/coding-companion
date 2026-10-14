(function () {
  'use strict';
  function stored(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  var selected = stored('hg_profile_v1') || 'default', items = [], boot, switching = false;
  function valid(id) { return id === 'default' || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id); }
  if (!valid(selected)) selected = 'default';
  try { items = JSON.parse(stored('hg_profiles_v1')) || []; } catch (_) {}
  if (!Array.isArray(items)) items = [];
  function saveList() { try { localStorage.setItem('hg_profiles_v1', JSON.stringify(items)); } catch (_) {} }
  async function request(body) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 5000);
    try {
      var response = await fetch('/watch-profiles', {method: body ? 'POST' : 'GET', cache: 'no-store', signal: ctl.signal,
        headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
      var data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '暂时无法保存家庭成员');
      return data;
    } finally { clearTimeout(timer); }
  }
  function ready() {
    if (!boot) boot = request().then(function (data) {
      if (!Array.isArray(data.items) || !data.items.length) throw new Error('invalid profiles');
      items = data.items.filter(function (item) { return valid(item.id) && typeof item.name === 'string'; });
      if (!items.some(function (item) { return item.id === selected; })) selected = 'default';
      localStorage.setItem('hg_profile_v1', selected); saveList();
    }).catch(function () {}).then(function () {
      if (!items.length) items = [{id: 'default', name: '默认用户'}];
      return selected;
    });
    return boot;
  }
  function currentName() { var item = items.find(function (item) { return item.id === selected; }); return item ? item.name : '家庭用户'; }
  async function switchTo(id, panel) {
    if (!valid(id) || !items.some(function (item) { return item.id === id; }) || switching || id === selected) return;
    switching = true;
    panel.querySelectorAll('button').forEach(function (button) { button.disabled = true; });
    panel.querySelector('.profile-result').textContent = '正在保存当前用户的记录…';
    // This page retains the old identity until reload. Every in-flight write carries it explicitly.
    await Promise.race([CodingWatchState.sync(), new Promise(function (resolve) { setTimeout(resolve, 3000); })]);
    try { localStorage.setItem('hg_profile_v1', id); } catch (_) {
      switching = false; panel.querySelectorAll('button').forEach(function (button) { button.disabled = false; });
      panel.querySelector('.profile-result').textContent = '本机无法保存选择，请检查存储空间'; return;
    }
    location.reload();
  }
  function settings() {
    var view = document.querySelector('#view'); if (!view || document.querySelector('#family-profiles')) return;
    var panel = document.createElement('section'); panel.id = 'family-profiles'; panel.className = 'setbox';
    panel.innerHTML = '<style>#family-profiles [hidden]{display:none!important}</style><h3>家庭用户</h3><p class="profile-current"></p><p class="note">各自保存历史、播放进度、收藏和首页隐藏。同一用户在不同设备间同步，切换无需额外密码。</p>' +
      '<button type="button" class="ghost profile-toggle" aria-expanded="false">切换用户</button> <button type="button" class="ghost profile-add">添加家庭成员</button>' +
      '<div class="theme-buttons profile-options" role="group" aria-label="选择家庭用户" hidden style="flex-wrap:wrap;margin:12px 0 0;gap:8px;max-width:100%"></div>' +
      '<form class="profile-form" hidden style="margin-top:14px"><label>成员名字 <input class="profile-name" maxlength="20" required autocomplete="off" style="min-height:44px;max-width:100%;padding:8px;color:var(--txt);background:var(--control);border:1px solid var(--line);border-radius:8px"></label> <button type="submit" class="ghost">创建用户</button></form>' +
      '<p class="note profile-result" role="status"></p>';
    view.insertBefore(panel, view.firstChild);
    var options = panel.querySelector('.profile-options'), toggle = panel.querySelector('.profile-toggle'), form = panel.querySelector('.profile-form');
    function render() {
      if (!panel.isConnected) return;
      panel.querySelector('.profile-current').textContent = '当前用户：' + currentName(); options.textContent = '';
      items.forEach(function (item) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'ghost'; button.textContent = item.name;
        button.setAttribute('data-profile', item.id); button.setAttribute('aria-pressed', String(item.id === selected));
        button.onclick = function () { switchTo(item.id, panel); }; options.appendChild(button);
      });
    }
    toggle.onclick = function () { options.hidden = !options.hidden; toggle.setAttribute('aria-expanded', String(!options.hidden));
      if (!options.hidden) (options.querySelector('[aria-pressed="true"]') || options.querySelector('button')).focus(); };
    panel.querySelector('.profile-add').onclick = function () { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); };
    form.onsubmit = async function (event) {
      event.preventDefault(); var submit = form.querySelector('button'); submit.disabled = true;
      try {
        var member = await request({name: form.querySelector('input').value.trim()});
        items.push(member); saveList(); render(); form.reset(); form.hidden = true; options.hidden = false; toggle.setAttribute('aria-expanded', 'true');
        panel.querySelector('.profile-result').textContent = '已创建 ' + member.name + '，选择名字即可切换。新用户没有旧记录。';
        if (panel.isConnected) options.querySelector('[data-profile="' + member.id + '"]').focus();
      } catch (error) { if (panel.isConnected) panel.querySelector('.profile-result').textContent = error.message; }
      finally { submit.disabled = false; }
    };
    ready().then(render);
  }
  window.CodingProfiles = {ready: ready, id: function () { return selected; }, name: currentName,
    headers: function () { return {'X-Watch-Profile': selected}; }, settings: settings};
})();
