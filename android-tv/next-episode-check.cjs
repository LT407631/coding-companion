// Production controller + TV bridge, with deliberately delayed NAS completion/prepare.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../nas/web/app.html'),'utf8');
const binding=html.slice(html.indexOf('W.bind = () =>'),html.indexOf('/* ================= 视图: 收藏'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function settle(){for(let i=0;i<30;i++)await Promise.resolve();}
function fixture(optimized=true){
  let now=10000,cacheState='ready';const nodes=new Map(),requests=[],messages=[],complete=deferred(),nextPrepare=deferred(),status=deferred();
  let holdStatus=false;const life=new EventTarget(),location={hash:'#/watch/123/43'},navigations=[];
  Object.defineProperty(location,'href',{set(url){navigations.push(url);life.dispatchEvent(new Event('beforeunload'));}});
  const video=new EventTarget();Object.assign(video,{isConnected:true,controls:true,getAttribute:()=>null,removeAttribute(){},getBoundingClientRect:()=>({left:0,top:0,width:1920,height:1080})});
  function node(){const classes=new Set();return {style:{},classList:{toggle(){},add:n=>classes.add(n),remove:n=>classes.delete(n),contains:n=>classes.has(n)},setAttribute(){},scrollIntoView(){},textContent:''};}
  for(const s of ['#video','#vload','#vload .spin','#vtip','#vretry','#vstart','#watch-toggle','#autoc','#wtitle','#watch-series','#watch-position','#watch-episode','#cache-progress'])nodes.set(s,s==='#video'?video:node());
  const data=()=>({current:{state:cacheState},ready:81,queued:0,episodes:{}});
  const ctx={console,Event,Blob,MutationObserver:class {observe(){} disconnect(){}},location,innerWidth:1920,crypto:{randomUUID:()=> 'test'},AbortController,Date:{now:()=>now},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    addEventListener:life.addEventListener.bind(life),removeEventListener:life.removeEventListener.bind(life),navigator:{sendBeacon:p=>requests.push({path:p,beacon:true})},
    document:{querySelector:s=>nodes.get(s)||null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}},$:s=>nodes.get(s),
    hist:{get:()=>({ep:43,pos:43,finished:false}),put(){}},toast:m=>messages.push(m),go(){},DeviceMedia:{mode:()=> 'nas'},
    W:{sid:'123',ep:43,eps:Array(81).fill({}),speed:1,auto:true,title:'Test',save(){}},
    fetch:async(p,o={})=>{
      const body=o.body?JSON.parse(o.body):null;requests.push({path:p,body,time:now});
      if(p==='/playback/complete')await complete.promise;
      if(p==='/playback/prepare'&&body.ep!==43)await nextPrepare.promise;
      if(p.startsWith('/playback/status')&&holdStatus)await status.promise;
      return {ok:true,json:async()=>data()};
    }};ctx.window=ctx;
  for(const file of ['tv-native.js',...(optimized?['tv-transition.js']:[])])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'assets',file),'utf8'),ctx);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../nas/web/assets/playback-status.js'),'utf8'),ctx);
  ctx.CodingNative.installVideo(video);vm.runInNewContext(binding,ctx);ctx.W.bind();ctx.W.load(43,true);
  return {ctx,video,nodes,requests,messages,navigations,complete,nextPrepare,status,now:n=>now=n,cache:s=>cacheState=s,holdStatus:()=>holdStatus=true,
    report:(type,pos,dur=180)=>ctx.CodingNative.report(ctx.CodingNative.snapshot().id,type,{pos,dur}),state:()=>ctx.CodingNative.snapshot()};
}
async function playing(f){await settle();f.report('loadedmetadata',0);f.report('seeked',43);f.report('playing',43);}
async function tail(f){f.report('timeupdate',172);f.state();await settle();f.now(16000);f.report('timeupdate',178);return f.state();}
(async()=>{
  const old=fixture(false);await playing(old);await tail(old);old.report('ended',180);await settle();
  assert.equal(old.ctx.W.ep,43,'baseline waits for completion response even with all files cached');
  old.complete.resolve();await settle();assert.equal(old.ctx.W.ep,44);assert.equal(old.state().src,'','baseline then waits for prepare response');
  old.nextPrepare.resolve();await settle();assert.equal(old.state().src,'/stream?series_id=123&ep=44');

  const early=fixture();await playing(early);early.report('timeupdate',172);early.state();await settle();early.now(16000);early.report('timeupdate',174);
  assert.equal(early.ctx.CodingTVTransition.next(early.ctx.W,early.video),'','normal devices keep final-two-second prewarm');
  assert.equal(early.ctx.CodingTVTransition.next(early.ctx.W,early.video,true),'/stream?series_id=123&ep=44','Redmi metadata/authorization can prepare in last eight seconds');
  early.ctx.W.auto=false;assert.equal(early.ctx.CodingTVTransition.next(early.ctx.W,early.video,true),'','auto-off cancels early metadata preparation');
  const fast=fixture();await playing(fast);const state=await tail(fast);
  assert.equal(state.next,'/stream?series_id=123&ep=44');assert.equal(state.src,'/stream?series_id=123&ep=43','tail must retain current episode and its last two seconds');
  assert.equal(fast.requests.filter(r=>r.path==='/playback/prepare').length,1,'prefetch status does not change current NAS session');
  const id=state.id;fast.report('ended',180);await settle();
  assert(fast.nodes.get('#vload').classList.contains('tv-transition-quiet'),'cached automatic transition hides its loading overlay');
  assert.equal(fast.ctx.W.ep,44);assert.equal(fast.state().src,'/stream?series_id=123&ep=44','cached next source is selected while completion AND prepare are still pending');
  assert.equal(fast.requests.filter(r=>r.path==='/playback/prepare').length,1,'next NAS prepare must wait for current completion');
  fast.ctx.CodingNative.report(id,'ended',{pos:180,dur:180});assert.equal(fast.requests.filter(r=>r.path==='/playback/complete').length,1);
  fast.report('loadedmetadata',0);const commands=fast.state().commands;assert(commands.some(c=>c.op==='play'));assert(!commands.some(c=>c.op==='seek'));
  fast.report('playing',0);assert(!fast.nodes.get('#vload').classList.contains('tv-transition-quiet'));assert.equal(fast.nodes.get('#vload').style.display,'none');
  fast.complete.resolve();await settle();assert.equal(fast.requests.filter(r=>r.path==='/playback/prepare').length,2);
  const adopted=fast.state().id;fast.nextPrepare.resolve();await settle();assert.equal(fast.state().id,adopted,'server acknowledgement must not reload the already playing next episode');
  assert.deepEqual(fast.navigations,[]);assert.deepEqual(fast.messages,[]);assert(!fast.requests.some(r=>r.path==='/playback/close'));

  const off=fixture();await playing(off);await tail(off);off.ctx.W.auto=false;assert.equal(off.state().next,'');off.report('ended',180);off.complete.resolve();await settle();assert.equal(off.ctx.W.ep,43);
  const paused=fixture();await playing(paused);await tail(paused);paused.video.pause();assert.equal(paused.state().next,'');paused.report('playing',178);paused.report('timeupdate',100);assert.equal(paused.state().next,'','seeking out of the tail releases standby');
  const last=fixture();await playing(last);last.ctx.W.eps.length=43;assert.equal((await tail(last)).next,'');last.report('ended',180);last.complete.resolve();await settle();assert.equal(last.ctx.W.alive,false);assert(last.requests.some(r=>r.path==='/playback/close'));
  const missing=fixture();missing.cache('queued');await playing(missing);assert.equal((await tail(missing)).next,'');missing.report('ended',180);await settle();assert.equal(missing.ctx.W.ep,43,'uncached next uses existing preparation path');
  const stale=fixture();await playing(stale);stale.holdStatus();stale.report('timeupdate',178);stale.state();stale.ctx.W.load(50);stale.status.resolve();await settle();assert.equal(stale.state().next,'','late readiness cannot warm a different episode');
  const manual=fixture();await playing(manual);await tail(manual);manual.ctx.W.load(44);assert(!manual.nodes.get('#vload').classList.contains('tv-transition-quiet'));assert.equal(manual.state().src,'','manual selection cannot consume natural-end handoff');
  const expired=fixture();await playing(expired);await tail(expired);expired.now(30000);expired.report('ended',180);await settle();assert.equal(expired.ctx.W.ep,43,'expired readiness must fall back');
  const rapid=fixture();await playing(rapid);await tail(rapid);rapid.report('ended',180);await settle();rapid.report('loadedmetadata',0);rapid.report('playing',0);rapid.now(22000);rapid.report('timeupdate',178);rapid.state();await settle();rapid.report('ended',180);await settle();
  assert.equal(rapid.ctx.W.ep,45,'even a subsequent short episode can finish while NAS acknowledgements are pending');
  rapid.complete.resolve();await settle();assert.equal(rapid.requests.filter(r=>r.path==='/playback/complete').length,1,'second complete must wait for its own prepare');
  rapid.nextPrepare.resolve();await settle();assert.deepEqual(rapid.requests.filter(r=>!r.path.startsWith('/playback/status')).map(r=>[r.path,r.body.ep]),[['/playback/prepare',43],['/playback/complete',43],['/playback/prepare',44],['/playback/complete',44],['/playback/prepare',45]],'backend session requests stay ordered across multiple rapid transitions');
  const exit=fixture();await playing(exit);await tail(exit);exit.report('ended',180);await settle();exit.ctx.W.stop();exit.complete.resolve();await settle();assert.equal(exit.requests.filter(r=>r.path==='/playback/prepare').length,1,'queued preparation cannot reopen an exited session');
  console.log('PASS: cached-next A/B removes completion + prepare from TV handoff critical path; ordered NAS accounting, uncut last two seconds, auto-off, pause, seek-back, last episode, uncached/expired fallback, stale response, manual selection, duplicate events, no navigation and loading dismissal.');
  if(process.argv.includes('--browser'))await browserCheck();
})().catch(e=>{console.error(e);process.exitCode=1;});

