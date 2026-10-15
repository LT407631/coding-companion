// Real HTTP clients emulate an OEM player that omits site cookies entirely.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const out=path.join(__dirname,'build/media-source-check'),java=(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME,'bin') : '');
const files={
'net/codingcompanion/tv/TclHardwarePlayer.java':`package net.codingcompanion.tv; import java.util.*;public class TclHardwarePlayer extends android.media.MediaPlayer {TclMediaSource.Input input;void source(String url,Map<String,String> h,TclMediaSource.Report r)throws java.io.IOException{input=new TclMediaSource.Input(url,h.get("Cookie"),r);setDataSource(new android.app.Activity(),android.net.Uri.parse(input.address()),Collections.<String,String>emptyMap());}public void release(){if(input!=null)input.close();super.release();}}`,
'android/app/Activity.java':'package android.app;public class Activity {}',
'android/os/Build.java':'package android.os;public class Build {public static String MODEL="N3Pro",MANUFACTURER="Other";public static class VERSION {public static int SDK_INT=30;}}',
'android/net/Uri.java':'package android.net;public class Uri {public final String url;private Uri(String u){url=u;}public static Uri parse(String u){return new Uri(u);}}',
'android/media/MediaPlayer.java':`package android.media;import android.app.Activity;import android.net.Uri;import java.util.Map;public class MediaPlayer {public String legacy;public Map<String,String> headers;public boolean released;public void setDataSource(Activity a,Uri u,Map<String,String> h)throws java.io.IOException{legacy=u.url;headers=h;}public void release(){released=true;}public void reset(){}}`,
'net/codingcompanion/tv/MediaSourceCheck.java':`package net.codingcompanion.tv;
import java.io.*;import java.net.*;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;import com.sun.net.httpserver.*;import android.media.*;import android.os.Build;
public class MediaSourceCheck {
static void require(boolean v,String m){if(!v)throw new AssertionError(m);}
static HttpURLConnection request(String url,String range)throws Exception{HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();c.setConnectTimeout(2000);c.setReadTimeout(3000);if(range!=null)c.setRequestProperty("Range",range);return c;}
static byte[] read(InputStream input)throws Exception{ByteArrayOutputStream b=new ByteArrayOutputStream();byte[] data=new byte[16384];int n;while((n=input.read(data))!=-1)b.write(data,0,n);return b.toByteArray();}
public static void main(String[] args)throws Exception{
byte[] media=new byte[2*1024*1024+37];new Random(17).nextBytes(media);AtomicInteger requests=new AtomicInteger(),foreign=new AtomicInteger();CountDownLatch finishStreaming=new CountDownLatch(1);
HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);ExecutorService workers=Executors.newCachedThreadPool();server.setExecutor(workers);
server.createContext("/foreign",e->{foreign.incrementAndGet();e.sendResponseHeaders(200,0);e.close();});
server.createContext("/stream",e->{try{
 requests.incrementAndGet();String mode=e.getRequestURI().getQuery();
 if(!"coding_session=test-session".equals(e.getRequestHeaders().getFirst("Cookie"))&&!"fixture.signature".equals(e.getRequestHeaders().getFirst("X-Coding-Media"))){e.sendResponseHeaders(401,-1);return;}
 if("redirect".equals(mode)){e.getResponseHeaders().set("Location","/foreign");e.sendResponseHeaders(302,-1);return;}
 String range=e.getRequestHeaders().getFirst("Range");int start=0,end=media.length-1;
 if(range!=null){String[] parts=range.substring(6).split("-",-1);start=Integer.parseInt(parts[0]);if(!parts[1].isEmpty())end=Math.min(end,Integer.parseInt(parts[1]));}
 if(start>=media.length){e.sendResponseHeaders(416,-1);return;}
 int status=range!=null&&!"whole".equals(mode)?206:200;
 e.getResponseHeaders().set("Content-Type","video/mp4");e.getResponseHeaders().set("Content-Length",String.valueOf(end-start+1));if(status==206)e.getResponseHeaders().set("Content-Range","bytes "+("wrong".equals(mode)?start+1:start)+"-"+end+"/"+media.length);
 if("HEAD".equals(e.getRequestMethod())){e.sendResponseHeaders(status,-1);return;}
 e.sendResponseHeaders(status,end-start+1);
 if("streaming".equals(mode)){e.getResponseBody().write(media,start,16384);e.getResponseBody().flush();finishStreaming.await(2,TimeUnit.SECONDS);e.getResponseBody().write(media,start+16384,end-start+1-16384);}
 else e.getResponseBody().write(media,start,end-start+1);
}catch(Exception ignored){}finally{e.close();}});server.start();
String base="http://127.0.0.1:"+server.getAddress().getPort()+"/stream";List<TclMediaSource.Input> sources=new ArrayList<>();
try{
 TclMediaSource.Input ticketSource=new TclMediaSource.Input(base,null,"fixture.signature",null);sources.add(ticketSource);HttpURLConnection ticketRead=request(ticketSource.address(),"bytes=0-7");require(ticketRead.getResponseCode()==206&&read(ticketRead.getInputStream()).length==8,"empty WebView/Java Cookie still authenticates via episode ticket");
 List<String> reports=Collections.synchronizedList(new ArrayList<>());TclMediaSource.Input source=new TclMediaSource.Input(base,"coding_session=test-session",reports::add);sources.add(source);
 require(new URL(source.address()).getHost().equals("127.0.0.1")&&new URL(source.address()).getPath().matches("/[a-f0-9]{32}/video[.]mp4"),"loopback-only random capability path");
 for(int[] interval:new int[][]{{0,7},{400000,404095},{media.length-19,media.length-1}}){HttpURLConnection c=request(source.address(),"bytes="+interval[0]+"-"+interval[1]);require(c.getResponseCode()==206,"cookie-free OEM range authenticated by app");require(Arrays.equals(read(c.getInputStream()),Arrays.copyOfRange(media,interval[0],interval[1]+1)),"exact seek/tail bytes");c.disconnect();}
 HttpURLConnection full=request(source.address(),null);require(full.getResponseCode()==200&&Arrays.equals(read(full.getInputStream()),media),"progressive stream without Range");full.disconnect();
 HttpURLConnection head=request(source.address(),"bytes=0-7");head.setRequestMethod("HEAD");require(head.getResponseCode()==206&&head.getContentLength()==8&&head.getInputStream().read()==-1,"HEAD carries no body");head.disconnect();
 int old=requests.get();HttpURLConnection badRange=request(source.address(),"bytes=0-1,5-8");require(badRange.getResponseCode()==416,"multi range rejected");badRange.disconnect();HttpURLConnection guess=request(source.address()+"wrong",null);require(guess.getResponseCode()==404&&requests.get()==old,"unknown local path cannot access NAS");guess.disconnect();
 for(String mode:new String[]{"redirect","whole","wrong"}){TclMediaSource.Input bad=new TclMediaSource.Input(base+"?"+mode,"coding_session=test-session",null);sources.add(bad);HttpURLConnection c=request(bad.address(),"bytes=0-7");require(c.getResponseCode()==502,mode+" rejected");c.disconnect();}
 require(foreign.get()==0,"session never follows redirect");TclMediaSource.Input denied=new TclMediaSource.Input(base,null,null);sources.add(denied);HttpURLConnection c=request(denied.address(),"bytes=0-7");c.setRequestProperty("Cookie","coding_session=test-session");require(c.getResponseCode()==401,"local caller cannot supply credential or bypass authentication");c.disconnect();
 TclMediaSource.Input live=new TclMediaSource.Input(base+"?streaming","coding_session=test-session",null);sources.add(live);HttpURLConnection flow=request(live.address(),null);long now=System.nanoTime();InputStream stream=flow.getInputStream();require(stream.read()!=-1&&(System.nanoTime()-now)<1000000000L,"first bytes arrive before whole-file completion");live.close();finishStreaming.countDown();flow.disconnect();
 java.lang.reflect.Field pool=TclMediaSource.Input.class.getDeclaredField("workers"),buffer=TclMediaSource.Input.class.getDeclaredField("BUFFER");pool.setAccessible(true);buffer.setAccessible(true);require(((ThreadPoolExecutor)pool.get(source)).getMaximumPoolSize()==2&&buffer.getInt(null)==16384,"bounded workers and 16 KiB streaming buffer");
 require(reports.size()<=3&&reports.stream().noneMatch(s->s.contains("test-session")||s.contains(new URLUnchecked(source.address()).path)),"bounded diagnostic contains no cookie or local capability");
 String closed=source.address();long at=System.nanoTime();source.close();require(System.nanoTime()-at<500000000L,"close never waits for stream completion");try{request(closed,null).getResponseCode();throw new AssertionError("closed listener accepted");}catch(IOException expected){}
 Map<String,String> headers=new HashMap<>();headers.put("Cookie","coding_session=test-session");Build.MODEL="N3Pro";MediaPlayer original=TclMediaSource.create();TclMediaSource.set(original,new android.app.Activity(),base,headers,null);require(base.equals(original.legacy)&&original.headers==headers,"N3Pro original URL and headers unchanged");
 Build.MANUFACTURER="Xiaomi";Build.MODEL="MiTV-TEST";MediaPlayer mi=TclMediaSource.create();TclMediaSource.set(mi,new android.app.Activity(),base,headers,null);require(mi.legacy.startsWith("http://127.0.0.1:"),"Xiaomi never relies on OEM cookie forwarding");HttpURLConnection miRead=request(mi.legacy,"bytes=0-7");require(miRead.getResponseCode()==206&&read(miRead.getInputStream()).length==8,"Xiaomi cookie-free OEM request reaches authenticated NAS");mi.release();Build.MANUFACTURER="Other";
 Build.MODEL="tcl_mt5879_cn";MediaPlayer tcl=TclMediaSource.create();TclMediaSource.set(tcl,new android.app.Activity(),base,headers,null);require(tcl.legacy.startsWith("http://127.0.0.1:")&&tcl.headers.isEmpty(),"TCL uses ordinary URL API without site Cookie in OEM stack");String local=tcl.legacy;tcl.release();try{request(local,null).getResponseCode();throw new AssertionError("release left transport open");}catch(IOException expected){}
 MediaPlayer reset=TclMediaSource.create();TclMediaSource.set(reset,new android.app.Activity(),base,headers,null);local=reset.legacy;reset.reset();try{request(local,null).getResponseCode();throw new AssertionError("reset left transport open");}catch(IOException expected){}reset.release();
 java.net.URLClassLoader oldApi=new java.net.URLClassLoader(new URL[]{MediaSourceCheck.class.getProtectionDomain().getCodeSource().getLocation()},null){protected Class<?> loadClass(String name,boolean resolve)throws ClassNotFoundException{if(name.equals("android.media.MediaDataSource"))throw new ClassNotFoundException("absent");return super.loadClass(name,resolve);}};
 try{Class<?> binding=oldApi.loadClass("net.codingcompanion.tv.TclMediaSource");java.lang.reflect.Method create=binding.getDeclaredMethod("create");create.setAccessible(true);require(create.invoke(null).getClass().getName().equals("android.media.MediaPlayer"),"legacy startup requires no MediaDataSource type");}finally{oldApi.close();}
 System.out.println("PASS: cookie-free OEM HTTP playback, exact Range/seek/tail/HEAD/progressive streaming, first bytes before completion, bounded 16 KiB/2 workers, private loopback path, no credential forwarding, 401/redirect/whole/wrong range rejection, close/release/reset, N3Pro original URL and legacy API startup.");
}finally{for(TclMediaSource.Input source:sources)source.close();server.stop(0);workers.shutdownNow();}
}
static class URLUnchecked {String path;URLUnchecked(String url){try{path=new URL(url).getPath();}catch(Exception ignored){}}}
}`};
fs.mkdirSync(out,{recursive:true});const inputs=[];
for(const [name,content] of Object.entries(files)){const file=path.join(out,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);inputs.push(file);}
for(const [bin,args] of [['javac',['--release','8','-encoding','UTF-8','-d',out,...inputs,path.join(__dirname,'src/net/codingcompanion/tv/TclMediaSource.java'),path.join(__dirname,'src/net/codingcompanion/tv/TvCompatibility.java')]],['java',['-cp',out,'net.codingcompanion.tv.MediaSourceCheck']]]){
 const r=cp.spawnSync(path.join(java,bin),args,{encoding:'utf8',timeout:40000});process.stdout.write(r.stdout||'');if(r.status!==0){process.stderr.write(r.stderr||'');throw r.error||new Error(bin+' failed');}
}
