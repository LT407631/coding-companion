const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync('nas/web/app.html','utf8');
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new vm.Script(m[1]));
const elements=new Map(),callbacks={},intervals=new Map(),posts=[],toasts=[];let intervalId=0; const timers=new Map();let timerId=0;
function element(id){
  if(!elements.has(id))elements.set(id,{style:{},setAttribute(k,v){this[k]=v},classList:{toggle(){},add(){},remove(){}},addEventListener(type,fn){(callbacks[id+type] ||= []).push(fn)},removeEventListener(){},getBoundingClientRect(){return {left:0,width:100}},setPointerCapture(){}});
  return elements.get(id);
}
const video=element('#video');Object.assign(video,{paused:true,currentTime:0,duration:0,playbackRate:1,src:'',pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},load(){},getAttribute(k){return this[k]},removeAttribute(k){this[k]=''}});
const W={sid:'2001',title:'test',eps:Array.from({length:8},(_,i)=>({index:i+1,vid:String(i+1001)})),ep:1,auto:true,speed:1,save(){}};
let current={state:'queued'};
const rows=Array.from({length:5},(_,i)=>({dataset:{ep:String(i+1)},classList:{toggle(){}},querySelector:selector=>element('#row'+i+selector)}));
const data=()=>({current,ready:1,queued:5,errors:0,episodes:{1:{state:'ready'},2:{state:'working'},3:{state:'queued'},4:{state:'error'},5:{state:'idle'}}});
const ctx={W,$:element,crypto:{randomUUID:()=> '12345678'},Date,Math,Blob,AbortController,setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout(id){timers.delete(id)},
  setInterval(fn){intervals.set(++intervalId,fn);return intervalId},clearInterval(id){intervals.delete(id)},
  document:{querySelectorAll:selector=>selector === '.ditem' ? rows : [],querySelector:()=>null,addEventListener(){},removeEventListener(){}},
  window:{addEventListener(){},removeEventListener(){}},navigator:{sendBeacon:(p,b)=>posts.push({path:p,beacon:true})},
  fetch:async(path,options)=>{posts.push({path,body:JSON.parse(options.body)});return{ok:true,json:async()=>data()}},api:async()=>data(),
  toast(message){toasts.push(message)},hist:{get:()=>null},fmtT:String,ICON_PLAY:'play',ICON_PAUSE:'pause',go(path){ctx.navigated=path}
};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('nas/web/assets/playback-status.js','utf8'),ctx);ctx.CodingPlaybackStatus=ctx.window.CodingPlaybackStatus;vm.runInContext(html.slice(html.indexOf('W.bind ='),html.indexOf('W.save =')),ctx);
const tick=()=>new Promise(r=>setImmediate(r));
const poll=async()=>{const pair=[...timers.entries()].find(([,t])=>t.ms===500||t.ms===2000);assert(pair,'active status timer must exist');timers.delete(pair[0]);await pair[1].fn();};
(async()=>{
  assert(html.includes('<video id="video" controls playsinline>'));
  assert(!html.includes('id="pbar"') && !html.includes('id="bplay"'), '原生控制栏不能叠加自定义播放控件');
  assert(!html.includes("stage.addEventListener('click'"), '不能重复处理浏览器原生播放点击');
  assert(/id="autoc"[\s\S]*?<button class="ghost" id="next-season" type="button" hidden>下一季<\/button>/.test(html), '下一季按钮必须紧跟自动连播且默认隐藏');
  assert(html.includes("bindNextSeasonButton(sid, $('#next-season'), next =>"), '播放页必须按当前剧集绑定下一季');
  W.bind();W.load(1,true);await tick();
  assert.equal(video.src,'','没有准备好时不能把长下载直接交给 video 请求');
  assert.equal(posts[0].path,'/playback/prepare');
  current={state:'ready'};await poll();
  assert.equal(video.src,'/stream?series_id=2001&ep=1');
  assert.deepEqual(rows.map(row=>row.querySelector('.dt').textContent),['已缓存','准备中','排队中','准备失败','未缓存']);
  assert.equal(rows[0].title,'第1集 · 已缓存');
  assert(html.includes('第${e.index}集</span><span class="dt">未缓存'));
  assert(!html.includes('<span class="dt">${esc(e.title'));
  video.currentTime=100;video.duration=100;
  await Promise.all(callbacks['#videoended'].map(fn=>fn()));await tick();
  assert(posts.some(p=>p.path==='/playback/complete' && p.body.ep===1), '自然播完必须发送动态清理通知');
  assert.equal(W.ep,2);assert.equal(W.completed,1);assert.equal(posts.at(-1).body.completed,1);
  assert.equal(element('#watch-series').textContent,'test','顶部显示正在播放的剧名');
  assert.equal(element('#watch-position').textContent,'第 2 集 / 共 8 集','自动连播同步顶部集数');
  assert.equal(toasts.length,0,'正常跳到下一集不弹出提示');
  video.playbackRate=1.5;callbacks['#videoratechange'][0]();assert.equal(W.speed,1.5);
  W.toggleAuto();const lastEp=W.ep;await Promise.all(callbacks['#videoended'].map(fn=>fn()));await tick();assert.equal(W.ep,lastEp,'关闭自动连播后不能跳集');
  W.toggleAuto();
  const completedPosts=posts.filter(p=>p.path==='/playback/complete').length;
  W.load(4);await tick();assert.equal(W.completed,0,'手动跳集不能算连续观看');
  assert.equal(posts.filter(p=>p.path==='/playback/complete').length,completedPosts,'手动切集不发送清理通知');
  current={state:'error',message:'failed after retries'};await poll();
  assert.equal(element('#vtip').textContent,'failed after retries');assert.equal(element('#vload .spin').style.display,'none');assert.equal(element('#vretry').style.display,'');
  W.load(4,false,true);await tick();assert.equal(posts.at(-1).body.retry,true);
  current={state:'ready'};await poll();
  video.play=()=>Promise.reject(Error('autoplay blocked'));
  callbacks['#videoloadedmetadata'][0]();await tick();
  assert.equal(element('#vstart').style.display,'');assert.equal(element('#vload .spin').style.display,'none','自动播放被拦截不能继续显示加载动画');
  const realStop=W.stop;let finishedStop=false;W.stop=finished=>{finishedStop=finished};W.nextSeason={series_id:'3001'};
  W.auto=false;W.load(8);await tick();ctx.navigated='';await Promise.all(callbacks['#videoended'].map(fn=>fn()));await tick();
  assert.equal(ctx.navigated,'','关闭自动连播时不能跨季');assert.equal(finishedStop,true);
  W.auto=true;W.load(8);await tick();finishedStop=false;await Promise.all(callbacks['#videoended'].map(fn=>fn()));await tick();
  assert.equal(ctx.navigated,'#/watch/3001/1/0','开启自动连播时本季结束必须进入下一季第1集');assert.equal(finishedStop,true);
  W.stop=realStop;
  const old=intervals.size;assert.equal([...timers.values()][0].ms,2000,'ready returns to ordinary status cadence');W.stop();assert(old===1&&intervals.size===0);assert.equal(timers.size,0,'status timer stopped');assert(posts.at(-1).beacon);
  W.load(3);assert.equal(ctx.navigated,'#/watch/2001/3','看完清理后仍能重新播放');
  console.log('PASS: preparation before media request; cache-ready playback; natural completion counting; manual seek resets intent; explicit retry; failure spinner stops; route cleanup; replay after completion; script syntax.');
})().catch(e=>{console.error(e);process.exitCode=1});
