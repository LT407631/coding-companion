(function () {
  'use strict';
  var params = new URLSearchParams(location.hash.slice(1));
  var pair = params.get('pair'), key = params.get('key');
  // Keep the pairing secret out of visible address bars and subsequent links.
  history.replaceState(null, '', location.pathname);
  var form = document.querySelector('#phone-form'), input = document.querySelector('#keyword');
  var button = document.querySelector('#send'), status = document.querySelector('#status');
  if (!pair || !key) {
    button.disabled = true; status.textContent = '请用手机扫描电视上的“手机输入”二维码。'; return;
  }
  status.textContent = '已打开手机输入，发送后电视会显示搜索结果。';
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var query = input.value.trim();
    if (!query || button.disabled) return;
    button.disabled = true; status.textContent = '正在发送…';
    var controller = new AbortController(), timer = setTimeout(function () {controller.abort();}, 10000);
    var expired = false;
    try {
      var response = await fetch('/phone-input/search', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pair:pair, key:key, query:query}), signal:controller.signal});
      var data = await response.json();
      if (response.status === 401) {
        location.replace('/login?next=%2Fphone-input#' + new URLSearchParams({pair:pair,key:key})); return;
      }
      expired = response.status === 404;
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '暂时无法发送，请重试');
      status.textContent = '已发送“' + query + '”，可继续输入其他内容。';
    } catch (error) {
      status.textContent = error.name === 'AbortError' ? '连接超时，请检查网络后重试。' : error.message || '连接失败，请重试。';
    } finally { clearTimeout(timer); button.disabled = expired; }
  });
})();
