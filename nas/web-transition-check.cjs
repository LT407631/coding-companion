const fs=require('fs'),vm=require('vm'),assert=require('assert');
let now=1000,id=0;const timers=new Map(),delays=new Map(),overlay={style:{display:'flex'}},events=new EventTarget(),video=Object.assign(new EventTarget(),{controls:true,duration:45,currentTime:0,paused:false});
const document={querySelector:()=>overlay,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)};
const pointer=(name,x,y)=>{const event=new Event(name);Object.defineProperties(event,{clientX:{value:x},clientY:{value:y}});return event};
const ctx={window:{},document,Date:{now:()=>now},setTimeout(fn,delay){timers.set(++id,fn);delays.set(id,delay);return id},clearTimeout(i){timers.delete(i);delays.delete(i)}};
vm.runInNewContext(fs.readFileSync('nas/web/assets/playback-status.js','utf8'),ctx);
const w={alive:true,mode:'nas',token:1,auto:true,ep:1,eps:[{},{}]},t=ctx.window.CodingWebTransition.create(w,video);
events.dispatchEvent(pointer('pointermove',100,100));
t.switching(true);assert.equal(video.controls,false,'automatic episode switching suppresses native controls');
events.dispatchEvent(pointer('mousemove',100,100));assert.equal(video.controls,false,'Safari synthetic stationary movement must not restore controls');
t.playing();events.dispatchEvent(pointer('pointermove',112,112));assert.equal(video.controls,false,'movement before the post-playing guard expires must stay suppressed');
{ const [key,fn]=[...timers.entries()][0]; timers.delete(key); fn(); }
events.dispatchEvent(pointer('mousemove',112,112));assert.equal(video.controls,false,'stationary movement after playing must stay suppressed');
events.dispatchEvent(pointer('pointermove',120,120));assert.equal(video.controls,true,'intentional pointer movement restores native controls');
t.switching(true);t.hide();assert.equal(video.controls,false,'loading dismissal does not reopen controls');
t.playing();assert.equal(video.controls,false,'playing keeps native controls suppressed');
t.switching(false);assert.equal(video.controls,true,'manual switching keeps native controls available');
video.currentTime=44.2;video.dispatchEvent(new Event('timeupdate'));assert.equal(video.controls,false,'hide before the native player reaches ended, before completion API finishes');
video.currentTime=10;video.dispatchEvent(new Event('timeupdate'));assert.equal(video.controls,true,'seeking away from the ending restores normal controls');
t.remember({current:{state:'ready'},episodes:{2:{state:'ready'},3:{state:'queued'}}});
overlay.style.display='flex';assert.equal(t.select(2,false).current.state,'ready');assert.equal(overlay.style.display,'flex');assert.equal(timers.size,0);
t.switching(true,true);t.hide();t.waiting();t.waiting();assert.equal(timers.size,1);assert.equal(delays.get([...timers.keys()][0]),1800);
{ const [key,fn]=[...timers.entries()][0]; timers.delete(key); delays.delete(key); fn(); }assert.equal(overlay.style.display,'flex');
t.hide();assert.equal(timers.size,0);assert.equal(t.select(3,false),null);assert.equal(t.select(2,true),null);
t.switching(false,false);t.waiting();assert.equal(delays.get([...timers.keys()][0]),450);t.hide();
t.select(2,false);t.show();assert.equal(overlay.style.display,'flex');assert.equal(timers.size,0);
now+=8000;assert.equal(t.select(2,false),null);now=1000;w.mode='device';assert.equal(t.select(2,false),null);
w.mode='nas';t.select(2,false);t.stop();assert.equal(timers.size,0);
console.log('PASS: pure cached selection, 1800ms cached feedback, 450ms normal feedback, waiting deduplication, retry/error visibility, expiry, device isolation and stop cleanup');
if(!process.env.FULLSCREEN_SAFARI_QA)(async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || undefined,headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<video id="video" controls></video>'+['vload','vtip','vretry','vstart','watch-toggle','autoc','wtitle','watch-series','watch-position','watch-episode','cache-progress'].map(id=>`<div id="${id}">${id==='vload'?'<i class="spin"></i>':''}</div>`).join(''));
  for(const file of ['playback-status.js'])await page.addScriptTag({content:fs.readFileSync('nas/web/assets/'+file,'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.DeviceMedia={mode:()=> 'nas'};window.hist={get:()=>null};window.toast=()=>{};window.go=()=>{};
   window.W={sid:'qa',ep:1,eps:[{},{}],auto:true,speed:1,save(){}};
   window.qaData={current:{state:'ready'},ready:2,queued:0,episodes:{1:{state:'ready'},2:{state:'ready'}}};
   navigator.sendBeacon=()=>true;window.api=async()=>qaData;window.fetch=async()=>({ok:true,json:async()=>qaData});
   const v=$('#video'),listen=v.addEventListener.bind(v);v.addEventListener=(name,fn)=>{if(name!=='error')listen(name,fn)};v.load=()=>{};v.pause=()=>{};v.play=()=>Promise.resolve();
  });
  const html=fs.readFileSync('nas/web/app.html','utf8');await page.addScriptTag({content:html.slice(html.indexOf('W.bind ='),html.indexOf('W.save ='))});
  await page.evaluate(()=>{W.bind();W.load(1,true)});await page.waitForFunction(()=>W.activeEp===1);
  assert.equal(await page.locator('#vload').evaluate(e=>e.style.display),'flex');
  await page.evaluate(()=>{window.fetch=()=>new Promise(()=>{});W.load(2,true,false,false)});
  assert.equal(await page.locator('#video').getAttribute('src'),'/stream?series_id=qa&ep=2');
  assert.equal(await page.locator('#vload').evaluate(e=>e.style.display),'none');
  assert.equal(await page.locator('#video').evaluate(e=>e.controls),false,'production automatic handoff suppresses native controls before src changes');
  await page.evaluate(()=>$('#video').dispatchEvent(new Event('playing')));
  assert.equal(await page.locator('#video').evaluate(e=>e.controls),false,'playing must not make WebKit controls flash again');
  await page.waitForTimeout(550);assert.equal(await page.locator('#vload').evaluate(e=>e.style.display),'none');
  await page.mouse.move(10,10);assert.equal(await page.locator('#video').evaluate(e=>e.controls),false,'first pointer sample after playing only establishes Safari baseline');
  await page.mouse.move(20,20);assert.equal(await page.locator('#video').evaluate(e=>e.controls),true,'meaningful user pointer movement restores controls');
  await page.evaluate(()=>$('#video').dispatchEvent(new Event('waiting')));await page.waitForTimeout(550);
  assert.equal(await page.locator('#vload').evaluate(e=>e.style.display),'none');
  await page.waitForTimeout(1400);
  assert.equal(await page.locator('#vload').evaluate(e=>e.style.display),'flex');
  await page.evaluate(()=>{W.stop()});
  await fullscreenCheck(browser);
  console.log('PASS: Chrome production W.bind first feedback; cached automatic source set while prepare pending; no short spinner or native-control flash; user input restores controls; prolonged waiting restores feedback; exit cleanup');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});

