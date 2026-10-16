(function () {
  'use strict';
  if (window.CodingNative) return;
  var current=null, serial=0, decoderMode='auto', successfulMode='', pendingMode=null, compatibilityProfile='', mediaTicketRequired=false, warmNextEnabled=false, nextAuth=null;
  var decoderLabels={'auto':'自动选择（失败时切换）','system':'系统硬件播放器（原有方式）','browser':'浏览器播放器（WebView）'};
  function installDecoderSettings() {
    if (!/^#\/settings(?:$|[/?])/.test(location.hash)) return;
    var view=document.querySelector('#view');
    if (!view || document.querySelector('#tv-decoder-settings')) return;
    var panel=document.createElement('div');panel.id='tv-decoder-settings';panel.className='setbox';
    panel.innerHTML='<h3>电视解码方式</h3><p class="note">左右移动，确认选择；自动模式失败后切换，手动模式固定所选方式。</p><div id="tv-decoder-mode" class="tv-decoder-options" role="group" aria-label="电视解码方式">'+Object.keys(decoderLabels).map(function(mode){var title={auto:'自动',system:'系统播放器',browser:'浏览器播放器'}[mode];return '<button type="button" class="ghost" id="tv-decoder-'+mode+'" data-decoder="'+mode+'" aria-pressed="false">'+title+'</button>';}).join('')+'</div><p class="note" id="tv-decoder-success"></p><p class="note">本设备独立保存；浏览器使用系统自带解码，无需额外解码库。</p>';
    var first=view.querySelector(".setbox");view.insertBefore(panel,first&&first.parentNode===view?first:null);
    panel.querySelectorAll('[data-decoder]').forEach(function(button){button.onclick=function(){var choice=button.getAttribute('data-decoder');pendingMode=choice;updateDecoderButtons();};});
    updateDecoderButtons();updateDecoderLabel();
  }
  function updateDecoderButtons(){
    var mode=pendingMode||decoderMode;
    document.querySelectorAll('#tv-decoder-mode [data-decoder]').forEach(function(button){attribute(button,'aria-pressed',String(button.getAttribute('data-decoder')===mode));});
  }
  function updateDecoderLabel() {
    var label=document.querySelector('#tv-decoder-success');
    var text=successfulMode&&decoderLabels[successfulMode]?'最近成功：'+decoderLabels[successfulMode]:'尚未记录成功方式；播放画面正常且时间持续推进后自动记住。';
    if(compatibilityProfile==='tcl-hevc')text+=' TCL：系统采用硬件视频解码；浏览器兼容能力由系统WebView决定。';
    if(label&&label.textContent!==text)label.textContent=text;
  }
  function decoderState(mode,successful,profile,needsMediaTicket,prewarmNext) {
    warmNextEnabled=prewarmNext===true;
    mediaTicketRequired=needsMediaTicket===true;
    if(decoderLabels[mode])decoderMode=mode;
    successfulMode=successful;
    compatibilityProfile=profile==='tcl-hevc'?profile:'';
    if(pendingMode===decoderMode)pendingMode=null;
    installDecoderSettings();
    updateDecoderButtons();
    updateDecoderLabel();
    if(window.CodingTVDiagnostics)CodingTVDiagnostics.render();
  }
  // Native polling reads commands; URL navigation would fire the page's unload cleanup.
  // Native MediaPlayer consumes authenticated NAS MP4s, not browser blob URLs.
  if (typeof DeviceMedia !== 'undefined') DeviceMedia.mode=function(){return 'nas';};
  function installVideo(v) {
    if (!v || v._tvNative) return;
    if(current&&current.browser)stopBrowser(current);
    v._tvNative=true; v.controls=false;
    var s={v:v,id:++serial,src:'',pos:0,dur:0,paused:true,ended:false,ready:0,rate:1,commands:[],browser:false,browserError:false,picture:false};
    current=s;
    var get=v.getAttribute.bind(v), remove=v.removeAttribute.bind(v);
    var load=v.load, play=v.play, pause=v.pause;
    var originals={load:function(){return load.call(v);},play:function(){return play.call(v);},pause:function(){return pause.call(v);}}, properties={};
    ['src','currentSrc','currentTime','duration','paused','ended','readyState','seeking','playbackRate'].forEach(function(name){
      var prototype=Object.getPrototypeOf(v), descriptor;
      while(prototype&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(prototype,name);prototype=Object.getPrototypeOf(prototype);}
      properties[name]=descriptor;
    });
    s.originals=originals;s.properties=properties;s.remove=remove;s.opacity=v.style?v.style.opacity:'';
    function read(name){return properties[name].get.call(v);}
    function write(name,value){properties[name].set.call(v,value);}
    v.getAttribute=function(name){return name==='src' ? s.src||null : get(name);};
    v.removeAttribute=function(name){if(name==='src'){if(s.browser)stopBrowser(s);s.src='';}else remove(name);};
    Object.defineProperties(v,{
      src:{get:function(){return s.src;},set:function(x){if(s.browser)stopBrowser(s);if(s.src!==String(x))clearTicket(s);s.src=String(x);}},
      currentSrc:{get:function(){return s.browser?read('currentSrc'):s.src;}},
      currentTime:{get:function(){return s.browser?read('currentTime'):s.pos;},set:function(x){s.pos=Math.max(0,Number(x)||0);if(s.browser){s.seekSerial++;write('currentTime',s.pos);}else s.commands.push({op:'seek',value:s.pos});}},
      duration:{get:function(){return s.browser?read('duration'):s.dur;}}, paused:{get:function(){return s.browser?read('paused'):s.paused;}},
      ended:{get:function(){return s.browser?read('ended'):s.ended;}}, readyState:{get:function(){return s.browser?read('readyState'):s.ready;}},
      seeking:{get:function(){return s.browser?read('seeking'):false;}},
      playbackRate:{get:function(){return s.browser?read('playbackRate'):s.rate;},set:function(x){s.rate=Number(x)||1;if(s.browser)write('playbackRate',s.rate);else s.commands.push({op:'rate',value:s.rate});}}
    });
    v.load=function(){if(s.browser)stopBrowser(s);s.id=++serial;clearTicket(s);s.pos=0;s.dur=0;s.ready=0;s.paused=true;s.ended=false;s.commands=[];};
    v.play=function(){if(s.browser)return originals.play();s.paused=false;s.commands.push({op:'play'});return Promise.resolve();};
    v.pause=function(){if(s.browser){originals.pause();return;}if(!s.paused){s.paused=true;s.commands.push({op:'pause'});v.dispatchEvent(new Event('pause'));}};
    if(v.addEventListener){
      v.addEventListener('loadedmetadata',function(){
        if(!s.browser||current!==s||!v.isConnected)return;
        if(s.resume>0&&s.resume<read('duration')){s.seekSerial++;write('currentTime',s.resume);}s.resume=0;write('playbackRate',s.rate);
      },true);
      ['timeupdate','playing','pause','seeked','ended'].forEach(function(type){v.addEventListener(type,function(){if(s.browser&&current===s)updateHud(s);},true);});
      v.addEventListener('error',function(event){
        if(!s.browser)return;s.browserError=true;event.stopImmediatePropagation();
      },true);
    }
  }
  function stopBrowser(s){
    if(!s.browser)return;
    s.pos=s.v.currentTime||0;s.dur=s.v.duration||0;s.browser=false;s.browserError=false;s.picture=false;s.ready=0;s.paused=true;
    if(s.frame!=null&&s.v.cancelVideoFrameCallback)s.v.cancelVideoFrameCallback(s.frame);s.frame=null;
    s.v.style.opacity=s.opacity;s.originals.pause();s.remove('src');s.originals.load();
  }
  function useBrowser(id,url,position,rate){
    var s=current;if(!s||s.id!==id||!s.v.isConnected||!/^#\/watch\//.test(location.hash))return false;
    var address;try{address=new URL(url,location.href);}catch(_){return false;}
    if(address.origin!==location.origin||address.username||address.password||address.hash||address.pathname!=='/stream'||!/^\?series_id=[0-9]{1,24}&ep=[0-9]{1,6}(?:&tv_profile=(?:tcl-hevc|hevc-meta))?(?:&tv_diag_route=(?:system|browser))?$/.test(address.search)||Number(address.searchParams.get('ep'))<1)return false;
    if(s.browser)stopBrowser(s);
    s.browser=true;s.browserError=false;s.picture=false;s.commands=[];s.seekSerial=0;s.resume=Math.max(0,Number(position)||0);s.rate=Number(rate)||1;
    s.v.style.opacity='1';s.properties.src.set.call(s.v,address.href);s.originals.load();
    if(compatibilityProfile==='tcl-hevc')try{if(window.CodingTVDiagnostics)CodingTVDiagnostics.record({event:'browser-codecs',note:JSON.stringify({hevc:s.v.canPlayType('video/mp4; codecs="hvc1.1.6.L150.B0"'),avc:s.v.canPlayType('video/mp4; codecs="avc1.640028"')})});}catch(_){}
    try{if(window.CodingTVDiagnostics)CodingTVDiagnostics.probe(address.href);}catch(_){}
    if(s.v.requestVideoFrameCallback)s.frame=s.v.requestVideoFrameCallback(function(){if(current===s&&s.id===id&&s.browser)s.picture=true;s.frame=null;});
    return true;
  }
  function browserControl(id,op){
    var s=current;if(!s||s.id!==id||!s.browser)return;
    if(op==='stop')stopBrowser(s);
    else if(op==='pause')s.originals.pause();
    else if(op==='play')s.originals.play().catch(function(){});
  }
  function pictureOutput(s){
    if(!s.browser||!s.v.isConnected||s.v.readyState<2||s.v.videoWidth<=0||s.v.videoHeight<=0)return false;
    if(s.v.requestVideoFrameCallback)return s.picture;
    try{if(s.v.getVideoPlaybackQuality){var q=s.v.getVideoPlaybackQuality();return q.totalVideoFrames-q.droppedVideoFrames>0;}
      return Number(s.v.webkitDecodedFrameCount)>0;
    }catch(_){return false;}
  }
  function pictureMeasured(s){
    if(!s.browser)return false;
    if(s.v.videoWidth<=0||s.v.videoHeight<=0)return true;
    if(s.v.requestVideoFrameCallback)return true;
    try{if(s.v.getVideoPlaybackQuality)return Number.isFinite(s.v.getVideoPlaybackQuality().totalVideoFrames);
      return Number.isFinite(s.v.webkitDecodedFrameCount);
    }catch(_){return false;}
  }
  function clearTicket(s){
    if(s.ticketController)s.ticketController.abort();s.ticketController=null;
    s.ticket='';s.ticketDue=0;s.ticketPending=false;s.ticketFailed=false;s.ticketAttempts=0;
  }
  function ticketCurrent(s,id){return current===s&&s.id===id || nextAuth===s&&current===s.video&&current.id===s.owner&&s.id===id;}
  function clearNextTicket(){if(nextAuth)clearTicket(nextAuth);nextAuth=null;}
  function adoptNextTicket(s){
    if(nextAuth&&nextAuth.video===s&&nextAuth.src===s.src&&nextAuth.ticket&&nextAuth.ticketDue>Date.now()){
      s.ticket=nextAuth.ticket;s.ticketDue=nextAuth.ticketDue;s.ticketFailed=false;s.ticketAttempts=0;clearNextTicket();
    }
  }
  function prepareNextTicket(s,next){
    if(!warmNextEnabled||!mediaTicketRequired||s.browser||!next){clearNextTicket();return;}
    try{
      var from=new URL(s.src,location.href),to=new URL(next,location.href);
      if(to.origin!==location.origin||to.username||to.password||to.hash||to.pathname!=='/stream'||
        to.searchParams.get('series_id')!==from.searchParams.get('series_id')||Number(to.searchParams.get('ep'))!==Number(from.searchParams.get('ep'))+1){clearNextTicket();return;}
    }catch(_){clearNextTicket();return;}
    if(!nextAuth||nextAuth.video!==s||nextAuth.owner!==s.id||nextAuth.src!==next){
      clearNextTicket();nextAuth={video:s,owner:s.id,id:s.id,src:next};
    }
    prepareTicket(nextAuth);
  }
  function prepareTicket(s){
    if(!mediaTicketRequired||!s.src||s.ticketPending||s.ticketFailed||(s.ticketDue||0)>Date.now())return;
    var address;try{address=new URL(s.src,location.href);}catch(_){s.ticketFailed=true;return;}
    var sid=address.searchParams.get('series_id'),ep=address.searchParams.get('ep');
    if(address.origin!==location.origin||address.pathname!=='/stream'||!/^\d{1,24}$/.test(sid||'')||!/^\d{1,6}$/.test(ep||'')||Number(ep)<1){s.ticketFailed=true;return;}
    var id=s.id,active=new AbortController(),timer=setTimeout(function(){active.abort();},8000);
    s.ticket='';s.ticketPending=true;s.ticketController=active;s.ticketAttempts=(s.ticketAttempts||0)+1;
    fetch('/auth/media-ticket',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({series_id:sid,ep:Number(ep)}),signal:active.signal}).then(function(response){
      if(!response.ok)throw new Error('media authorization failed');return response.json();
    }).then(function(data){
      if(!ticketCurrent(s,id)||s.ticketController!==active)return;
      if(typeof data.token!=='string'||data.token.length>1024||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token))throw new Error('invalid media authorization');
      s.ticket=data.token;s.ticketDue=Date.now()+600000;s.ticketFailed=false;s.ticketAttempts=0;
    }).catch(function(){
      if(!ticketCurrent(s,id)||s.ticketController!==active)return;
      s.ticketDue=Date.now()+2000;s.ticketFailed=s.ticketAttempts>=2;
    }).finally(function(){clearTimeout(timer);if(ticketCurrent(s,id)&&s.ticketController===active){s.ticketPending=false;s.ticketController=null;}});
  }
  function snapshot() {
    var s=current;
    if(!s) return {decoderMode:pendingMode||decoderMode};
    if(!s.v.isConnected) {clearNextTicket();clearTicket(s);stopBrowser(s);current=null;return {decoderMode:pendingMode||decoderMode};}
    if(!/^#\/watch\//.test(location.hash)){clearNextTicket();clearTicket(s);stopBrowser(s);return {decoderMode:pendingMode||decoderMode};}
    adoptNextTicket(s);prepareTicket(s);
    var r=s.v.getBoundingClientRect(), commands=!s.browser&&s.ready&&(!mediaTicketRequired||s.ticket)?s.commands.splice(0):[];
    var seeking=s.browser&&(s.v.seeking||s.seekSerial!==s.lastSeek);s.lastSeek=s.seekSerial;
    var next=window.CodingTVTransition && typeof W!=='undefined'?CodingTVTransition.next(W,s.v,warmNextEnabled):'';
    prepareNextTicket(s,next);
    var bd=null;if(s.browser&&window.CodingTVDiagnostics){var quality;try{quality=s.v.getVideoPlaybackQuality&&s.v.getVideoPlaybackQuality();}catch(_){}
      bd={error:s.v.error?s.v.error.code:0,width:s.v.videoWidth||0,height:s.v.videoHeight||0,ready:s.v.readyState,network:s.v.networkState,paused:s.v.paused,seconds:Math.floor(s.v.currentTime||0),decoded:quality?quality.totalVideoFrames:Number(s.v.webkitDecodedFrameCount)||0,dropped:quality?quality.droppedVideoFrames:0,picture:pictureOutput(s),opacity:s.v.style.opacity};}
    return {nextMediaTicket:nextAuth&&nextAuth.owner===s.id?nextAuth.ticket||'':'',mediaTicket:s.ticket||'',mediaTicketFailed:!!s.ticketFailed,browserDiagnostics:bd,browser:s.browser,browserError:s.browserError,browserReady:s.browser&&s.v.readyState>=1,browserPlaying:s.browser&&!s.v.paused,browserSeeking:seeking,pos:s.browser?s.v.currentTime:s.pos,pictureOutput:s.browser&&pictureOutput(s),pictureMeasured:pictureMeasured(s),decoderMode:pendingMode||decoderMode,id:s.id,src:s.src,next:next,commands:commands,rect:{x:r.left,y:r.top,w:r.width,h:r.height},viewport:window.innerWidth};
  }
  function attribute(node,name,value) {
    if(!node.getAttribute || node.getAttribute(name)!==value) node.setAttribute(name,value);
  }
  function updateHud(s) {
    var clock=document.querySelector('.tv-clock');
    if(clock) {var fmt=function(x){return Math.floor(x/60)+':'+('0'+Math.floor(x%60)).slice(-2);};var text=fmt(s.v.currentTime)+' / '+fmt(s.v.duration);if(clock.textContent!==text)clock.textContent=text;}
    var fill=document.querySelector('.tv-progress-fill');
    if(fill) {var width=(s.v.duration>0?Math.min(100,Math.max(0,s.v.currentTime/s.v.duration*100)):0)+'%';if(fill.style.width!==width)fill.style.width=width;}
    var track=document.querySelector('.tv-progress');
    if(track) {attribute(track,'aria-valuemax',String(s.v.duration));attribute(track,'aria-valuenow',String(s.v.currentTime));attribute(track,'aria-valuetext',clock?clock.textContent:String(s.v.currentTime));}
    var play=document.querySelector('.tv-play');
    if(play) {attribute(play,'data-paused',String(s.v.paused));attribute(play,'aria-label',s.v.paused?'播放':'暂停');if(play.title!==(s.v.paused?'播放':'暂停'))play.title=s.v.paused?'播放':'暂停';}
  }
  function report(id,type,data) {
    var s=current; if(!s || s.id!==id || !s.v.isConnected) return;
    if(s.browser)return;
    data=data||{};
    if(Number.isFinite(data.pos)) s.pos=data.pos;
    if(Number.isFinite(data.dur)) s.dur=data.dur;
    if(type==='loadedmetadata') s.ready=4;
    if(type==='switching') {s.ready=0;s.paused=true;}
    if(type==='playing') s.paused=false;
    if(type==='pause') s.paused=true;
    if(type==='ended') {s.ended=true;s.paused=true;}
    if(type==='error') s.v._nativeError=data.message||'系统播放器解码失败';
    s.v.dispatchEvent(new Event(type));
    updateHud(s);
    if(type==='switching') {
      var loading=document.querySelector('#vload'), text=document.querySelector('#vtip');
      if(loading)loading.style.display='flex';if(text)text.textContent=data.message||'正在切换兼容解码方式';
    }
    if(type==='error') {
      var tip=document.querySelector('#vtip');
      if(tip) tip.textContent=s.v._nativeError+'；可重试本集。';
    }
  }
  window.CodingNative={installVideo:installVideo,snapshot:snapshot,report:report,decoderState:decoderState,useBrowser:useBrowser,browserControl:browserControl};
})();
