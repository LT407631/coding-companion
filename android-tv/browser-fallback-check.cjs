// Real HTMLVideoElement + maintained W.bind: authentication, playback and lifecycle.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const project=path.resolve(__dirname,'../../..'),evidence=path.join(project,'资料/04_测试与验收/TV轻量播放');
const media=path.join(project,'临时/TV兼容与焦点/解码真验证/h264-landscape.mp4');
const app=fs.readFileSync(path.join(__dirname,'../nas/web/app.html'),'utf8');
const main=fs.readFileSync(path.join(__dirname,'src/net/codingcompanion/tv/MainActivity.java'),'utf8');
const phone=fs.readFileSync(path.join(__dirname,'assets/tv-phone-input.js'),'utf8');
assert.match(main,/site\+"\/ui\?compat=1"/);assert.doesNotMatch(phone,/\basync\s+function\b|=>/);
const binding=app.slice(app.indexOf('W.bind = () =>'),app.indexOf('/* ================= 视图: 收藏'));
let streamRequests=0,denied=0;const requests=[];
const markup=`<!doctype html><html class="coding-tv"><meta name="viewport" content="width=1280"><link rel="stylesheet" href="/tv.css"><style>body{margin:0;background:#111;color:white}.stage{width:100vw;height:80vh}video{width:100%;height:100%;object-fit:contain}#view{display:none}</style><div id="view"></div><div class="watch"><div id="drawer"></div><div class="stage"><video id="video" playsinline></video></div><div id="vload"><i class="spin"></i><span id="vtip"></span><button id="vretry">重试</button><button id="vstart">播放</button></div></div>`+
['watch-toggle','autoc','wtitle','watch-series','watch-position','watch-episode','cache-progress'].map(id=>`<div id="${id}"></div>`).join('')+
`<div class="tv-clock"></div><div class="tv-progress"><div class="tv-progress-fill"></div></div><button class="tv-play"></button><script src="/ui/assets/playback-status.js"></script><script src="/tv-native.js"></script><script>
window.DeviceMedia={mode:()=> 'nas'};window.$=s=>document.querySelector(s);window.toast=console.log;window.go=x=>location.hash=x;window.api=async x=>(await fetch(x)).json();window.hist={get:()=>null,put:x=>window.savedHistory=x};
window.W={sid:'123',ep:1,eps:[{},{}],speed:1,auto:true,title:'QA'};
${binding}
W.bind();CodingNative.installVideo(W.video);window.begin=()=>W.load(1,true);</script>`;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/ui'){res.setHeader('Content-Type','text/html;charset=utf-8');res.setHeader('Set-Cookie','qa-session=valid; HttpOnly; SameSite=Strict');return res.end(url.searchParams.has('settings')?app:markup);}
 if(url.pathname.startsWith('/ui/assets/')){const file=path.join(__dirname,'../nas/web/assets',path.basename(url.pathname));if(fs.existsSync(file)){res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');return res.end(fs.readFileSync(file));}}
 if(url.pathname==='/playback/settings'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({settings:{mode:'ahead',ahead:3,smart_after:3,limit_gb:10,cleanup:true},usage:{}}));}
 if(url.pathname==='/watch-state'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({server:'settings-fixture',cursor:0,rows:[]}));}
 if(url.pathname==='/filters'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({rows:[]}));}
 if(url.pathname==='/library'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({items:[],has_more:false}));}
 if(url.pathname==='/tv.css'){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(__dirname,'assets/tv.css')));}
 if(url.pathname==='/tv-native.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(__dirname,'assets/tv-native.js')));}
 if(url.pathname==='/stream'){
  if(!String(req.headers.cookie).includes('qa-session=valid')){denied++;res.writeHead(401);return res.end();}
  streamRequests++;const size=fs.statSync(media).size;let start=0,end=size-1,status=200;
  if(req.headers.range){const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!range||Number(range[1])>=size){res.writeHead(416);return res.end();}start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));status=206;}
  res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',end-start+1);if(status===206)res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);res.writeHead(status);if(req.method==='HEAD')return res.end();return fs.createReadStream(media,{start,end}).pipe(res);
 }
 requests.push(url.pathname);res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({current:{state:'ready'},ready:2,queued:0,episodes:{}}));
});
async function run(){
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
 fs.mkdirSync(evidence,{recursive:true});const browser=await chromium.launch({headless:true,channel:'chrome',args:['--autoplay-policy=no-user-gesture-required']});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const base=`http://127.0.0.1:${server.address().port}`;await page.goto(base+'/ui#/watch/123/1');
  await page.evaluate(()=>begin());await page.waitForFunction(()=>CodingNative.snapshot().src);
  assert.equal(await page.evaluate(()=>getComputedStyle(W.video).opacity),'0','system video must remain hidden behind native texture');
  assert.equal(streamRequests,0,'system route never downloads a browser copy');
  const id=await page.evaluate(()=>CodingNative.snapshot().id);
  assert.equal(await page.evaluate(id=>CodingNative.useBrowser(id,location.origin+'/stream?series_id=123&ep=1&tv_profile=unknown',0,1),id),false);
  assert.equal(await page.evaluate(id=>CodingNative.useBrowser(id,'https://evil.example/stream?series_id=123&ep=1',0,1),id),false);
  assert.equal(await page.evaluate(id=>CodingNative.useBrowser(id,location.origin+'/stream?series_id=123&ep=1&tv_profile=tcl-hevc',3,1),id),true);
  await page.waitForFunction(()=>CodingNative.snapshot().pictureOutput&&W.video.currentTime>3.5);
  const actual=await page.evaluate(()=>({snapshot:CodingNative.snapshot(),width:W.video.videoWidth,height:W.video.videoHeight,history:savedHistory,clock:document.querySelector('.tv-clock').textContent}));
  assert.equal(await page.evaluate(()=>getComputedStyle(W.video).opacity),'1','browser route must show the real picture over the WebView');
  assert(actual.width>0&&actual.height>0&&actual.snapshot.browserPlaying);assert(actual.snapshot.pos>=3.5);assert.equal(actual.snapshot.commands.length,0);assert(actual.clock.startsWith('0:0'));
  await page.evaluate(()=>{W.video.pause();W.video.currentTime=2;});await page.waitForFunction(()=>!W.video.seeking);const paused=await page.evaluate(()=>W.video.currentTime);await page.waitForTimeout(400);assert(Math.abs((await page.evaluate(()=>W.video.currentTime))-paused)<.1);
  await page.evaluate(()=>W.video.play());await page.waitForFunction(()=>W.video.currentTime>2.3);
  assert.equal(await page.evaluate(id=>{CodingNative.browserControl(id-1,'stop');return CodingNative.snapshot().browser;},id),true,'old-generation stop cannot unload current video');
  await page.screenshot({path:path.join(evidence,'浏览器真实播放.png')});
  await page.evaluate(()=>{W.video.currentTime=W.video.duration-.3;});await page.waitForFunction(()=>W.ep===2&&CodingNative.snapshot().src.includes('ep=2'));
  const next=await page.evaluate(()=>CodingNative.snapshot());assert(!next.browser,'next episode waits for native route selection');assert(next.id!==id);assert.equal(requests.filter(x=>x==='/playback/complete').length,1);
  assert.equal(await page.evaluate(id=>CodingNative.useBrowser(id,location.origin+'/stream?series_id=123&ep=1',0,1),id),false,'stale browser launch rejected');
  await page.evaluate(()=>{const s=CodingNative.snapshot();CodingNative.useBrowser(s.id,location.origin+s.src,0,1);});await page.waitForFunction(()=>W.video.currentTime>.3&&CodingNative.snapshot().pictureOutput);
  await page.evaluate(()=>{location.hash='#/detail/123';CodingNative.snapshot();});assert.equal(await page.evaluate(()=>HTMLMediaElement.prototype.getAttribute.call(W.video,'src')),null,'leaving route unloads browser media');
  assert.equal(await page.evaluate(()=>getComputedStyle(W.video).opacity),'0','exit restores native video style');
  await page.goto(base+'/ui#/watch/123/1');await page.evaluate(()=>{W.video.requestVideoFrameCallback=function(){return 99;};W.video.cancelVideoFrameCallback=function(){};W.video.getVideoPlaybackQuality=function(){return {totalVideoFrames:100,droppedVideoFrames:0};};begin();});await page.waitForFunction(()=>CodingNative.snapshot().src);await page.evaluate(()=>{const s=CodingNative.snapshot();CodingNative.useBrowser(s.id,location.origin+s.src,0,1);});await page.waitForFunction(()=>W.video.currentTime>.3);
  assert.equal(await page.evaluate(()=>CodingNative.snapshot().pictureOutput),false,'decoder counters alone cannot replace a missing presentation callback');await page.evaluate(()=>CodingNative.browserControl(CodingNative.snapshot().id,'stop'));
  assert.deepEqual(errors,[]);assert.equal(denied,0);const result={actual,streamRequests,authenticated:true,noDuplicateSystemDownload:true,seekPauseResume:true,naturalNextEpisode:true,staleIsolation:true,routeCleanup:true,errors};fs.writeFileSync(path.join(evidence,'浏览器播放验证.json'),JSON.stringify(result,null,2));console.log('PASS: real browser picture, HTTP-only auth, resume/seek/pause, HUD, natural next episode, stale isolation and unload');
 }finally{await browser.close();}
}
server.listen(process.argv.includes('--serve')?8791:0,'127.0.0.1',()=>{if(process.argv.includes('--serve'))console.log('Light playback fixture ready :8791');else run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());});
