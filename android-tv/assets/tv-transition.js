(function () {
  'use strict';
  if (window.CodingTVTransition) return;
  var candidate=null, barrier=null, handoff=null, clearQuiet=function(){};
  function matches(c,w) {
    return c && w.alive && c.client===w.client && c.sid===w.sid && c.ep===w.ep && c.token===w.token;
  }
  function fresh(w) {
    return matches(candidate,w) && candidate.data && Date.now()-candidate.checked<8000;
  }
  function next(w,v) {
    if(!w || !w.alive || !w.auto || w.mode!=='nas' || !v._tvNative || v.paused || !v.duration || w.ep>=w.eps.length) return '';
    var left=v.duration-v.currentTime;
    if(left<=0 || left>8) return '';
    if(!matches(candidate,w)) candidate={client:w.client,sid:w.sid,ep:w.ep,token:w.token,checked:0,pending:false,data:null};
    var c=candidate;
    if(!c.pending && Date.now()-c.checked>=2000) {
      c.pending=true;c.checked=Date.now();
      var abort=new AbortController(), timer=setTimeout(function(){abort.abort();},1500);
      fetch('/playback/status?series_id='+encodeURIComponent(w.sid)+'&ep='+(w.ep+1),{signal:abort.signal,credentials:'same-origin'})
        .then(function(r){if(!r.ok) throw new Error('status');return r.json();})
        .then(function(data){if(matches(c,w)) c.data=data.current && data.current.state==='ready'?data:null;})
        .catch(function(){c.data=null;})
        .finally(function(){clearTimeout(timer);c.pending=false;});
    }
    return left<=2 && fresh(w)?'/stream?series_id='+w.sid+'&ep='+(w.ep+1):'';
  }
  function advance(w) {
    if(!w.auto || w.ep>=w.eps.length || !fresh(w)) return false;
    // Playback can hand over immediately; completion and the next session prepare remain ordered.
    handoff={client:w.client,sid:w.sid,ep:w.ep+1,data:candidate.data};
    candidate=null;
    return true;
  }
  function quietTransition(enabled) {
    clearQuiet();
    if(!enabled) return;
    var overlay=document.querySelector('#vload'), video=document.querySelector('#video');
    var retry=document.querySelector('#vretry'), start=document.querySelector('#vstart');
    if(!overlay || !video) return;
    var observer=new MutationObserver(function(){
      if((retry && retry.style.display!=='none') || (start && start.style.display!=='none')) clearQuiet();
    });
    clearQuiet=function(){
      overlay.classList.remove('tv-transition-quiet');observer.disconnect();
      video.removeEventListener('playing',clearQuiet);video.removeEventListener('error',clearQuiet);
      clearQuiet=function(){};
    };
    overlay.classList.add('tv-transition-quiet');
    video.addEventListener('playing',clearQuiet);video.addEventListener('error',clearQuiet);
    if(retry) observer.observe(retry,{attributes:true,attributeFilter:['style']});
    if(start) observer.observe(start,{attributes:true,attributeFilter:['style']});
  }
  function cached(w,n,automatic,retry) {
    var h=handoff;handoff=null;candidate=null;
    var data=automatic && !retry && h && h.client===w.client && h.sid===w.sid && h.ep===n?h.data:null;
    quietTransition(!!data);
    return data;
  }
  function run(w,action) {
    var client=w.client,previous=barrier && barrier.client===client?barrier.promise:Promise.resolve();
    var result=previous.catch(function(){}).then(function(){if(w.alive && w.client===client) return action();});
    barrier={client:client,promise:result};
    return result;
  }
  window.CodingTVTransition={next:next,advance:advance,cached:cached,run:run};
})();