async function browserCheck(){
  const {chromium}=require('/Users/liteng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent(`<div id="watch-toggle"></div><div id="wtitle"></div><div id="watch-series"></div><div id="watch-position"></div><div id="watch-episode"></div><div id="autoc"></div><div id="cache-progress"></div><div id="vload"><div class="spin"></div><div id="vtip"></div><button id="vstart"></button><button id="vretry"></button></div><video id="video"></video>`);
    await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'assets/tv.css'),'utf8')});
    await page.evaluate(()=>{
      document.documentElement.classList.add('coding-tv');
      location.hash='#/watch/123/43';window.$=s=>document.querySelector(s);window.hist={get:()=>({ep:43,pos:43}),put(){}};
      window.requests=[];window.messages=[];window.toast=m=>messages.push(m);window.go=()=>{};window.DeviceMedia={mode:()=> 'nas'};
      window.W={sid:'123',ep:43,eps:Array(81).fill({}),speed:1,auto:true,title:'Test',save(){}};
      const complete=new Promise(r=>window.finishComplete=r),prepare=new Promise(r=>window.finishPrepare=r);
      window.fetch=async(p,o={})=>{
        const body=o.body?JSON.parse(o.body):null;requests.push({path:p,body});
        if(p==='/playback/complete')await complete;
        if(p==='/playback/prepare'&&body.ep!==43){await prepare;if(window.failPrepare)throw new Error('offline');}
        return {ok:true,json:async()=>({current:{state:'ready'},ready:81,queued:0,episodes:{}})};
      };
      window.setInterval=()=>0;window.clearInterval=()=>{};
      window.navigator.sendBeacon=p=>{requests.push({path:p,beacon:true});return true;};
    });
    for(const file of ['tv-native.js','tv-transition.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'assets',file),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../nas/web/assets/playback-status.js'),'utf8')});
    await page.evaluate(()=>CodingNative.installVideo($('#video')));await page.addScriptTag({content:binding});
    await page.evaluate(()=>{W.bind();W.load(43,true);});await page.waitForFunction(()=>W.activeEp===43);
    assert.equal(await page.evaluate(()=>getComputedStyle($('#vload')).display),'flex','first playback retains loading feedback');
    await page.evaluate(()=>{
      const id=CodingNative.snapshot().id;CodingNative.report(id,'loadedmetadata',{pos:0,dur:180});CodingNative.report(id,'seeked',{pos:43,dur:180});CodingNative.report(id,'playing',{pos:43,dur:180});CodingNative.report(id,'timeupdate',{pos:178,dur:180});CodingNative.snapshot();
    });
    await page.waitForFunction(()=>CodingNative.snapshot().next!== '');
    const current=await page.evaluate(()=>({ep:W.ep,src:CodingNative.snapshot().src}));assert.equal(current.ep,43);
    await page.evaluate(()=>{const s=CodingNative.snapshot();CodingNative.report(s.id,'ended',{pos:180,dur:180});});
    const handoff=await page.evaluate(()=>({ep:W.ep,src:CodingNative.snapshot().src,alive:W.alive,requests}));
    assert.equal(await page.evaluate(()=>getComputedStyle($('#vload')).display),'none','no loading text/spinner flashes during cached automatic handoff');
    assert.equal(handoff.ep,44);assert.equal(handoff.alive,true);assert.equal(handoff.src,'/stream?series_id=123&ep=44');assert.equal(handoff.requests.filter(r=>r.path==='/playback/prepare').length,1);
    await page.evaluate(()=>{
      const s=CodingNative.snapshot();CodingNative.report(s.id,'loadedmetadata',{pos:0,dur:180});window.nextCommands=CodingNative.snapshot().commands;CodingNative.report(s.id,'playing',{pos:0,dur:180});finishComplete();
    });await page.waitForFunction(()=>requests.filter(r=>r.path==='/playback/prepare').length===2);
    const active=await page.evaluate(()=>({id:CodingNative.snapshot().id,hidden:$('#vload').style.display,commands:nextCommands,alive:W.alive}));assert.equal(active.hidden,'none');assert(active.commands.some(c=>c.op==='play'));
    await page.evaluate(()=>finishPrepare());await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>CodingNative.snapshot().id),active.id);
    await page.evaluate(()=>{const s=CodingNative.snapshot();CodingNative.report(s.id,'timeupdate',{pos:178,dur:180});CodingNative.snapshot();});
    await page.waitForFunction(()=>CodingNative.snapshot().next!=='');
    await page.evaluate(()=>{window.failPrepare=true;const s=CodingNative.snapshot();CodingNative.report(s.id,'ended',{pos:180,dur:180});});
    await page.waitForFunction(()=>getComputedStyle($('#vload')).display==='flex' && $('#vretry').style.display!=='none');
    assert.match(await page.locator('#vtip').textContent(),/暂时无法连接/,'backend failures restore visible retry feedback');
    await page.evaluate(()=>{W.load(46);});
    assert.equal(await page.evaluate(()=>getComputedStyle($('#vload')).display),'flex','manual switching clears silent handoff');
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));assert.equal(await page.evaluate(()=>W.alive),false);
    console.log('PASS: actual Chrome DOM/lifecycle + production W.bind + TV bridge: cached-next handoff while both NAS responses pending, original final seconds preserved, automatic play command, silent cached handoff, first/manual feedback and failure retry visibility, loading dismissal, no premature unload, ordered prepare and no source reload. Native decoder remains covered separately by JVM doubles; TV firmware timing is not measured.');
  }finally{await browser.close();}
}
