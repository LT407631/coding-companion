(function () {
  'use strict';
  if (window.CodingTVAppearance || !window.hgTheme) return;
  var original=window.hgTheme, mode='auto';
  try {mode=localStorage.getItem('hg_tv_theme')||localStorage.getItem('hg_theme')||'auto';} catch (_) {}
  if(['light','dark','auto'].indexOf(mode)<0) mode='auto';
  function apply() {
    if(document.hidden) return;
    var hour=new Date().getHours(), resolved=mode==='auto' ? (hour>=6&&hour<18?'light':'dark') : mode;
    if(original.mode()!==resolved) original.set(resolved);
    document.querySelectorAll('[data-theme-mode]').forEach(function(button){
      if(button.dataset.themeMode==='system') button.dataset.themeMode='auto';
      if(button.dataset.themeMode==='auto' && button.textContent!=='自动切换') {
        button.textContent='自动切换';button.title='每天 06:00 白天、18:00 夜晚（设备当地时间）';
      }
      var pressed=String(button.dataset.themeMode===mode);
      if(button.getAttribute && button.getAttribute('aria-pressed')===pressed) return;
      button.setAttribute('aria-pressed',pressed);
    });
  }
  window.hgTheme={mode:function(){return mode;},set:function(value){
    if(['light','dark','auto'].indexOf(value)<0) return;
    mode=value;try{localStorage.setItem('hg_tv_theme',mode);}catch(_){}apply();
  }};
  window.CodingTVAppearance={refresh:apply};
  setInterval(apply,30000);
  document.addEventListener('visibilitychange',apply);
  window.addEventListener('pageshow',apply);
  apply();
})();
