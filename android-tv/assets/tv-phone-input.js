(function () {
  'use strict';
  if (window.CodingTVPhone) return;
  var state = null, modal = null, trigger = null, network = 'auto', installedTV = null;
  function externalAddress() {return window.CodingTVConnection && window.CodingTVConnection.wan || '';}
  function message(text) { if (modal) modal.querySelector('.tv-phone-message').textContent = text; }
  function request(path, method, body) {
    var controller = new AbortController(), timer = setTimeout(function () {controller.abort();}, 10000);
    return fetch(path, {method:method || 'GET', credentials:'same-origin', cache:'no-store', headers:body ? {'Content-Type':'application/json'} : undefined, body:body ? JSON.stringify(body) : undefined, signal:controller.signal}).then(function (response) {
      return response.json().catch(function () {
        if (response.ok) throw new Error('手机输入服务响应格式异常，请检查 NAS 服务。');
        return {};
      }).then(function (data) {
        if (!response.ok) {var error = new Error(typeof data.detail === 'string' ? data.detail : '手机输入暂不可用'); error.status = response.status; throw error;}
        return data;
      });
    }).then(function (data) {clearTimeout(timer);return data;}, function (error) {clearTimeout(timer);throw error;});
  }
  function disposePair(pair) { return request('/phone-input/pairs/' + encodeURIComponent(pair), 'DELETE').catch(function () {}); }
  function hide() {
    if (!modal) return;
    modal.remove(); modal = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }
  function stop() {
    var old = state; state = null;
    if (old) {clearTimeout(old.timer); if (old.pair) disposePair(old.pair);}
    if (trigger) {trigger.textContent = '手机输入'; trigger.classList.remove('paired');}
    hide();
  }
  function draw() {
    if (modal) return;
    modal = document.createElement('div');modal.className = 'tv-phone-overlay';
    modal.innerHTML = '<section class="tv-phone-panel" role="dialog" aria-modal="true" aria-labelledby="tv-phone-heading"><div><p class="tv-phone-eyebrow">手机键盘 · 电视搜索</p><h2 id="tv-phone-heading">扫码输入，轻松找剧</h2><p>打开手机相机，扫描右侧二维码。<br>输入剧名或演员，发送后电视直接搜索。</p><p class="tv-phone-message" role="status">正在生成二维码…</p><div class="tv-phone-actions"><button type="button" class="tv-phone-renew">重新配对</button><button type="button" class="tv-phone-close">取消配对</button></div><p class="tv-phone-note"></p><button type="button" class="tv-phone-fallback"></button></div><div class="tv-phone-qr"><img alt="手机输入配对二维码" hidden><span>正在准备</span></div></section>';
    document.body.appendChild(modal);
    modal.querySelector('.tv-phone-close').onclick = stop;
    var external = externalAddress(), fallback = modal.querySelector('.tv-phone-fallback');
    modal.querySelector('.tv-phone-note').textContent = (network === 'local' || !external ? '当前使用内网地址，请让手机连接电视所在网络。' : '已使用外网地址，手机可使用 Wi-Fi 或蜂窝网络。') + ' 扫码后按网站密码登录，可连续搜索。';
    fallback.hidden = !external;
    fallback.textContent = network === 'local' ? '改用外网地址' : '扫码打不开？改用内网地址';
    fallback.onclick = function () {stop();network = network === 'local' ? 'auto' : 'local';return open();};
    modal.querySelector('.tv-phone-renew').onclick = function () {stop();open();};
    modal.querySelector('.tv-phone-close').focus();
  }
  function showQR(current) {
    if (!modal || !current.pair) return;
    var image = modal.querySelector('img'), label = modal.querySelector('.tv-phone-qr span');
    image.onload = function () {if (state === current && modal) {label.hidden = true; image.hidden = false;}};
    image.onerror = function () {if (state === current) {label.textContent = '生成失败'; message('二维码暂时无法读取，请选择“重新配对”。');}};
    image.src = '/phone-input/pairs/' + encodeURIComponent(current.pair) + '/qr';
    message('配对有效期 ' + Math.ceil(Math.max(0, current.deadline - Date.now()) / 60000) + ' 分钟');
  }
  function poll(current) {
    if (state !== current) return;
    if (Date.now() >= current.deadline) {stop();return;}
    return request('/phone-input/pairs/' + encodeURIComponent(current.pair)).then(function (data) {
      if (state !== current) return;
      current.deadline = Date.now() + data.expires_in * 1000;
      if (data.version > current.version && data.query) {
        var input = document.querySelector('#q');
        // The server supplies plain text only; never interpret phone input as HTML or a URL.
        if (input && typeof doSearch === 'function') {
          input.value = data.query; current.version = data.version;
          hide();doSearch();
        }
      }
      if (modal) message('配对有效期 ' + Math.ceil(data.expires_in / 60) + ' 分钟，等待手机输入');
    }).catch(function (error) {
      if (state !== current) return;
      if (error.status === 401 || error.status === 404) {stop();return;}
      message('连接暂时中断，正在重连；也可取消后重新配对。');
    }).then(function () {if (state === current) current.timer = setTimeout(function () {poll(current);}, 1500);});
  }
  function open() {
    draw();
    if (state && state.pair) {showQR(state);return;}
    if (state) return;
    var current = {version:0}; state = current;
    var origin = network === 'local' ? '' : externalAddress();
    return request('/phone-input/pairs', 'POST', {public_origin:origin}).then(function (data) {
      if (state !== current) {disposePair(data.pair);return;}
      current.pair = data.pair; current.deadline = Date.now() + data.expires_in * 1000;
      if (trigger) {trigger.textContent = '手机已配对';trigger.classList.add('paired');}
      showQR(current);poll(current);
    }).catch(function (error) {
      if (state !== current) return;
      state = null;
      message(error.status === 401 ? '请先在电视登录网站，再重新配对。' : error.status === 404 ? '请确认 NAS 已更新手机输入服务，再重新配对。' : error.message || '暂时无法配对，请重试。');
      if (modal) modal.querySelector('.tv-phone-qr span').textContent = '暂不可用';
    });
  }
  function handleKey(code) {
    if (!modal) return false;
    if (code === 4) {stop();return true;}
    if ([19,20,21,22,23,66].indexOf(code) !== -1) {
      var buttons = Array.from(modal.querySelectorAll('button')).filter(function (button) {return !button.hidden;}), index = buttons.indexOf(document.activeElement);
      if (code === 23 || code === 66) (buttons[index < 0 ? buttons.length - 1 : index]).click();
      else buttons[Math.max(0, Math.min(buttons.length - 1, (index < 0 ? buttons.length - 1 : index) + (code === 21 || code === 19 ? -1 : 1)))].focus();
      return true;
    }
    return true;
  }
  function installKeys() {
    if (!window.CodingTV || installedTV === window.CodingTV) return;
    installedTV = window.CodingTV;
    var originalKey = CodingTV.key, originalBack = CodingTV.back;
    CodingTV.key = function (code) {return handleKey(code) || originalKey(code);};
    CodingTV.back = function () {return handleKey(4) || originalBack();};
  }
  function refresh() {
    var input = document.querySelector('#q');
    if (!input || document.querySelector('#tv-phone-input')) return;
    trigger = document.createElement('button');trigger.id = 'tv-phone-input';trigger.type = 'button';
    trigger.textContent = state && state.pair ? '手机已配对' : '手机输入';trigger.onclick = open;
    input.parentElement.insertAdjacentElement('afterend', trigger);
  }
  var keyMap = {ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Enter:23,Escape:4};
  document.addEventListener('keydown', function (event) {
    if (modal && handleKey(keyMap[event.key] || 0)) {event.preventDefault();event.stopImmediatePropagation();}
  }, true);
  window.addEventListener('pagehide', stop);
  // Logged-out pages remove the search input; discard the old TV pairing.
  new MutationObserver(function (records) {
    if (!records.some(function(r){return Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(function(n){return n.nodeType===1;});})) return;
    if (!document.querySelector('#q') && state) stop();refresh();
  }).observe(document.body, {childList:true,subtree:true});
  window.CodingTVPhone = {open:open,stop:stop,handleKey:handleKey,installKeys:installKeys};
  refresh();
})();
