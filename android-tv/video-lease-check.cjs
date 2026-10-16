// Exercise the maintained video-start lease and final cleanup, including cancelled waiters.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const s=fs.readFileSync(path.join(__dirname,'src/net/codingcompanion/tv/TclHardwarePlayer.java'),'utf8'),start=s.indexOf('    private void video(){');
const gate=s.slice(s.indexOf('            if(RedmiPlayback.applies()){',start),s.indexOf('            codec=HardwareVideoCodec.open',start));
const cleanup=s.match(/finally\{try\{if\(codec!=null\)codec.release\(\);\}finally\{try\{extractor.release\(\);\}finally\{if\(permit\)REDMI_VIDEO.release\(\);\}\}\}/)[0];
const out=path.join(__dirname,'build/video-lease-check');fs.mkdirSync(out,{recursive:true});
const java=`import java.util.concurrent.*;import java.util.concurrent.atomic.*;class VideoLeaseCheck {
 static final Semaphore REDMI_VIDEO=new Semaphore(1);static boolean vendor=true;static AtomicInteger alive=new AtomicInteger(),opened=new AtomicInteger();
 static class RedmiPlayback{static boolean applies(){return vendor;}}
 static class Codec{Codec(){opened.incrementAndGet();if(alive.incrementAndGet()>1&&vendor)throw new AssertionError("two vendor video decoders");}void release(){alive.decrementAndGet();}}
 static class Extractor{boolean released;void release(){released=true;}}
 static class Job extends Thread {volatile boolean closed;volatile Throwable error;CountDownLatch start=new CountDownLatch(1),end=new CountDownLatch(1);Extractor extractor=new Extractor();
  public void run(){Codec codec=null;boolean permit=false;try{${gate}codec=new Codec();start.countDown();end.await();}catch(Throwable e){error=e;}${cleanup}}
 }
 static void require(boolean b,String m){if(!b)throw new AssertionError(m);}
 public static void main(String[] a)throws Exception{
  Job current=new Job();current.start();require(current.start.await(1,TimeUnit.SECONDS),"current opens");Job next=new Job();next.start();Thread.sleep(120);require(opened.get()==1,"next waits for current codec release");current.end.countDown();current.join(1000);require(next.start.await(1,TimeUnit.SECONDS),"next opens after release");next.end.countDown();next.join(1000);require(alive.get()==0&&REDMI_VIDEO.availablePermits()==1,"normal cleanup");
  Job active=new Job();active.start();active.start.await();Job cancelled=new Job();cancelled.start();Thread.sleep(70);cancelled.closed=true;cancelled.join(1000);require(!cancelled.isAlive()&&cancelled.extractor.released,"cancelled standby releases extractor while waiting");require(REDMI_VIDEO.availablePermits()==0,"cancelled waiter never releases current permit");active.end.countDown();active.join(1000);require(REDMI_VIDEO.availablePermits()==1&&alive.get()==0,"no lease leak");
  vendor=false;Job x=new Job(),y=new Job();x.start();y.start();require(x.start.await(1,TimeUnit.SECONDS)&&y.start.await(1,TimeUnit.SECONDS),"other device start path unchanged");x.end.countDown();y.end.countDown();x.join();y.join();System.out.println("PASS: production video start/finally serializes Redmi hardware handoff, cancellation releases without permit leak; other-device path unchanged");
 }
}`;
const f=path.join(out,'VideoLeaseCheck.java');fs.writeFileSync(f,java);
for(const [bin,args]of [['javac',['--release','8','-d',out,f]],['java',['-cp',out,'VideoLeaseCheck']]]){const r=cp.spawnSync('/opt/homebrew/opt/openjdk@21/bin/'+bin,args,{encoding:'utf8',timeout:10000});process.stdout.write(r.stdout||'');if(r.status!==0)throw new Error(r.stderr||String(r.error));}
