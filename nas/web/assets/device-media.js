(function (root) {
  'use strict';
  const defaults={mode:'auto',ahead:3,limit:500,previous:true,cleanup:true}, sessions=new Set();
  let storagePromise;
  function settings() {
    let raw={}; try { raw=JSON.parse(localStorage.getItem('coding_device_settings_v1')||'{}'); } catch (_) {}
    return {mode:['auto','nas','device'].includes(raw.mode)?raw.mode:'auto',ahead:Math.max(1,Math.min(5,Number(raw.ahead)||3)),limit:[100,250,500,1000].includes(Number(raw.limit))?Number(raw.limit):500,previous:raw.previous!==false,cleanup:raw.cleanup!==false};
  }
  function save(value) { localStorage.setItem('coding_device_settings_v1',JSON.stringify({...settings(),...value})); }
  function mode() {
    const choice=settings().mode;
    if(choice!=='auto') return choice;
    const h=location.hostname;
    return /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)||h==='[::1]'?'nas':'device';
  }
  function supported() {
    if(!root.isSecureContext || !root.crypto?.subtle) throw Error('当前地址不支持设备直连，可继续使用 NAS 播放；如需设备直连可改用 HTTPS');
    if(!root.Worker || !root.indexedDB) throw Error('此浏览器不支持设备解密或缓存，请手动选择 NAS 模式');
  }
  class Store {
    async db() {
      if(!storagePromise) storagePromise=new Promise((resolve,reject)=>{
        const request=indexedDB.open('coding-device-media-v1',1);
        request.onupgradeneeded=()=>{ request.result.createObjectStore('media',{keyPath:'key'});request.result.createObjectStore('index',{keyPath:'key'}); };
        request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();storagePromise=null;};resolve(request.result);};
        request.onerror=()=>{storagePromise=null;reject(Error('设备缓存无法打开，请检查浏览器存储权限'));};
      });
      return storagePromise;
    }
    async transaction(names,mode,fn) {
      const db=await this.db();return new Promise((resolve,reject)=>{
        const tx=db.transaction(names,mode);let result;
        tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||Error('设备缓存操作失败'));
        const capture=request=>{request.onsuccess=()=>{result=request.result;};return request;};
        fn(tx,capture);
      });
    }
    list() { return this.transaction(['index'],'readonly',(tx,take)=>take(tx.objectStore('index').getAll())); }
    get(key) { return this.transaction(['media'],'readonly',(tx,take)=>take(tx.objectStore('media').get(key))); }
    put(record,blob) { return this.transaction(['index','media'],'readwrite',tx=>{tx.objectStore('index').put(record);tx.objectStore('media').put({key:record.key,blob});}); }
    remove(keys) { return this.transaction(['index','media'],'readwrite',tx=>keys.forEach(key=>{tx.objectStore('index').delete(key);tx.objectStore('media').delete(key);})); }
    clear() { return this.transaction(['index','media'],'readwrite',tx=>{tx.objectStore('index').clear();tx.objectStore('media').clear();}); }
  }
  const store=new Store(), abort=()=>new DOMException('已取消','AbortError');
  function safeURL(raw,redirect=false) { const u=new URL(raw);const hosts=redirect?['qznovelvod.com','jspcdn.cn','idouyinvod.com']:['qznovelvod.com'];if(u.protocol!=='https:' || !hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))) throw Error('视频源地址不受支持');return u.href; }
  async function produce(descriptor,signal,progress) {
    const maximum=64*1024**2;
    if(descriptor.bytes>maximum) throw Error('本集过大，超出设备解密内存限制，请手动使用 NAS 模式');
    let response;
    try {response=await fetch(safeURL(descriptor.url),{signal,mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});}
    catch(error) {if(signal.aborted) throw error;const failure=Error('直连下载被网络或源站跨域规则阻止，请重试或手动选择 NAS 模式');failure.refresh=true;throw failure;}
    if([401,403,404,410].includes(response.status)) {const error=Error('视频链接已过期');error.expired=true;throw error;}
    if(!response.ok) throw Error('视频源下载失败（'+response.status+'），请重试或手动选择 NAS 模式');
    try {safeURL(response.url,true);} catch(error) {await response.body?.cancel();throw error;}
    const length=Number(response.headers.get('Content-Length'))||descriptor.bytes||0;
    if(length>maximum) {await response.body?.cancel();throw Error('本集超出设备内存限制');}
    const reader=response.body?.getReader();let buffer;
    if(reader) {
      const chunks=[];let received=0;
      try { while(true) {const part=await reader.read();if(part.done) break;received+=part.value.byteLength;if(received>maximum) throw Error('本集超出设备内存限制');chunks.push(part.value);progress('下载',length?Math.min(1,received/length):0);} }
      catch(error) {await reader.cancel().catch(()=>{});throw error;}
      const bytes=new Uint8Array(received);let offset=0;for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}buffer=bytes.buffer;
    } else { buffer=await response.arrayBuffer();if(buffer.byteLength>maximum) throw Error('本集超出设备内存限制'); }
    if(signal.aborted) throw abort();
    if(!descriptor.encrypted) return new Blob([buffer],{type:'video/mp4'});
    buffer=await new Promise((resolve,reject)=>{
      const worker=new Worker('/ui/assets/device-worker.js?v=direct-1');
      const finish=(error,value)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);worker.terminate();error?reject(error):resolve(value);};
      const cancel=()=>finish(abort());const timer=setTimeout(()=>finish(Error('设备解密超时，请重试或手动选择 NAS 模式')),120000);
      worker.onerror=()=>finish(Error('设备解密模块未能启动，请刷新页面重试'));
      worker.onmessage=event=>{const data=event.data;if(data.error) finish(Error(data.error));else if(data.buffer) finish(null,data.buffer);else progress('解密',data.progress);};
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted) {cancel();return;}
      worker.postMessage({buffer,spade:descriptor.spade},[buffer]);
    });
    return new Blob([buffer],{type:'video/mp4'});
  }
  async function manifest(sid,ep,force,signal) {
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),30000);
    const cancel=()=>ctl.abort();signal.addEventListener('abort',cancel,{once:true});if(signal.aborted) cancel();
    try {
      const response=await fetch(`/device/manifest?series_id=${encodeURIComponent(sid)}&ep=${ep}&count=5&force=${force}`,{signal:ctl.signal,cache:'no-store'});
      const data=await response.json();if(!response.ok) throw Error(typeof data.detail==='string'?data.detail:'视频链接获取失败');return data.episodes;
    } finally {clearTimeout(timer);signal.removeEventListener('abort',cancel);}
  }
  class Session {
    constructor(sid,episodes,notify,dependencies={}) {
      this.sid=String(sid);this.episodes=episodes;this.notify=notify;this.store=dependencies.store||store;this.produce=dependencies.produce||produce;this.manifest=dependencies.manifest||manifest;this.settings=dependencies.settings||settings;
      this.states={};this.links=new Map();this.alive=true;this.generation=0;this.current=0;this.queue=[];this.running=null;this.url=null;this.warning='';this.hidden=()=>{if(document.hidden && this.running?.ep!==this.current) this.running?.ctl.abort();else if(!document.hidden) this.pump();};
      document.addEventListener('visibilitychange',this.hidden);sessions.add(this);
    }
    key(ep) {return this.sid+'/'+ep;}
    emit() {
      const entries=Object.values(this.states);this.notify({current:this.states[this.current]||{state:'idle'},episodes:this.states,ready:entries.filter(x=>x.state==='ready'&&x.cached).length,queued:entries.filter(x=>['queued','working'].includes(x.state)).length,errors:entries.filter(x=>x.state==='error').length,warning:this.warning});
    }
    async select(ep,retry=false) {
      if(!this.alive) return;
      if(this.current===ep&&!retry&&!this.suspended) {this.emit();return;}
      const gen=++this.generation;this.current=ep;this.queue=[];this.warning='';this.suspended=false;
      if(this.running?.ep!==ep||retry) this.running?.ctl.abort();
      if(this.url) {URL.revokeObjectURL(this.url);this.url=null;}
      this.states[ep]={state:'queued'};this.emit();
      try {
        const records=await this.store.list();if(gen!==this.generation||!this.alive) return;
        this.states={};for(const r of records.filter(r=>r.sid===this.sid)) {
          if(String(this.episodes.find(e=>e.index===r.ep)?.vid)===r.vid) this.states[r.ep]={state:'ready',cached:true};
        }
        if(retry) {await this.store.remove([this.key(ep)]);delete this.states[ep];this.links.delete(ep);}
        if(gen!==this.generation||!this.alive) return;
        const cached=this.states[ep]&&await this.store.get(this.key(ep));
        if(gen!==this.generation||!this.alive) return;
        if(cached?.blob) this.activate(ep,cached.blob,true);
        else if(this.running?.ep===ep&&!this.running.ctl.signal.aborted) this.states[ep]={state:'working'};
        else {this.states[ep]={state:'queued'};this.queue.push(ep);}
        const end=Math.min(this.episodes.length,ep+this.settings().ahead);
        for(let n=ep+1;n<=end;n++) if(this.states[n]?.state!=='ready') {this.states[n]={state:'queued'};this.queue.push(n);}
        this.emit();this.pump();
      } catch(error) {if(gen===this.generation&&this.alive) {this.states[ep]={state:'error',message:error.message};this.emit();}}
    }
    activate(ep,blob,cached) {
      if(!this.alive||ep!==this.current) return;
      if(this.url) URL.revokeObjectURL(this.url);this.url=URL.createObjectURL(blob);
      this.states[ep]={state:'ready',cached,url:this.url};this.emit();
    }
    async persist(ep,descriptor,blob,signal) {
      const limit=this.settings().limit*1024**2, records=await this.store.list();
      if(signal.aborted||!this.alive) throw abort();
      if(blob.size>limit) {this.warning='本集超过缓存上限，仅本次播放';return false;}
      let total=records.reduce((sum,r)=>sum+r.bytes,0),victims=[];
      for(const r of records.sort((a,b)=>a.time-b.time)) if(total+blob.size>limit && r.key!==this.key(this.current)) {victims.push(r.key);total-=r.bytes;}
      if(victims.length) {await this.store.remove(victims);for(const n of Object.keys(this.states)) if(victims.includes(this.key(n))) delete this.states[n];}
      if(total+blob.size>limit) {this.warning='缓存容量已满，后台预缓存已暂停';return false;}
      if(signal.aborted||!this.alive) throw abort();
      try {
        await this.store.put({key:this.key(ep),sid:this.sid,ep,vid:String(descriptor.vid),bytes:blob.size,time:Date.now()},blob);
        if(signal.aborted||!this.alive) {await this.store.remove([this.key(ep)]);throw abort();}return true;
      } catch(error) {
        if(error.name==='AbortError') throw error;
        this.warning='浏览器存储空间不足，仅播放当前集；可清理设备缓存后重试';return false;
      }
    }
    async pump() {
      if(!this.alive||this.suspended||this.running||!this.queue.length) return;
      if(document.hidden&&this.queue[0]!==this.current) return;
      const ep=this.queue.shift(),ctl=new AbortController(),job={ep,ctl};this.running=job;
      const timer=setTimeout(()=>{job.timedout=true;ctl.abort();},180000);
      this.states[ep]={state:'working',message:`正在下载第${ep}集`};this.emit();
      try {
        let descriptor=this.links.get(ep);
        if(!descriptor) {for(const d of await this.manifest(this.sid,ep,false,ctl.signal)) this.links.set(d.ep,d);descriptor=this.links.get(ep);}
        if(!descriptor||String(descriptor.vid)!==String(this.episodes.find(e=>e.index===ep)?.vid)) throw Error('视频链接与本集不匹配，请重试');
        const progress=(phase,p)=>{if(this.running===job&&!ctl.signal.aborted) {this.states[ep]={state:'working',message:`正在${phase}第${ep}集${p?' · '+Math.round(p*100)+'%':''}`};this.emit();}};
        let blob;
        try {blob=await this.produce(descriptor,ctl.signal,progress);} catch(error) {
          if(!(error.expired||error.refresh)||ctl.signal.aborted) throw error;
          for(const d of await this.manifest(this.sid,ep,true,ctl.signal)) this.links.set(d.ep,d);
          descriptor=this.links.get(ep);blob=await this.produce(descriptor,ctl.signal,progress);
        }
        if(ctl.signal.aborted||!this.alive) throw abort();
        const cached=await this.persist(ep,descriptor,blob,ctl.signal);
        if(ctl.signal.aborted||!this.alive) throw abort();
        if(ep===this.current) this.activate(ep,blob,cached);else this.states[ep]={state:cached?'ready':'idle',cached};
        if(!cached) {this.queue=[];for(const n of Object.keys(this.states)) if(this.states[n].state==='queued') delete this.states[n];}
      } catch(error) {
        if(job.timedout) {this.states[ep]={state:'error',message:'设备下载或解密超时，请重试'};if(ep===this.current) this.queue=[];}
        else if(ctl.signal.aborted||error.name==='AbortError') {if(this.states[ep]?.state==='working') delete this.states[ep];if(this.alive && !this.suspended && ep===this.current&&!this.queue.includes(ep)) {this.states[ep]={state:'queued'};this.queue.unshift(ep);}}
        else {this.states[ep]={state:'error',message:error.message||'设备准备失败，请重试'};if(ep===this.current) this.queue=[];}
      } finally {clearTimeout(timer);if(this.running===job) this.running=null;if(this.alive) {this.emit();this.pump();}}
    }
    async complete(ep,last) {
      const s=this.settings();if(!s.previous&&!(last&&s.cleanup)) return;
      const records=await this.store.list();const victims=records.filter(r=>r.sid===this.sid&&(last||r.ep<=ep)).map(r=>r.key);
      await this.store.remove(victims);for(const n of Object.keys(this.states)) if(victims.includes(this.key(n))) {if(Number(n)===this.current) this.states[n].cached=false;else delete this.states[n];}this.emit();
    }
    pauseQueue() {this.suspended=true;this.generation++;this.queue=[];this.running?.ctl.abort();for(const n of Object.keys(this.states)) if(['queued','working'].includes(this.states[n].state)) delete this.states[n];}
    stop() {this.alive=false;this.pauseQueue();if(this.url) URL.revokeObjectURL(this.url);document.removeEventListener('visibilitychange',this.hidden);sessions.delete(this);}
  }
  async function clear() {
    const active=[...sessions];active.forEach(s=>s.pauseQueue());
    // Wait for cancelled writers before clearing, so late completions cannot refill it.
    await Promise.all(active.map(async s=>{while(s.running) await new Promise(r=>setTimeout(r,20));}));
    await store.clear();active.forEach(s=>{s.states={};s.warning='设备缓存已清理，重新选集后恢复预缓存';s.emit();});
  }
  root.DeviceMedia={defaults,settings,save,mode,supported,Session,Store,clear,usage:async()=>{const r=await store.list();return {episodes:r.length,bytes:r.reduce((sum,x)=>sum+x.bytes,0)};}};
  if(typeof module!=='undefined') module.exports=root.DeviceMedia;
})(globalThis);
