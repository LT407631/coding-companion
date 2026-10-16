(function () {
  'use strict';
  if (window.CodingTV) return;
  var selector = 'button,a[href],input,select,textarea,[role="button"],[role="slider"],[onclick],.chip,video';
  // Tabler Icons (MIT), https://github.com/tabler/tabler-icons; license bundled in assets.
  var icons={"player-skip-back":"<svg class=\"tv-icon-player-skip-back\" aria-hidden=\"true\" focusable=\"false\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M20 5v14l-12 -7l12 -7\" /> <path d=\"M4 5l0 14\" /> </svg>","player-play":"<svg class=\"tv-icon-player-play\" aria-hidden=\"true\" focusable=\"false\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M7 4v16l13 -8l-13 -8\" /> </svg>","player-pause":"<svg class=\"tv-icon-player-pause\" aria-hidden=\"true\" focusable=\"false\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12\" /> <path d=\"M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12\" /> </svg>","player-skip-forward":"<svg class=\"tv-icon-player-skip-forward\" aria-hidden=\"true\" focusable=\"false\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M4 5v14l12 -7l-12 -7\" /> <path d=\"M20 5l0 14\" /> </svg>","repeat":"<svg class=\"tv-icon-repeat\" aria-hidden=\"true\" focusable=\"false\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M17 2l4 4l-4 4\"/><path d=\"M3 11v-1a4 4 0 0 1 4-4h14\"/><path d=\"M7 22l-4-4l4-4\"/><path d=\"M21 13v1a4 4 0 0 1-4 4H3\"/></svg>","maximize":"<svg class=\"tv-icon-maximize\" aria-hidden=\"true\" focusable=\"false\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M4 8v-2a2 2 0 0 1 2 -2h2\" /> <path d=\"M4 16v2a2 2 0 0 0 2 2h2\" /> <path d=\"M16 4h2a2 2 0 0 1 2 2v2\" /> <path d=\"M16 20h2a2 2 0 0 0 2 -2v-2\" /> </svg>","list":"<svg class=\"tv-icon-list\" aria-hidden=\"true\" focusable=\"false\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M9 6l11 0\" /> <path d=\"M9 12l11 0\" /> <path d=\"M9 18l11 0\" /> <path d=\"M5 6l0 .01\" /> <path d=\"M5 12l0 .01\" /> <path d=\"M5 18l0 .01\" /> </svg>"};
  var returning = /^#\/watch\//.test(location.hash) ? '#video' : /^#\/history(?:$|[/?])/.test(location.hash) ? '.hrow' : location.pathname === '/ui' ? '.card' : null;
  var lastHash = location.hash, timer, backDeadline=0, backPage='', searchEditing=null;
  var settingsLast=null, settingsColumn=0;
  function stopSearchEditing() {
    if (!searchEditing) return false;
    var input=searchEditing;searchEditing=null;input.readOnly=true;
    if(document.activeElement===input) {input.blur();input.focus({preventScroll:true});}
    return true;
  }
  function editSearch(input) {
    input.blur();
    searchEditing=input;input.readOnly=false;
    input.focus({preventScroll:true});
  }
  function player() { return document.querySelector('video'); }
  function historyTarget() {
    return /^#\/history(?:$|[/?])/.test(location.hash) ? document.querySelector('.hrow')||document.querySelector('.nav[data-nav="history"]') : null;
  }
  function visible(el) {
    if (!el || !el.isConnected || el.disabled || el.hidden || el.tabIndex < 0) return false;
    if (el.classList.contains('favbtn') && el.closest && el.closest('.card')) return false;
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || s.visibility === 'hidden' || s.display === 'none') return false;
    for (var p = el.parentElement; p; p = p.parentElement) {
      if (p.hidden || getComputedStyle(p).display === 'none') return false;
    }
    return true;
  }
  function candidates() { return Array.from(document.querySelectorAll(selector)).filter(visible); }
  function settingsRows() {
    var rows=[];
    Array.from(document.querySelectorAll('#view '+selector.split(',').join(',#view '))).filter(visible)
      .map(function(el){return {el:el,rect:el.getBoundingClientRect()};})
      .sort(function(a,b){return a.rect.top-b.rect.top||a.rect.left-b.rect.left;})
      .forEach(function(entry){
        var r=entry.rect, row=rows[rows.length-1];
        if(!row||Math.min(row.bottom,r.bottom)-Math.max(row.top,r.top)<Math.min(row.height,r.height)/2) {
          row={top:r.top,bottom:r.bottom,height:r.height,items:[]};rows.push(row);
        }
        row.top=Math.max(row.top,r.top);row.bottom=Math.min(row.bottom,r.bottom);
        row.items.push(entry);
      });
    return rows.map(function(row){return row.items.sort(function(a,b){return a.rect.left-b.rect.left;}).map(function(entry){return entry.el;});});
  }
  function settingsKey(el,code) {
    if(location.hash!=='#/settings'||!el||!el.closest) return false;
    var view=document.querySelector('#view'), side=el.closest('.side');
    if(!view||(!view.contains(el)&&!side)) return false;
    var rows=settingsRows();if(!rows.length) return false;
    if(side) {
      if(code===22) {focus(visible(settingsLast)?settingsLast:rows[0][0]);return true;}
      if(code===21) return true;
      var navs=Array.from(document.querySelectorAll('.side .nav')).filter(visible), index=navs.indexOf(el);
      if(index!==-1) {focus(navs[Math.max(0,Math.min(navs.length-1,index+(code===19?-1:1)))]);return true;}
      return false;
    }
    var rowIndex=rows.findIndex(function(row){return row.indexOf(el)!==-1;});
    if(rowIndex===-1) return false;
    var row=rows[rowIndex], column=row.indexOf(el);
    if(el!==settingsLast) settingsColumn=column;
    settingsLast=el;
    if(code===19||code===20) {
      var nextRow=rows[Math.max(0,Math.min(rows.length-1,rowIndex+(code===19?-1:1)))];
      if(nextRow!==row) {settingsLast=nextRow[Math.min(settingsColumn,nextRow.length-1)];focus(settingsLast);}
      return true;
    }
    // Text fields retain native cursor movement and SELECTs retain their picker.
    if(/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)&&el.type!=='checkbox'&&!el.readOnly) return false;
    var nextColumn=Math.max(0,Math.min(row.length-1,column+(code===21?-1:1)));
    if(code===21&&column===0) {focus(document.querySelector('.side .nav[data-nav="settings"]'));return true;}
    settingsColumn=nextColumn;settingsLast=row[nextColumn];focus(settingsLast);return true;
  }
  function homeHeaderKey(el,code) {
    if((code!==19&&code!==20)||!el||!el.closest||!visible(el)) return false;
    if(location.hash&&location.hash!=='#'&&!/^#\/discover(?:$|[/?])/.test(location.hash)) return false;
    var library=document.querySelector('.library');
    if(!library) return false;
    function selected(root,active,group) {
      var target=root.querySelector(active);
      return visible(target)?target:Array.from(root.querySelectorAll(group)).find(visible);
    }
    var target=null;
    if(code===19&&el.closest('.library-themes')) target=selected(library,'.library-order.on','.library-order');
    else if(el.closest('.library-orders')) {
      target=code===19?selected(document,'.gtab.on','.gtab'):selected(library,'.library-themes .on','.library-themes button');
    } else if(code===20&&el.classList.contains('gtab')) target=selected(library,'.library-order.on','.library-order');
    if(!target) return false;
    focus(target);return true;
  }
  function focus(el) {
    if (!el) return;
    el.focus({preventScroll:true});
    el.scrollIntoView({block:'nearest',inline:'nearest'});
    var header=document.querySelector('.top');
    if(header&&el.closest&&el.closest('.view')&&!document.body.classList.contains('watching')) {
      var top=header.getBoundingClientRect().bottom, r=el.getBoundingClientRect();
      if(r.top<top+12) window.scrollBy(0,r.top-top-12);
    }
    var bar = document.querySelector('.tv-controls');
    if (bar) { bar.hidden = !(el === player() || bar.contains(el)); if (!bar.hidden) scheduleHide(); }
  }
  function scheduleHide() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var bar = document.querySelector('.tv-controls');
      if (bar && document.activeElement === player()) bar.hidden = true;
    }, 5000);
  }
  // Prefer the same row/column; distance breaks ties so diagonals stay predictable.
  function nearest(origin, entries, direction) {
    var x = origin.left + origin.width/2, y = origin.top + origin.height/2;
    var best = null, score = Infinity, vertical = direction === 'up' || direction === 'down';
    entries.forEach(function (entry) {
      var r = entry.rect, dx = r.left + r.width/2 - x, dy = r.top + r.height/2 - y;
      var forward = direction === 'up' ? -dy : direction === 'down' ? dy : direction === 'left' ? -dx : dx;
      if (forward < 2) return;
      var cross = Math.abs(vertical ? dx : dy);
      var aligned = vertical ? (r.right > origin.left && r.left < origin.right) : (r.bottom > origin.top && r.top < origin.bottom);
      var value = forward + cross*3 + (aligned ? 0 : 10000);
      if (value < score) { score = value; best = entry.el; }
    });
    return best;
  }
  function seek(delta) {
    var v = player();
    if (v && Number.isFinite(v.duration) && v.duration > 0) v.currentTime = Math.max(0,Math.min(v.duration-.25,v.currentTime+delta));
    showControls();
  }
  function toggle() { var v=player(); if (v) { if(v.paused) v.play().catch(function(){}); else v.pause(); } showControls(); }
  function showControls() { var bar=document.querySelector('.tv-controls'); if(bar) {bar.hidden=false;scheduleHide();} }
  function step(n) { if (typeof W !== 'undefined' && W.step) W.step(n); }
  function syncAutoNext(button) {
    if(!button) return;
    var enabled=typeof W!=='undefined' && W.auto!==false, text='自动下一集：'+(enabled?'开':'关');
    button.setAttribute('aria-pressed',String(enabled));button.setAttribute('aria-label',text);button.title=text;
    if(button._tvLabel) button._tvLabel.textContent=text;
  }
  function toggleAutoNext(button) {
    if(typeof W==='undefined') return;
    if(typeof W.toggleAuto==='function') W.toggleAuto(); else W.auto=!W.auto;
    syncAutoNext(button);showControls();
  }
  function closeEpisodes() {
    document.documentElement.classList.remove('tv-episodes-open');
    focus(player());
  }
  function openEpisodes() {
    var drawer=document.querySelector('#drawer');
    if (!drawer) return;
    if(drawer.classList.contains('hidden')&&typeof W!=='undefined') W.toggleDrawer();
    if(document.documentElement.classList.contains('tv-fullscreen')||document.fullscreenElement) {
      document.documentElement.classList.add('tv-episodes-open');
    }
    refresh();focus(document.querySelector('.ditem.cur')||document.querySelector('.ditem'));
  }
  function fullscreen() {
    var v=player(); if (!v) return;
    document.documentElement.classList.remove('tv-episodes-open');
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.classList.toggle('tv-fullscreen');
    focus(v);
  }
  function back() {
    if(stopSearchEditing()) return true;
    var hash=location.hash, watch=hash.match(/^#\/watch\/(\d+)/);
    if(hash==='#/settings' && closePassword()) return true;
    if (watch) {
      if(document.documentElement.classList.contains('tv-episodes-open')) {
        backDeadline=0;backPage='';closeEpisodes();return true;
      }
      var now=Date.now();
      if (backPage===hash && backDeadline>0 && now<=backDeadline) {
        backDeadline=0;backPage='';
        if (document.fullscreenElement) document.exitFullscreen();
        document.documentElement.classList.remove('tv-episodes-open');
        document.documentElement.classList.remove('tv-fullscreen');
        location.hash='#/detail/'+watch[1];return true;
      }
      backPage=hash;backDeadline=now+2000;
      var bar=document.querySelector('.tv-controls'), v=player(), active=document.activeElement;
      if (bar && !bar.hidden && (active===v || bar.contains(active))) {
        focus(v);clearTimeout(timer);bar.hidden=true;
      } else {
        showControls();focus(document.querySelector('.tv-play')||v);
      }
      return true;
    }
    backDeadline=0;backPage='';
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    if (document.documentElement.classList.contains('tv-fullscreen')) {document.documentElement.classList.remove('tv-fullscreen');focus(player());return true;}
    if (hash && hash !== '#' && hash !== '#/discover') { location.hash='#/discover'; return true; }
    return false;
  }
  function randomKey(code) {
    var random=window.CodingRandomPlay;
    if(!random||typeof random.active!=='function'||!random.active()) return false;
    if(code===19||code===20) {random.shift(code===19?-1:1);return true;}
    if(code===23||code===66) {random.accept(typeof W==='undefined'?null:W);return true;}
    return false;
  }
  function key(code) {
    var dirs={19:'up',20:'down',21:'left',22:'right'}, el=document.activeElement, v=player();
    if (code===4) return back();
    backDeadline=0;backPage='';
    if(randomKey(code)) return true;
    if (code===82) {
      if(v&&/^#\/watch\//.test(location.hash)) {stopSearchEditing();fullscreen();}
      return true;
    }
    if ([85,126,127,89,90,87,88].includes(code)) {
      if(!v) return false;
      if(code===85) toggle();
      else if(code===126) v.play().catch(function(){});
      else if(code===127) v.pause();
      else if(code===89||code===90) seek(code===89?-10:10);
      else step(code===87?1:-1);
      return true;
    }
    if (code===23||code===66) {
      if (!visible(el)) {focus(historyTarget()||candidates()[0]);return true;}
      if (el===document.querySelector('#q')&&el.readOnly) {editSearch(el);return true;}
      if (el===v) {toggle();return true;}
      // Real input/SELECT events open the Android keyboard or native picker.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
      el.click();return true;
    }
    if (!dirs[code]) return false;
    if(settingsKey(el,code)) return true;
    var bar=document.querySelector('.tv-controls');
    if(code===19&&bar&&bar.contains(el)) {focus(v);return true;}
    if((code===21||code===22)&&bar&&bar.contains(el)&&el.tagName==='BUTTON') {
      var buttons=Array.from(document.querySelectorAll('.tv-controls button')), index=buttons.indexOf(el);
      if(code===22&&index===buttons.length-1&&!document.fullscreenElement&&!document.documentElement.classList.contains('tv-fullscreen')) {openEpisodes();return true;}
      focus(buttons[Math.max(0,Math.min(buttons.length-1,index+(code===21?-1:1)))]);return true;
    }
    if (el===v) {
      if(code===21||code===22) {seek(code===21?-10:10);return true;}
      if(code===20) {showControls();focus(document.querySelector('.tv-play')||v);return true;}
      if(code===19) {
        if(document.fullscreenElement||document.documentElement.classList.contains('tv-fullscreen')) {showControls();focus(v);}
        else openEpisodes();
        return true;
      }
    }
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.readOnly && (code===21||code===22)) return false;
    if (code===21 && el && el.closest && el.closest('.epdrawer') && visible(v)) {closeEpisodes();return true;}
    if(window.CodingWatchUI && window.CodingWatchUI.key(el,code,focus)) return true;
    if(homeHeaderKey(el,code)) return true;
    if(window.CodingLibrary && window.CodingLibrary.key && window.CodingLibrary.key(el,code,focus)) return true;
    var all=candidates();
    if(document.documentElement.classList.contains('tv-episodes-open')) {
      all=all.filter(function(e){return e.closest&&e.closest('.epdrawer');});
    }
    if(!visible(el)) {focus(historyTarget()||all[0]);return true;}
    if(/^#\/history(?:$|[/?])/.test(location.hash) && el.closest) {
      var row=el.closest('.hrow');
      if(row) {
        var rows=all.filter(function(e){return e.closest && e.closest('.hrow')===e;}), rowIndex=rows.indexOf(row);
        if((code===19||code===20)&&rowIndex!==-1) {
          focus(rows[Math.max(0,Math.min(rows.length-1,rowIndex+(code===19?-1:1)))]);return true;
        }
        if(code===21&&el!==row) {focus(row);return true;}
        if(code===22&&el===row) {
          focus(all.find(function(e){return e!==row&&e.closest&&e.closest('.hrow')===row;})||row);return true;
        }
      }
    }
    if(code===19 && /^#\/detail\//.test(location.hash) && el.closest) {
      var grid=el.closest('.eps'), origin=el.getBoundingClientRect(), group=[];
      if(grid) {
        group=all.filter(function(e){return e.closest && e.closest('.eps')===grid && e.getBoundingClientRect().top<origin.top-2;});
        if(!group.length) group=all.filter(function(e){return e.closest && e.closest('.hbtns');});
      } else if(el.closest('.hbtns')) {
        group=all.filter(function(e){return e.closest && e.closest('.season-list');});
      }
      var above=nearest(origin,group.map(function(e){return{el:e,rect:e.getBoundingClientRect()};}),'up');
      if(above) {focus(above);return true;}
    }
    var next=nearest(el.getBoundingClientRect(),all.filter(function(e){return e!==el;}).map(function(e){return{el:e,rect:e.getBoundingClientRect()};}),dirs[code]);
    if(next) focus(next);
    return true;
  }
  function installControls(v) {
    if(typeof CodingNative!=='undefined') CodingNative.installVideo(v);
    if (!v || document.querySelector('.tv-controls')) return;
    v.tabIndex=0;v.setAttribute('aria-label','视频：确认键暂停播放，左右键快进快退，下键打开操作');
    var bar=document.createElement('div');bar.className='tv-controls';bar.hidden=true;
    var timeline=document.createElement('div');timeline.className='tv-timeline';
    var track=document.createElement('div');track.className='tv-progress';
    track.tabIndex=-1;track.setAttribute('role','progressbar');track.setAttribute('aria-label','播放进度');
    track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','0');track.setAttribute('aria-valuenow','0');
    var fill=document.createElement('div');fill.className='tv-progress-fill';track.appendChild(fill);timeline.appendChild(track);bar.appendChild(timeline);
    var buttons=document.createElement('div');buttons.className='tv-buttons';bar.appendChild(buttons);
    var primary=document.createElement('div');primary.className='tv-primary-controls';buttons.appendChild(primary);
    [['上一集',function(){step(-1);},'player-skip-back'],['播放',toggle,'player-play'],['下一集',function(){step(1);},'player-skip-forward'],['自动下一集',toggleAutoNext,'repeat','auto'],['全屏',fullscreen,'maximize'],['选集',openEpisodes,'list']].forEach(function(item,index){
      if(index===3) {
        var clock=document.createElement('div');clock.className='tv-clock';clock.textContent='0:00 / 0:00';primary.appendChild(clock);
        var hint=document.createElement('div');hint.className='tv-seek-hint';hint.textContent='左右键调进度';primary.appendChild(hint);
      }
      var b=document.createElement('button');b.className=index<3?'tv-icon-button':'tv-action-button';b.onclick=function(){item[1](b);};
      b.setAttribute('aria-label',item[0]);b.title=item[0];b.innerHTML=icons[item[2]];
      if(index===1) {
        b.className+=' tv-play';b.innerHTML=icons['player-play']+icons['player-pause'];
        b.setAttribute('data-paused',String(v.paused));b.setAttribute('aria-label',v.paused?'播放':'暂停');b.title=v.paused?'播放':'暂停';
      }
      if(index>=3) {var label=document.createElement('span');label.textContent=item[0];b._tvLabel=label;b.appendChild(label);}
      if(item[3]==='auto') {b.className+=' tv-auto-next';syncAutoNext(b);}
      (index<3?primary:buttons).appendChild(b);
    });
    v.parentElement.appendChild(bar);
  }
  function closePassword() {
    var panel=document.querySelector('#tv-password-panel'), button=document.querySelector('#tv-password');
    if(!panel || panel.hidden) return false;
    panel.hidden=true;
    panel.querySelectorAll('input[type="password"]').forEach(function(input){input.value='';});
    var result=panel.querySelector('#site-password-result');if(result) result.textContent='';
    button.setAttribute('aria-expanded','false');focus(button);return true;
  }
  function settingsActions() {
    if(location.hash!=='#/settings' || !document.querySelector('#st1') || document.querySelector('#tv-settings-actions')) return;
    var row=document.createElement('div');row.id='tv-settings-actions';
    [['tv-update','codingtv://update','检查版本 / 更新电视应用'],['tv-server','codingtv://settings','电视连接设置：修改服务器地址']].forEach(function(item){
      var link=document.createElement('a');link.id=item[0];link.className='ghost';link.href=item[1];link.textContent=item[2];row.appendChild(link);
    });
    var form=document.querySelector('#site-password-form');
    if(form) {
      var panel=form.closest('.setbox');panel.id='tv-password-panel';panel.hidden=true;
      var button=document.createElement('button');button.id='tv-password';button.className='ghost';button.type='button';button.textContent='修改密码';
      button.setAttribute('aria-controls',panel.id);button.setAttribute('aria-expanded','false');
      button.onclick=function(){
        if(closePassword()) return;
        panel.hidden=false;button.setAttribute('aria-expanded','true');focus(form.querySelector('input'));
      };
      row.appendChild(button);
    }
    document.querySelector('#view').prepend(row);
  }
  function refresh() {
    document.documentElement.classList.add('coding-tv');
    var search=document.querySelector('#q');
    if(search&&search!==searchEditing) search.readOnly=true;
    if(searchEditing&&!searchEditing.isConnected) searchEditing=null;
    var searchIcon=document.querySelector('.search-submit');
    if(searchIcon) {searchIcon.disabled=true;searchIcon.tabIndex=-1;searchIcon.setAttribute('aria-hidden','true');}
    document.querySelectorAll('.card .favbtn').forEach(function(button){
      var saved=button.classList.contains('on'), state=document.createElement('span');
      state.className='tv-fav-state'+(saved?' on':'');state.tabIndex=-1;
      state.textContent=saved?'已收藏':'未收藏';state.setAttribute('aria-label',state.textContent);
      button.replaceWith(state);
    });
    document.querySelectorAll('.hrow .hacts button').forEach(function(button){
      if((button.getAttribute('onclick')||'').indexOf("go('#/watch/")!==-1) button.remove();
    });
    settingsActions();
    document.querySelectorAll(selector).forEach(function(el){
      if (!el.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.tabIndex=0;
      if((el.hasAttribute('onclick')||el.classList.contains('chip'))&&!el.hasAttribute('role')&&!/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute('role','button');
    });
    installControls(player());
    syncAutoNext(document.querySelector('.tv-auto-next'));
    var hash=location.hash;
    if(hash!==lastHash) {
      settingsLast=null;settingsColumn=0;
      backDeadline=0;backPage='';
      if(/^#\/watch\//.test(hash)) document.documentElement.classList.add('tv-fullscreen');
      if(!/^#\/watch\//.test(hash)) {
        document.documentElement.classList.remove('tv-fullscreen');
        document.documentElement.classList.remove('tv-episodes-open');
      }
      returning = /^#\/watch\//.test(lastHash)&&/^#\/detail\//.test(hash) ? '.season-btn.on,.season-btn' :
        /^#\/watch\//.test(hash) ? '#video' : /^#\/detail\//.test(hash) ? '.hero .btn-pink' : /^#\/history(?:$|[/?])/.test(hash) ? '.hrow' : '#view button,#view .card,#view a';
      lastHash=hash;
    }
    if (returning && visible(document.querySelector(returning))) {focus(document.querySelector(returning));returning=null;return;}
    if (visible(document.activeElement)) return;
    var preferred=historyTarget()||(returning ? document.querySelector(returning) : player()||document.querySelector('#password')||document.querySelector('.card'));
    if(visible(preferred)) {focus(preferred);returning=null;}
    else focus(candidates()[0]);
  }
  window.CodingTV={key:key,back:back,nearest:nearest,suspend:function(){if(typeof W!=='undefined'&&W.save&&W.sid) W.save(false);var v=player();if(v)v.pause();}};
  document.addEventListener('keydown',function(e){
    var map={ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Enter:23,' ':85,Escape:4};
    if(map[e.key] && key(map[e.key])) {e.preventDefault();e.stopImmediatePropagation();}
  },true);
  document.addEventListener('click',function(e){
    if(e.target===document.querySelector('#q')&&e.target.readOnly) editSearch(e.target);
    var episode=e.target.closest&&e.target.closest('.epdrawer .ditem');
    if(!episode||!/^#\/watch\//.test(location.hash)||!player()) return;
    backDeadline=0;backPage='';
    document.documentElement.classList.add('tv-fullscreen');
    closeEpisodes();
  });
  document.addEventListener('focusin',function(e){var bar=document.querySelector('.tv-controls');if(bar&&!bar.contains(e.target)&&e.target!==player()) bar.hidden=true;});
  document.addEventListener('focusout',function(e){if(e.target===searchEditing) {searchEditing.readOnly=true;searchEditing=null;}});
  var scheduled=false;
  new MutationObserver(function(records){
    if (scheduled || !records.some(function(r){
      // Library cards already carry their remote roles and favourite labels.
      if(r.target && r.target.classList && r.target.classList.contains('library-grid')) return false;
      return r.type==='childList' && (!r.addedNodes || Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(function(n){return n.nodeType===1;}));
    })) return;
    scheduled=true;requestAnimationFrame(function(){scheduled=false;refresh();});
  }).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('hashchange',function(){setTimeout(refresh,0);});
  refresh();
})();