// Local generated clip and the production W.bind exercise natural ended + slow completion.
// FULLSCREEN_SAFARI_QA=1 leaves this same fixture on loopback for manual Safari validation.
async function fullscreenFixture() {
 const http=require('http'),{execFileSync}=require('child_process');
 const clip=execFileSync(process.env.FFMPEG_BIN || 'ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-t',process.env.FULLSCREEN_SAFARI_QA?'12':'4','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{maxBuffer:8*1024*1024});
 const html=fs.readFileSync('nas/web/app.html','utf8'),bind=html.slice(html.indexOf('W.bind ='),html.indexOf('W.save ='));
 const ids=['vload','vtip','vretry','vstart','watch-toggle','autoc','wtitle','watch-series','watch-position','watch-episode','cache-progress'];
 const data={current:{state:'ready'},ready:4,queued:0,episodes:{1:{state:'ready'},2:{state:'ready'},3:{state:'ready'},4:{state:'ready'}}};
 const fixture=`<!doctype html><meta charset="utf-8"><title>全屏连播本地验证</title><style>body{margin:0;background:#16171c;color:white;font:16px sans-serif}.stage{position:relative;width:800px;max-width:100%;margin:auto}video{width:100%}#vload{position:absolute;top:40%;left:40%}#report{white-space:pre-wrap}</style><p>本地生成测试视频 · 双击画面或点击右上角全屏 · F切换 · Esc退出</p><div class="stage" id="stage"><video id="video" controls muted playsinline></video><div id="vload"><i class="spin"></i><span id="vtip"></span><button id="vretry">重试</button><button id="vstart">播放</button></div></div>${ids.filter(id=>!['vload','vtip','vretry','vstart'].includes(id)).map(id=>`<div id="${id}"></div>`).join('')}<pre id="report"></pre><script src="/transition.js"></script><script>
 window.$=s=>document.querySelector(s);window.DeviceMedia={mode:()=> 'nas'};window.hist={get:()=>null};window.toast=console.log;window.go=()=>{};
 window.W={sid:'local-qa',title:'本地全屏连播验证',ep:1,eps:[{},{},{},{}],auto:true,speed:1,save(){}};
 window.api=async path=>(await fetch(path)).json();
 ${bind}
 const stage=$('#stage');['requestFullscreen','webkitRequestFullscreen'].forEach(name=>{if(!stage[name])return;const original=stage[name];stage[name]=function(){const result=original.call(this);if(result&&result.catch)result.catch(error=>fetch('/qa-event',{method:'POST',body:JSON.stringify({event:'fullscreen-error',message:error.message,name:error.name,active:document.hasFocus(),gesture:navigator.userActivation?.isActive})}));return result;};});
 W.bind();window.qaRows=[];
 function sample(event){const v=$('#video'),row={event,ep:W.ep,time:v.currentTime,controls:v.controls,full:document.fullscreenElement===v.parentElement||document.webkitFullscreenElement===v.parentElement,native:!!v.webkitDisplayingFullscreen,visible:!!document.querySelector('.coding-media-bar.is-visible')};qaRows.push(row);$('#report').textContent=JSON.stringify(row);fetch('/qa-event',{method:'POST',body:JSON.stringify(row)}).catch(()=>{});}
 ['ended','playing','loadedmetadata','loadstart'].forEach(name=>$('#video').addEventListener(name,()=>sample(name)));
 $('#video').addEventListener('timeupdate',()=>{if($('#video').duration-$('#video').currentTime<.9)sample('ending')});
 W.load(1,true);
 </script>`;
 const rows=[];
 const server=http.createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/stream'){
   const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range||''),start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),clip.length-1):clip.length-1;
   const headers={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1};
   if(match)headers['Content-Range']=`bytes ${start}-${end}/${clip.length}`;
   res.writeHead(match?206:200,headers);return res.end(clip.subarray(start,end+1));
  }
  if(path==='/transition.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(fs.readFileSync('nas/web/assets/playback-status.js'))}
  if(path==='/qa-event'){let body='';req.on('data',chunk=>body+=chunk);return req.on('end',()=>{rows.push(JSON.parse(body));res.end('{}')})}
  if(path==='/qa-results'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(rows))}
  if(path.startsWith('/playback/')){res.writeHead(200,{'Content-Type':'application/json'});if(path==='/playback/complete')return setTimeout(()=>res.end(JSON.stringify(data)),700);return res.end(JSON.stringify(data))}
  res.writeHead(200,{'Content-Type':'text/html'});res.end(fixture);
 });
 await new Promise(resolve=>server.listen(process.env.FULLSCREEN_SAFARI_QA?18769:0,'127.0.0.1',resolve));
 return {server,url:`http://127.0.0.1:${server.address().port}`,rows};
}
async function fullscreenCheck(browser){
 const fixture=await fullscreenFixture(),page=await browser.newPage();
 page.setDefaultTimeout(10000);
 try{
  await page.goto(fixture.url);await page.waitForFunction(()=>W.activeEp===1&&W.mediaReady);
  await page.getByRole('button',{name:'进入全屏'}).click();await page.mouse.move(0,0);
  await page.waitForFunction(()=>document.fullscreenElement?.id==='stage');
  await page.waitForFunction(()=>qaRows.some(row=>row.ep===3&&row.event==='playing'),{},{timeout:20000});
  const rows=await page.evaluate(()=>qaRows.filter(row=>row.full));
  assert(rows.some(row=>row.event==='ended'&&row.ep===1),'clip 1 must end naturally');
  assert(rows.some(row=>row.event==='ended'&&row.ep===2),'clip 2 must end naturally');
  assert(rows.some(row=>row.event==='playing'&&row.ep===3),'clip 3 must play');
  assert(rows.every(row=>!row.controls&&!row.native&&!row.visible),'ending, async completion, source replacement and new playback stay in container fullscreen with controls hidden');
  if(process.env.WEB_TRANSITION_EVIDENCE){fs.mkdirSync(process.env.WEB_TRANSITION_EVIDENCE,{recursive:true});fs.writeFileSync(require('path').join(process.env.WEB_TRANSITION_EVIDENCE,'natural-transitions.json'),JSON.stringify(rows,null,2));await page.screenshot({path:require('path').join(process.env.WEB_TRANSITION_EVIDENCE,'fullscreen-quiet.png')});}
  await page.waitForTimeout(400);await page.mouse.move(200,100);await page.mouse.move(220,110);
  assert.equal(await page.locator('.coding-media-bar').evaluate(el=>el.classList.contains('is-visible')),true,'real movement restores page controls in container fullscreen');
  assert.equal(await page.locator('#video').evaluate(v=>v.controls),false,'intentional input must never re-enable the system controls');
  await page.keyboard.press('f');await page.waitForFunction(()=>!document.fullscreenElement);
  assert.equal(await page.locator('.coding-media-bar.is-visible').count(),1,'F exits fullscreen and keeps page controls');
  await page.evaluate(()=>{W.auto=false;W.load(2)});await page.waitForFunction(()=>W.ep===2&&W.mediaReady);
  await page.getByRole('button',{name:'进入全屏'}).focus();await page.keyboard.press('f');
  await page.waitForFunction(()=>document.fullscreenElement?.id==='stage');
  await page.waitForFunction(()=>$('#video').ended,{},{timeout:7000});
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('.coding-media-bar.is-visible').count(),1,'keyboard restores controls with autoplay disabled');
  assert.equal(await page.locator('#video').evaluate(v=>v.controls),false);
  await page.keyboard.press('f');await page.waitForFunction(()=>!document.fullscreenElement);
  await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForFunction(()=>!$('#video').paused);
  await page.getByRole('button',{name:'暂停',exact:true}).click();assert.equal(await page.locator('#video').evaluate(v=>v.paused),true);
  await page.getByRole('slider',{name:'播放进度'}).fill('500');assert(Math.abs(await page.locator('#video').evaluate(v=>v.currentTime/v.duration)-.5)<.05);
  await page.getByRole('slider',{name:'音量',exact:true}).fill('0.5');assert.equal(await page.locator('#video').evaluate(v=>v.volume),.5);
  await page.getByRole('combobox',{name:'播放速度'}).selectOption('1.5');assert.equal(await page.locator('#video').evaluate(v=>v.playbackRate),1.5);
  for(const width of [390,768,1440]){
   await page.setViewportSize({width,height:800});await page.locator('.coding-fullscreen-button').focus();
   assert.equal(await page.locator('.coding-media-bar').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'control bar must fit the viewport');
   if(process.env.WEB_TRANSITION_EVIDENCE)await page.screenshot({path:require('path').join(process.env.WEB_TRANSITION_EVIDENCE,'controls-'+width+'.png')});
  }
  await page.evaluate(()=>{W.stop()});assert.equal(await page.locator('.coding-fullscreen-button').count(),0);
  assert.equal(await page.locator('#video').evaluate(v=>v.controls),true,'cleanup restores the original video contract');
  await page.goto(fixture.url);await page.waitForFunction(()=>W.mediaReady);
  await page.evaluate(()=>{document.querySelector('#stage').requestFullscreen=()=>Promise.reject(Error('denied'))});
  await page.getByRole('button',{name:'进入全屏'}).click();await page.waitForFunction(()=>!document.querySelector('.coding-fullscreen-button'));
  assert.equal(await page.locator('#video').evaluate(v=>v.controls),true,'unsupported fullscreen must retain the original usable player');
  await page.evaluate(()=>W.stop());
  console.log('PASS: real video naturally ends twice; slow completion + new source stay in container fullscreen without controls; movement/keyboard/F and teardown');
 } finally{await page.close();fixture.server.close()}
}
if(process.env.FULLSCREEN_SAFARI_QA){fullscreenFixture().then(({url})=>console.log('Safari local fixture: '+url));}
