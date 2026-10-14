(function () {
  'use strict';
  if (window.CodingTVHud) return;
  var minuteTimer, scheduled = false, watchedLabel = null;
  var labelObserver = new MutationObserver(schedule);
  function clock(node) {
    clearTimeout(minuteTimer);
    var now = new Date(), text = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
    if (node.textContent !== text) node.textContent = text;
    minuteTimer = setTimeout(refresh, 60000 - (Date.now() % 60000) + 50);
  }
  function refresh() {
    var stage = document.querySelector('#stage');
    if (document.hidden || !stage || !/^#\/watch\//.test(location.hash)) {
      clearTimeout(minuteTimer);labelObserver.disconnect();watchedLabel=null;return;
    }
    var overlay = stage.querySelector('.tv-corner-info');
    if (!overlay) {
      overlay = document.createElement('div'); overlay.className = 'tv-corner-info';
      overlay.innerHTML = '<span class="tv-corner-episode" aria-label="当前集数"></span><span class="tv-corner-time" aria-label="当前时间"></span>';
      stage.appendChild(overlay);
    }
    var label = document.querySelector('#watch-position'), match = label && label.textContent.match(/第\s*(\d+)\s*集\s*\/\s*共\s*(\d+)\s*集/);
    if(label!==watchedLabel) {
      labelObserver.disconnect();watchedLabel=label;
      if(label) labelObserver.observe(label,{childList:true,characterData:true,subtree:true});
    }
    var episode = overlay.querySelector('.tv-corner-episode'), text = match ? match[1] + ' / ' + match[2] + ' 集' : '';
    episode.hidden = !text;
    if (episode.textContent !== text) episode.textContent = text;
    clock(overlay.querySelector('.tv-corner-time'));
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function() { scheduled = false; refresh(); });
  }
  new MutationObserver(function(records) {
    if (!/^#\/watch\//.test(location.hash) && !watchedLabel) return;
    if(records.some(function(r){return Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(function(n){return n.nodeType===1;});})) schedule();
  }).observe(document.body, {childList: true, subtree: true});
  window.addEventListener('hashchange', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener('visibilitychange', function() { if (document.hidden) refresh(); else schedule(); });
  window.CodingTVHud = {refresh: refresh};
  refresh();
})();
