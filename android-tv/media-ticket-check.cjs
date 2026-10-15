const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
let clock=1000000,calls=[],timers=new Map(),timerId=0;
const v={isConnected:true,controls:true,load(){},play(){return Promise.resolve();},pause(){},getAttribute(){return null;},removeAttribute(){},dispatchEvent(){},getBoundingClientRect(){return {left:0,top:0,width:1280,height:720};}};
const document={querySelector(){return null;},querySelectorAll(){return [];}};Object.defineProperty(document,'cookie',{get(){throw Error('HttpOnly session must not be read');}});
const ctx={document,location:{hash:'#/watch/123/2',href:'http://site.test/ui',origin:'http://site.test'},innerWidth:1280,URL,AbortController,Event,
 Date:class extends Date{static now(){return clock;}},setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},
 fetch:async(path,options)=>{calls.push({path,options});return {ok:true,json:async()=>({token:'payload.signature',expires_at:2000000})};}};ctx.window=ctx;
vm.runInNewContext(fs.readFileSync(__dirname+'/assets/tv-native.js','utf8'),ctx);const tv=ctx.CodingNative;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 tv.installVideo(v);tv.decoderState('system','','',true);v.src='/stream?series_id=123&ep=2';v.load();
 assert.equal(tv.snapshot().mediaTicket,'');tv.snapshot();assert.equal(calls.length,1,'one pending request');await flush();
 assert.equal(tv.snapshot().mediaTicket,'payload.signature');assert.equal(calls[0].path,'/auth/media-ticket');assert.equal(calls[0].options.credentials,'same-origin');assert.deepEqual(JSON.parse(calls[0].options.body),{series_id:'123',ep:2});assert.equal(timers.size,0);
 tv.report(tv.snapshot().id,'loadedmetadata',{dur:120,pos:0});v.currentTime=12;clock+=600001;const pending=tv.snapshot();assert.equal(pending.mediaTicket,'','resume never exposes stale ticket while refreshing');assert.equal(pending.commands.length,0,'seek intent waits for refreshed authorization');assert.equal(calls.length,2,'long playback refresh');await flush();assert.equal(tv.snapshot().commands[0].value,12,'seek is retained across authorization refresh');
 let release;ctx.fetch=()=>new Promise(resolve=>{release=resolve;});v.src='/stream?series_id=123&ep=3';v.load();tv.snapshot();
 v.src='/stream?series_id=123&ep=4';v.load();release({ok:true,json:async()=>({token:'stale.signature'})});await flush();assert.equal(tv.snapshot().mediaTicket,'','old episode reply ignored');
 ctx.fetch=async()=>{throw Error('network');};v.src='/stream?series_id=123&ep=5';v.load();tv.snapshot();await flush();assert(!tv.snapshot().mediaTicketFailed);clock+=2500;tv.snapshot();await flush();assert(tv.snapshot().mediaTicketFailed,'bounded retry reports failure');
 const count=calls.length;v.src='https://foreign.test/stream?series_id=123&ep=2';v.load();assert(tv.snapshot().mediaTicketFailed);assert.equal(calls.length,count,'foreign request never issued');
 tv.decoderState('system','','',false);v.src='/stream?series_id=123&ep=6';v.load();assert.equal(tv.snapshot().mediaTicket,'','non-Xiaomi transport does not mint');
 const reports=[],diag={location:{hash:'#/watch/123/2',href:'http://site.test/ui',origin:'http://site.test'},navigator:{userAgent:'fixture'},URL,Date,addEventListener(){},CodingNative:{snapshot(){return {src:'/stream?series_id=123&ep=2'};}},fetch:async path=>{reports.push(JSON.parse(new URL(path,'http://site.test').searchParams.get('tv_diag')));return {};}};diag.window=diag;
 vm.runInNewContext(fs.readFileSync(__dirname+'/assets/tv-diagnostics.js','utf8'),diag);diag.CodingTVDiagnostics.enable({model:'N3Pro'});diag.CodingTVDiagnostics.record({event:'failure',note:'ignored'});assert.equal(reports.length,0);
 diag.CodingTVDiagnostics.enable({model:'MITV-ASTP0',sdk:28,app:'1.0.45',cookie:'never-export',mediaTicket:'never-export'});diag.CodingTVDiagnostics.record({event:'native-range',note:'status=206',mediaTicket:'never-export'});await flush();assert.equal(reports.length,1);assert.equal(reports[0].device.app,'1.0.45');assert(!JSON.stringify(reports).includes('never-export'));
 const native=fs.readFileSync(__dirname+'/src/net/codingcompanion/tv/NativePlayer.java','utf8');assert.match(native,/ticketTransport\(\).*PlaybackFallback.BROWSER/);assert.match(native,/headers.put\("X-Coding-Media",mediaTicket\)/);assert.match(native,/if\(!TclMediaSource.localTransport\(\)&&playing/);
 console.log('PASS: HttpOnly web login mints exact-episode ticket; pending/refresh/stale/bounded retries/foreign rejection and unchanged other-device route');
})().catch(e=>{console.error(e);process.exitCode=1;});
