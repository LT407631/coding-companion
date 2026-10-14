(function(){
  'use strict';
  if(window.CodingTVDiagnostics)return;
  var enabled=false,info={},rows=[],sent=0,probeCount=0,controller=null,run=Date.now().toString(36);
  function target(){
    var v=window.CodingNative&&CodingNative.snapshot();
    if(!v||!v.src)return null;
    try{var u=new URL(v.src,location.href);if(u.origin!==location.origin||u.pathname!=='/stream'||u.username||u.password||u.hash)return null;
      var sid=u.searchParams.get('series_id'),ep=u.searchParams.get('ep');
      return /^[0-9]{1,24}$/.test(sid||'')&&/^[0-9]{1,6}$/.test(ep||'')?{sid:sid,ep:ep}:null;
    }catch(_){return null;}
  }
  function render(){
    if(!enabled||location.hash!=='#/settings')return;
    var parent=document.querySelector('#tv-decoder-settings');if(!parent)return;
    var panel=document.querySelector('#tv-playback-diagnostics');
    if(!panel){panel=document.createElement('div');panel.id='tv-playback-diagnostics';
      var button=document.createElement('button');button.textContent='展开播放诊断（TCL）';button.type='button';
      var output=document.createElement('pre');output.hidden=true;output.style.cssText='font-size:20px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;margin:12px 0';
      button.onclick=function(){output.hidden=!output.hidden;button.textContent=output.hidden?'展开播放诊断（TCL）':'收起播放诊断（TCL）';if(!output.hidden)panel.scrollIntoView({block:'start'});};
      panel.appendChild(button);panel.appendChild(output);parent.appendChild(panel);
    }
    var text='型号 '+info.model+' / Android API '+info.sdk+'\nWebView '+(info.webview||'未知')+'\nHEVC '+(info.hevc||'未知').slice(0,180)+'\n'+rows.slice(-6).map(function(r){return r.event+': '+r.note.slice(0,160);}).join('\n');
    var output=panel.querySelector('pre');if(output.textContent!==text)output.textContent=text;
  }
  function record(data){
    if(!enabled||!data||typeof data.event!=='string'||sent>=48)return;
    // Accept only diagnostic events emitted by the maintained adapter, never arbitrary fields.
    if(!/^(?:system-open|system-prepared|system-error|system-exception|system-frames|native-request|native-range|browser-open|browser-state|browser-range|browser-codecs|external-(?:detected|detection-error|transport|open|open-error|return)|failure)$/.test(data.event))return;
    var row={event:data.event,note:String(data.note||'').slice(0,800)};rows.push(row);if(rows.length>12)rows.shift();render();
    var t=target();if(!t)return;sent++;
    var report={run:run,event:row.event,note:row.note};
    if(sent===1){report.device=info;report.ua=String(navigator.userAgent||'').slice(0,240);}
    var path='/playback/status?series_id='+t.sid+'&ep='+t.ep+'&tv_diag_v=27&tv_diag='+encodeURIComponent(JSON.stringify(report));
    fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error'}).catch(function(){});
  }
  function probe(url){
    if(!enabled||probeCount>=2)return;
    var u;try{u=new URL(url,location.href);}catch(_){return;}
    if(u.origin!==location.origin||u.username||u.password||u.hash||u.pathname!=='/stream')return;
    if(typeof AbortController==='undefined'){record({event:'browser-range',note:'AbortController-unavailable'});return;}
    probeCount++;if(controller)controller.abort();controller=new AbortController();var active=controller;
    var timer=setTimeout(function(){active.abort();},10000);
    fetch(u.href+'&tv_diag_probe=browser',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Range:'bytes=0-7'},signal:active.signal}).then(function(r){
      record({event:'browser-range',note:'status='+r.status+',type='+r.headers.get('Content-Type')+',range='+r.headers.get('Content-Range')});active.abort();
    }).catch(function(e){if(e.name!=='AbortError')record({event:'browser-range',note:'exception='+e.name});}).finally(function(){clearTimeout(timer);});
  }
  function enable(value){
    if(!value||String(value.model).toUpperCase()!=='TCL_MT5879_CN')return;
    info={model:String(value.model).slice(0,64),sdk:Number(value.sdk)||0,webview:String(value.webview||'').slice(0,80),hevc:String(value.hevc||'').slice(0,800)};
    if(!enabled){enabled=true;window.addEventListener('hashchange',render);}render();
  }
  window.CodingTVDiagnostics={enable:enable,record:record,probe:probe,render:render,snapshot:function(){return {info:info,rows:rows.slice(),sent:sent};}};
})();
