// Run the maintained NativePlayer with small JVM Android doubles; no device/APK writes.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const dir=path.join(__dirname,'build/native-transition-check'),java='/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin';
const sources={
'net/codingcompanion/tv/TclHardwarePlayer.java':`package net.codingcompanion.tv; import java.util.*;public class TclHardwarePlayer extends android.media.MediaPlayer {TclMediaSource.Input input;void ticket(String value){if(input!=null)input.ticket(value);}void source(String url,Map<String,String> h,TclMediaSource.Report r)throws java.io.IOException{input=new TclMediaSource.Input(url,h.get("Cookie"),h.get("X-Coding-Media"),r);setDataSource(new android.app.Activity(),android.net.Uri.parse(input.address()),Collections.<String,String>emptyMap());}public void release(){if(input!=null)input.close();super.release();}}`,
'android/app/Activity.java':`package android.app; public class Activity {public static final int MODE_PRIVATE=0; public final android.content.SharedPreferences prefs=new android.content.SharedPreferences();public android.content.SharedPreferences getSharedPreferences(String n,int mode){return prefs;}}`,
'android/content/SharedPreferences.java':`package android.content;import java.util.*;public class SharedPreferences {public final Map<String,String> values=new HashMap<>();public String getString(String k,String d){return values.getOrDefault(k,d);}public SharedPreferences edit(){return this;}public SharedPreferences putString(String k,String v){values.put(k,v);return this;}public void apply(){}}`,
'android/graphics/Color.java':`package android.graphics;public class Color {public static final int BLACK=0xff000000,TRANSPARENT=0;}`,
'android/graphics/Matrix.java':`package android.graphics; public class Matrix {public void setScale(float a,float b,float c,float d){}}`,
'android/graphics/SurfaceTexture.java':`package android.graphics; public class SurfaceTexture {}`,
'android/view/Surface.java':`package android.view; import android.graphics.SurfaceTexture; public class Surface {public Surface(SurfaceTexture t){} public void release(){}}`,
'android/view/View.java':`package android.view; public class View {public static final int VISIBLE=0,INVISIBLE=4; public int visibility=INVISIBLE;public void setVisibility(int v){visibility=v;}public void setAlpha(float v){}}`,
'android/view/TextureView.java':`package android.view; import android.app.Activity;import android.graphics.*; public class TextureView extends View {
public static TextureView latest;Object layout;public TextureView(Activity a){latest=this;}public void setOpaque(boolean v){} public void setSurfaceTextureListener(SurfaceTextureListener s){}public Object getLayoutParams(){return layout;}public void setLayoutParams(Object p){layout=p;}public void setTransform(Matrix m){}
public interface SurfaceTextureListener {void onSurfaceTextureAvailable(SurfaceTexture t,int w,int h);void onSurfaceTextureSizeChanged(SurfaceTexture t,int w,int h);boolean onSurfaceTextureDestroyed(SurfaceTexture t);void onSurfaceTextureUpdated(SurfaceTexture t);}}`,
'android/widget/FrameLayout.java':`package android.widget;import android.view.TextureView; public class FrameLayout {public void addView(TextureView v,int i,LayoutParams p){v.setLayoutParams(p);}public static class LayoutParams {public int width,height,leftMargin,topMargin;public LayoutParams(int w,int h){width=w;height=h;}}}`,
'android/os/Build.java':`package android.os;public class Build {public static String MODEL="N3Pro",MANUFACTURER="Other";public static class VERSION {public static int SDK_INT=35;}}`,
'android/os/SystemClock.java':`package android.os;public class SystemClock {public static long elapsedRealtime(){return Handler.now;}}`,
'android/os/Handler.java':`package android.os;import java.util.*;public class Handler {
public static long now;static class Task {Runnable r;long due;Task(Runnable r,long d){this.r=r;due=d;}}static List<Task> tasks=new ArrayList<>();
public void post(Runnable r){postDelayed(r,0);}public void postDelayed(Runnable r,long delay){tasks.add(new Task(r,now+delay));}public void removeCallbacks(Runnable r){tasks.removeIf(t->t.r==r);}public static void next(){Task t=tasks.stream().min(Comparator.comparingLong(x->x.due)).get();tasks.remove(t);now=t.due;t.r.run();}public static int count(){return tasks.size();}public static long nextDelay(){return tasks.stream().mapToLong(t->t.due-now).min().orElse(-1);}}`,
'android/net/Uri.java':`package android.net;import java.net.URI;public class Uri {
URI u;Uri(String s){u=URI.create(s);}public static Uri parse(String s){return new Uri(s);}public String getScheme(){return u.getScheme();}public String getHost(){return u.getHost();}public int getPort(){return u.getPort();}public String getUserInfo(){return u.getUserInfo();}public String getFragment(){return u.getFragment();}public String getPath(){return u.getPath();}public String getQueryParameter(String n){if(u.getQuery()==null)return null;for(String v:u.getQuery().split("&")){String[] p=v.split("=",2);if(p[0].equals(n))return p[1];}return null;}public String toString(){return u.toString();}public Builder buildUpon(){return new Builder(u);}public static class Builder {URI u;String p,q="";Builder(URI u){this.u=u;}public Builder path(String p){this.p=p;return this;}public Builder appendQueryParameter(String k,String v){q+=(q.isEmpty()?"":"&")+k+"="+v;return this;}public Uri build(){return Uri.parse(u.getScheme()+"://"+u.getAuthority()+p+"?"+q);}}}`,
'android/webkit/CookieManager.java':`package android.webkit;public class CookieManager {public static CookieManager getInstance(){return new CookieManager();}public String getCookie(String s){return "test-session";}}`,
'android/webkit/WebView.java':`package android.webkit;import java.util.*;import org.json.*;public class WebView {
public int background;public void setBackgroundColor(int value){background=value;}public String url="http://192.0.2.1:8010/ui";public JSONObject state;public List<String> reports=new ArrayList<>();public String getUrl(){return url;}public int getWidth(){return 1920;}public int getHeight(){return 1080;}public interface Callback {void accept(String value);}public void evaluateJavascript(String js,Callback cb){if(js.contains("snapshot()")){JSONTokener.value=state;if(cb!=null)cb.accept("state");}else{reports.add(js);if(cb!=null)cb.accept("null");}}}`,
 'net/codingcompanion/tv/TvPlaybackDiagnostics.java':`package net.codingcompanion.tv;import android.app.Activity;import android.webkit.WebView;import org.json.JSONObject;class TvPlaybackDiagnostics{TvPlaybackDiagnostics(Activity a,WebView w,String s){}void setSite(String s){}void install(){}void close(){}void source(String s){}void probe(String s){}void transport(String u,String n){}void record(String e,String n){}void resetFrames(boolean b){}void frame(){}void systemProgress(android.media.MediaPlayer p,long pos,boolean playing,float rate){}void systemError(android.media.MediaPlayer p,int w,int e){}void browser(JSONObject s){}String tag(String s,String route){return TvCompatibility.applies(android.os.Build.MODEL)?s+"&tv_diag_route="+route:s;}}`,
'org/json/JSONObject.java':`package org.json;import java.util.*;public class JSONObject {Map<String,Object> values=new HashMap<>();public boolean has(String k){return values.containsKey(k);}public JSONObject put(String k,Object v){values.put(k,v);return this;}public String optString(String k){return values.containsKey(k)?String.valueOf(values.get(k)):"";}public boolean optBoolean(String k){return Boolean.TRUE.equals(values.get(k));}public double optDouble(String k){return optDouble(k,0);}public double optDouble(String k,double d){return values.containsKey(k)?((Number)values.get(k)).doubleValue():d;}public int getInt(String k){return ((Number)values.get(k)).intValue();}public double getDouble(String k){return ((Number)values.get(k)).doubleValue();}public JSONObject getJSONObject(String k){return (JSONObject)values.get(k);}public JSONObject optJSONObject(String k){return (JSONObject)values.get(k);}public JSONArray optJSONArray(String k){return (JSONArray)values.get(k);}public static String quote(String s){return "\\\""+s+"\\\"";}public String toString(){return values.toString();}}`,
'org/json/JSONArray.java':`package org.json;import java.util.*;public class JSONArray {List<JSONObject> values=new ArrayList<>();public JSONArray put(JSONObject o){values.add(o);return this;}public int length(){return values.size();}public JSONObject getJSONObject(int n){return values.get(n);}}`,
'org/json/JSONTokener.java':`package org.json;public class JSONTokener {public static Object value;public JSONTokener(String s){}public Object nextValue(){return value;}}`,
'android/media/MediaDataSource.java':`package android.media;public abstract class MediaDataSource implements java.io.Closeable {public abstract long getSize() throws java.io.IOException;public abstract int readAt(long p,byte[] b,int o,int s)throws java.io.IOException;}`,
'android/media/MediaPlayer.java':`package android.media;import android.app.Activity;import android.net.Uri;import android.view.Surface;import java.util.*;public class MediaPlayer {
public static final int MEDIA_INFO_VIDEO_RENDERING_START=3;public static List<MediaPlayer> all=new ArrayList<>();public boolean released,started;public int position;public String url;public Map<String,String> headers;public MediaPlayer(){all.add(this);}public interface Prepared {void call(MediaPlayer m);}public interface Size {void call(MediaPlayer m,int w,int h);}public interface Error {boolean call(MediaPlayer m,int w,int e);}public interface Info {boolean call(MediaPlayer m,int w,int e);}public Prepared prepared,complete,seek;public Info info;public Error error;
public void setSurface(Surface s){}public void setOnVideoSizeChangedListener(Size s){}public void setOnPreparedListener(Prepared s){prepared=s;}public void setOnCompletionListener(Prepared s){complete=s;}public void setOnSeekCompleteListener(Prepared s){seek=s;}public void setOnErrorListener(Error s){error=s;}public void setOnInfoListener(Info s){info=s;}public void setDataSource(Activity a,Uri u,Map<String,String> h)throws java.io.IOException{headers=h;url=u.toString();}public void setDataSource(MediaDataSource d)throws java.io.IOException{try{java.lang.reflect.Field f=d.getClass().getDeclaredField("url");f.setAccessible(true);url=f.get(d).toString();}catch(Exception e){throw new java.io.IOException(e);}}public void reset(){}public void prepareAsync(){}public int getVideoWidth(){return 1920;}public int getVideoHeight(){return 1080;}public int getDuration(){return 120000;}public int getCurrentPosition(){return position;}public void start(){started=true;}public void pause(){started=false;}public void seekTo(int n){position=n;}public void release(){released=true;}public Params getPlaybackParams(){return new Params();}public void setPlaybackParams(Params p){}public static class Params {public Params setSpeed(float v){return this;}}}`,
'net/codingcompanion/tv/NativeTransitionCheck.java':`package net.codingcompanion.tv;
import android.app.*;import android.webkit.*;import android.widget.*;import android.os.*;import android.media.*;import android.view.*;import android.graphics.*;import org.json.*;
class NativeTransitionCheck {
static void require(boolean v,String m){if(!v)throw new AssertionError(m);}
static JSONObject state(int id,String src,JSONArray commands){return new JSONObject().put("id",id).put("src",src).put("commands",commands).put("viewport",1920).put("rect",new JSONObject().put("x",0).put("y",0).put("w",1920).put("h",1080));}
static boolean playing(WebView w){return w.reports.stream().anyMatch(s->s.contains("playing"));}
public static void main(String[] args){
WebView web=new WebView();NativePlayer player=new NativePlayer(new Activity(),new FrameLayout(),web,"http://192.0.2.1:8010");SurfaceTexture texture=new SurfaceTexture();player.onSurfaceTextureAvailable(texture,1920,1080);
web.state=state(1,"/stream?series_id=123&ep=1",new JSONArray());player.resume();Handler.next();
MediaPlayer first=MediaPlayer.all.get(0);require(Handler.nextDelay()==250,"normal polling stays bounded");
first.prepared.call(first);require(Handler.nextDelay()==0,"metadata wakes playback immediately after JS listeners");
web.state=state(1,"/stream?series_id=123&ep=1",new JSONArray().put(new JSONObject().put("op","play")));Handler.next();
require(first.started,"play command delivered");require(playing(web),"successful start must end loading without OEM Info or texture callbacks");
require("test-session".equals(first.headers.get("Cookie")),"authenticated stream preserved");
web.state=state(2,"",new JSONArray());player.wake();require(Handler.nextDelay()==0,"source wake skips polling wait");Handler.next();
require(first.released,"old decoder released");require(TextureView.latest.visibility==View.VISIBLE,"transition preserves the video layer/surface");
web.state=state(3,"/stream?series_id=123&ep=2",new JSONArray());player.wake();player.wake();require(Handler.count()==1,"wake requests coalesce");Handler.next();
require(MediaPlayer.all.size()==2,"only one new decoder, no parallel preload");MediaPlayer second=MediaPlayer.all.get(1);
web.reports.clear();first.complete.call(first);require(web.reports.isEmpty(),"stale completion ignored");
web.state=state(3,"/stream?series_id=123&ep=2",new JSONArray());second.prepared.call(second);Handler.next();
web.state=state(3,"/stream?series_id=123&ep=2",new JSONArray().put(new JSONObject().put("op","seek").put("value",43)).put(new JSONObject().put("op","play")));player.wake();Handler.next();
require(second.started&&second.position==43000,"history resume seeks and starts the decoder");
require(playing(web),"history start must end loading without rendering callbacks");
web.reports.clear();player.onSurfaceTextureUpdated(texture);require(!playing(web),"following frames must not flood playing events");
web.state=state(4,"/stream?series_id=456&ep=1",new JSONArray());player.wake();Handler.next();
MediaPlayer third=MediaPlayer.all.get(2);web.reports.clear();player.onSurfaceTextureUpdated(texture);require(!playing(web),"retained old picture must not complete new preparation");
third.prepared.call(third);Handler.next();web.state=state(4,"/stream?series_id=456&ep=1",new JSONArray().put(new JSONObject().put("op","play")));player.wake();Handler.next();
web.reports.clear();if(first.info!=null)first.info.call(first,3,0);require(!playing(web),"old decoder Info must not dismiss the current loading state");
web.state=state(4,"/stream?series_id=456&ep=1",new JSONArray().put(new JSONObject().put("op","pause")));player.wake();Handler.next();web.reports.clear();
Handler.now+=21000;player.wake();Handler.next();require(!third.released,"user pause before first frame must not time out");player.onSurfaceTextureUpdated(texture);require(!playing(web),"paused frames must not change paused playback");
web.state=state(4,"/stream?series_id=456&ep=1",new JSONArray().put(new JSONObject().put("op","play")));player.wake();Handler.next();
require(playing(web),"new series start must confirm playback");web.reports.clear();player.onSurfaceTextureUpdated(new SurfaceTexture());player.onSurfaceTextureUpdated(texture);require(!playing(web),"texture callbacks must not change playback state");
Handler.now+=21000;player.wake();Handler.next();require(!third.released,"started playback must not time out merely because firmware omits frame notifications");
web.state=state(5,"/stream?series_id=456&ep=2",new JSONArray());player.wake();Handler.next();MediaPlayer stalled=MediaPlayer.all.get(3);web.reports.clear();
require(!stalled.started,"preparation has not completed in this scenario");
Handler.now+=21000;player.wake();Handler.next();require(stalled.released,"stalled preparation must release its decoder");require(web.reports.stream().anyMatch(s->s.contains("switching")),"preparation still has a bounded timeout with automatic fallback");
web.state=state(6,"/stream?series_id=789&ep=1",new JSONArray());player.wake();Handler.next();require(MediaPlayer.all.size()==5,"new episode recovers after a stalled generation");
MediaPlayer recovered=MediaPlayer.all.get(4);recovered.prepared.call(recovered);Handler.next();web.state=state(6,"/stream?series_id=789&ep=1",new JSONArray().put(new JSONObject().put("op","play")));player.wake();Handler.next();
require(playing(web),"recovered episode confirms start without rendering callback");
// Cached next episode: prepare silently at the tail, then adopt without a second prepare.
recovered.position=118000;
web.state=state(6,"/stream?series_id=789&ep=1",new JSONArray()).put("next","/stream?series_id=789&ep=2");player.wake();Handler.next();
MediaPlayer standby=MediaPlayer.all.get(5);require(!standby.started&&!recovered.released,"tail preparation never cuts current picture or starts next audio");
require("test-session".equals(standby.headers.get("Cookie")),"standby uses existing site authentication");
standby.prepared.call(standby);web.reports.clear();recovered.complete.call(recovered);
require(Handler.nextDelay()==0,"natural end wakes page handoff immediately without URL navigation");
web.state=state(7,"/stream?series_id=789&ep=2",new JSONArray());Handler.next();
require(MediaPlayer.all.size()==6&&!standby.released&&recovered.released,"handoff adopts the existing prepared decoder");
require(web.reports.stream().anyMatch(s->s.contains("loadedmetadata")),"adopted player emits metadata immediately");
web.state=state(7,"/stream?series_id=789&ep=2",new JSONArray().put(new JSONObject().put("op","play")));Handler.next();
require(standby.started,"adopted episode auto starts via the maintained command path");
standby.position=118000;web.state=state(7,"/stream?series_id=789&ep=2",new JSONArray()).put("next","https://evil.example/stream?series_id=789&ep=3");player.wake();Handler.next();
require(MediaPlayer.all.size()==6,"foreign standby URL rejected");
web.state=state(7,"/stream?series_id=789&ep=2",new JSONArray()).put("next","/stream?series_id=111&ep=3");player.wake();Handler.next();
require(MediaPlayer.all.size()==6,"standby must be the adjacent episode in the same series");
web.state=state(7,"/stream?series_id=789&ep=2",new JSONArray()).put("next","/stream?series_id=789&ep=3");player.wake();Handler.next();
MediaPlayer badWarm=MediaPlayer.all.get(6);web.reports.clear();badWarm.error.call(badWarm,1,2);
require(!standby.released&&badWarm.released&&web.reports.isEmpty(),"standby failure is isolated from active picture and loading state");
player.wake();Handler.next();require(MediaPlayer.all.size()==7,"failed standby is not retried every 250ms");
standby.complete.call(standby);web.state=state(8,"/stream?series_id=789&ep=3",new JSONArray());Handler.next();
MediaPlayer fallback=MediaPlayer.all.get(7);require(!fallback.released,"failed prewarm falls back to ordinary preparation");fallback.prepared.call(fallback);Handler.next();
web.state=state(8,"/stream?series_id=789&ep=3",new JSONArray().put(new JSONObject().put("op","play")));player.wake();Handler.next();
fallback.position=118000;web.state=state(8,"/stream?series_id=789&ep=3",new JSONArray()).put("next","/stream?series_id=789&ep=4");player.wake();Handler.next();
MediaPlayer cancelled=MediaPlayer.all.get(8);cancelled.prepared.call(cancelled);
web.state=state(8,"/stream?series_id=789&ep=3",new JSONArray().put(new JSONObject().put("op","pause")));player.wake();Handler.next();
require(cancelled.released,"pause or removing auto hint promptly releases standby");
player.suspend();player.wake();require(Handler.count()==0,"background must not poll");
web.url="https://evil.example/ui";player.resume();Handler.next();require(fallback.released,"untrusted page releases decoder");require(TextureView.latest.visibility==View.INVISIBLE,"leaving trusted page hides picture");player.suspend();
NextMedia pending=new NextMedia(new Activity());java.util.Map<String,String> h=new java.util.HashMap<>();String url="http://192.0.2.1:8010/stream?series_id=123&ep=2";
pending.update(url,90,h);MediaPlayer timed=MediaPlayer.all.get(MediaPlayer.all.size()-1);Handler.now+=3001;pending.expire();require(timed.released,"standby preparation timeout is bounded");
int count=MediaPlayer.all.size();pending.update(url,90,h);require(MediaPlayer.all.size()==count,"timed out standby is blocked for its source generation");
pending.update(url,91,h);MediaPlayer warm=MediaPlayer.all.get(MediaPlayer.all.size()-1);warm.prepared.call(warm);require(pending.take(url,90)==null,"stale generation cannot adopt warm player");
Handler.now+=5001;require(pending.take(url,91)==null&&warm.released,"unused prepared standby expires instead of holding another decoder forever");
pending.update(url,92,h);MediaPlayer late=MediaPlayer.all.get(MediaPlayer.all.size()-1);pending.clear();late.prepared.call(late);require(late.released&&pending.take(url,92)==null,"late preparation cannot resurrect a cancelled standby");
// TCL fallback, persistence and manual selection remain isolated from the default system route.
Build.MODEL="TCL_MT5879_CN";Activity television=new Activity();WebView tweb=new WebView();NativePlayer tcl=new NativePlayer(television,new FrameLayout(),tweb,"http://192.0.2.1:8010");tcl.onSurfaceTextureAvailable(new SurfaceTexture(),1920,1080);
tweb.state=state(100,"/stream?series_id=123&ep=1",new JSONArray());tcl.resume();Handler.next();MediaPlayer broken=MediaPlayer.all.get(MediaPlayer.all.size()-1);
require(broken.url.startsWith("http://127.0.0.1:"),"TCL native requests the isolated compatible stream");broken.prepared.call(broken);Handler.next();tweb.state=state(100,"/stream?series_id=123&ep=1",new JSONArray().put(new JSONObject().put("op","seek").put("value",43)).put(new JSONObject().put("op","play")));tcl.wake();Handler.next();broken.error.call(broken,1,23);
require(tweb.reports.stream().anyMatch(v->v.contains("useBrowser(100")&&v.contains("tv_profile=tcl-hevc&tv_diag_route=browser")),"TCL browser fallback retains compatible profile");require(tweb.background==Color.BLACK,"browser draws on an opaque WebView, never through the system texture");require(broken.released&&tweb.reports.stream().anyMatch(v->v.contains("useBrowser(100")),"1/23 releases system before using browser");
require(tweb.reports.stream().anyMatch(v->v.contains("43.0")),"fallback retains actual current position");
tweb.state=state(100,"/stream?series_id=123&ep=1",new JSONArray()).put("browser",true).put("browserReady",true).put("browserPlaying",true).put("pictureOutput",true).put("pos",9.0);tcl.wake();Handler.next();
Handler.now+=2500;tweb.state.put("pos",11.5);tcl.wake();Handler.next();require(PlaybackFallback.BROWSER.equals(television.prefs.getString("successful","")),"only picture and sustained progress remember browser");
int systems=MediaPlayer.all.size();tweb.state=state(101,"/stream?series_id=123&ep=2",new JSONArray());tcl.wake();Handler.next();require(MediaPlayer.all.size()==systems&&tweb.reports.stream().anyMatch(v->v.contains("useBrowser(101")),"next episode uses proven browser without creating native decoder");
tweb.reports.clear();broken.error.call(broken,1,23);require(tweb.reports.isEmpty(),"stale system callback ignored after browser fallback");
tweb.state=state(101,"/stream?series_id=123&ep=2",new JSONArray()).put("browser",true).put("browserError",true).put("pos",7.0);tcl.wake();Handler.next();MediaPlayer recovery=MediaPlayer.all.get(MediaPlayer.all.size()-1);require(MediaPlayer.all.size()==systems+1,"remembered browser error can try system once");
recovery.error.call(recovery,1,23);require(tweb.reports.stream().anyMatch(v->v.contains("error")),"both routes exhausted ends attempt");
tweb.state=new JSONObject().put("decoderMode",PlaybackFallback.SYSTEM);tcl.wake();Handler.next();require(PlaybackFallback.SYSTEM.equals(television.prefs.getString("mode","")),"settings saves without video");
tweb.state=state(102,"/stream?series_id=123&ep=3",new JSONArray()).put("decoderMode",PlaybackFallback.SYSTEM);tcl.wake();Handler.next();MediaPlayer manual=MediaPlayer.all.get(MediaPlayer.all.size()-1);tweb.reports.clear();manual.error.call(manual,1,23);require(manual.released&&tweb.reports.stream().noneMatch(v->v.contains("useBrowser")),"manual system never switches");
tweb.state=new JSONObject().put("decoderMode",PlaybackFallback.BROWSER);tcl.wake();Handler.next();tweb.state=state(103,"/stream?series_id=123&ep=4",new JSONArray()).put("decoderMode",PlaybackFallback.BROWSER);tcl.wake();Handler.next();
tweb.state.put("browser",true).put("browserReady",true).put("browserPlaying",true).put("pos",3.0);tcl.wake();Handler.next();tweb.reports.clear();tcl.suspend();require(tweb.reports.stream().anyMatch(v->v.contains("pause")),"background pauses browser");tcl.resume();Handler.next();require(tweb.reports.stream().anyMatch(v->v.contains("play")),"foreground resumes formerly playing browser");
tweb.state.put("pictureOutput",false).put("pictureMeasured",true).put("pos",10.0);Handler.now+=16000;tcl.wake();Handler.next();require(tweb.reports.stream().anyMatch(v->v.contains("error")),"audio/time without presented frames must time out instead of being remembered forever");require("".equals(television.prefs.getString("successful","")),"failed remembered browser route is discarded");
tcl.destroy();require(tweb.background==Color.TRANSPARENT,"exit restores transparent system view");require(Handler.count()==0&&tweb.reports.stream().anyMatch(v->v.contains("stop")),"exit unloads browser and stops polling");
Build.MODEL="MiTV-ASTP0";Build.VERSION.SDK_INT=28;Activity ra=new Activity();WebView rw=new WebView();NativePlayer redmi=new NativePlayer(ra,new FrameLayout(),rw,"http://192.0.2.1:8010");redmi.onSurfaceTextureAvailable(new SurfaceTexture(),1920,1080);
rw.state=state(201,"/stream?series_id=123&ep=2",new JSONArray()).put("decoderMode",PlaybackFallback.SYSTEM);int beforeTicket=MediaPlayer.all.size();redmi.resume();Handler.next();require(MediaPlayer.all.size()==beforeTicket,"Redmi must wait for exact-episode authorization before opening codec");
rw.state.put("mediaTicket","fixture.signature");redmi.wake();Handler.next();MediaPlayer named=MediaPlayer.all.get(MediaPlayer.all.size()-1);require(named instanceof TclHardwarePlayer&&named.url.startsWith("http://127.0.0.1:"),"actual NativePlayer chooses named engine for exact Redmi");named.prepared.call(named);rw.state=state(201,"/stream?series_id=123&ep=2",new JSONArray().put(new JSONObject().put("op","play"))).put("decoderMode",PlaybackFallback.SYSTEM).put("mediaTicket","fixture.signature");Handler.next();require(named.started,"authorized Redmi starts through existing bridge");redmi.destroy();require(named.released&&Handler.count()==0,"Redmi exit releases named engine and polling");

Activity migrated=new Activity();migrated.prefs.putString("mode","vlc-software").putString("successful","vlc-compatible");new NativePlayer(migrated,new FrameLayout(),new WebView(),"http://192.0.2.1:8010");require("auto".equals(migrated.prefs.getString("mode",""))&&"".equals(migrated.prefs.getString("successful","x")),"obsolete VLC choices safely reset for upgrade");
System.out.println("PASS: lightweight system/browser fallback, actual position, picture evidence, local preference, manual route, upgrade migration and lifecycle.");
System.out.println("PASS: real NativePlayer with JVM doubles: history seek/start, start confirmation without OEM render callbacks, old decoder/texture isolation, paused-frame suppression, preparation timeout, next-series recovery, immediate wake, retained surface, authenticated headers and background cleanup.");
System.out.println("PASS: actual NativePlayer/NextMedia cached-tail preparation, silent prewarm, natural-end decoder adoption, immediate completion wake, authentication/origin/adjacent-episode checks, warm failure isolation, fallback, pause cancellation, bounded timeout/expiry and stale callbacks. Firmware decode duration remains unmeasured.");
}}`
};
fs.mkdirSync(dir,{recursive:true});const files=[];
for(const [name,content] of Object.entries(sources)){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);files.push(file);}
for(const [exe,args] of [['javac',['--release','8','-encoding','UTF-8','-d',dir,...files,path.join(__dirname,'src/net/codingcompanion/tv/NativePlayer.java'),path.join(__dirname,'src/net/codingcompanion/tv/NextMedia.java'),path.join(__dirname,'src/net/codingcompanion/tv/PlaybackFallback.java'),path.join(__dirname,'src/net/codingcompanion/tv/TvCompatibility.java'),path.join(__dirname,'src/net/codingcompanion/tv/TclMediaSource.java'),path.join(__dirname,'src/net/codingcompanion/tv/RedmiPlayback.java')]],['java',['-cp',dir,'net.codingcompanion.tv.NativeTransitionCheck']]]) {
 const result=cp.spawnSync(path.join(java,exe),args,{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.stdout.write(result.stdout);process.exit(result.status||1);}if(exe==='java')process.stdout.write(result.stdout);
}
// Exercise the maintained web playback binding with the TV bridge, not a copy of its handlers.
(async()=>{
 const assert=require('node:assert/strict'),vm=require('node:vm'),html=fs.readFileSync(path.join(__dirname,'../nas/web/app.html'),'utf8');
 const nodes=new Map(),events=[],requests=[],timers=[],navigations=[],lifecycle=new EventTarget();let record={ep:43,pos:43,finished:false};
 const location={hash:'#/watch/123/43'};
 Object.defineProperty(location,'href',{set(url){navigations.push(url);lifecycle.dispatchEvent(new Event('beforeunload'));}});
 function flushWake(){while(timers.length)timers.shift()();}
 async function settle(){for(let i=0;i<20;i++)await Promise.resolve();flushWake();}
 function node(){return {style:{},classList:{toggle(){}},setAttribute(){},scrollIntoView(){},textContent:''};}
 const video=new EventTarget();Object.assign(video,{isConnected:true,controls:true,load(){},play(){return Promise.resolve();},pause(){},getAttribute:()=>null,removeAttribute(){},getBoundingClientRect:()=>({left:0,top:0,width:1920,height:1080})});
 for(const name of ['#video','#vload','#vload .spin','#vtip','#vretry','#vstart','#watch-toggle','#autoc','#wtitle','#watch-series','#watch-position','#watch-episode','#cache-progress'])nodes.set(name,name==='#video'?video:node());
 const ctx={console,Event,Blob,location,innerWidth:1920,crypto:{randomUUID:()=> 'test'},AbortController,
 setTimeout:(fn,ms)=>{if(ms===0)timers.push(fn);return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){},addEventListener:lifecycle.addEventListener.bind(lifecycle),removeEventListener:lifecycle.removeEventListener.bind(lifecycle),navigator:{sendBeacon:path=>requests.push({path,beacon:true})},
 document:{querySelector:s=>nodes.get(s)||null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}},$:s=>nodes.get(s),hist:{get:()=>record,put:x=>record=x},toast:m=>events.push(m),go(){},
 fetch:async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({current:{state:'ready'},ready:81,queued:0,episodes:{}})};},DeviceMedia:{mode:()=> 'nas'},W:{sid:'123',ep:43,eps:Array(81).fill({}),speed:1,auto:true,title:'Test',save(){}}};ctx.window=ctx;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'assets/tv-native.js'),'utf8'),ctx);ctx.CodingNative.installVideo(video);
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../nas/web/assets/playback-status.js'),'utf8'),ctx);
 vm.runInNewContext(html.slice(html.indexOf('W.bind = () =>'),html.indexOf('/* ================= 视图: 收藏')),ctx);
 ctx.W.bind();ctx.W.load(43,true);await settle();
 assert.equal(ctx.W.alive,true,'media setup must not trigger beforeunload and stop the active viewing session');
 assert.deepEqual(navigations,[],'native playback commands must not navigate the WebView');
 let state=ctx.CodingNative.snapshot();assert.equal(state.src,'/stream?series_id=123&ep=43');
 ctx.CodingNative.report(state.id,'loadedmetadata',{dur:180,pos:0});await settle();state=ctx.CodingNative.snapshot();
 assert.deepEqual(Array.from(state.commands,c=>c.op),['rate','seek','play']);assert.equal(state.commands[1].value,43);
 assert.equal(nodes.get('#vload').style.display,'flex','metadata alone does not claim a rendered frame');
 ctx.CodingNative.report(state.id,'seeked',{dur:180,pos:43});ctx.CodingNative.report(state.id,'playing',{dur:180,pos:43});
 assert.equal(nodes.get('#vload').style.display,'none','native start acknowledgement dismisses the production loading layer');
 const oldId=state.id;
 ctx.CodingNative.report(oldId,'ended',{dur:180,pos:180});ctx.CodingNative.report(oldId,'ended',{dur:180,pos:180});await settle();
 assert.equal(ctx.W.ep,44,'natural completion automatically selects the next episode without a remote key');
 assert.equal(requests.filter(r=>r.path==='/playback/complete').length,1,'duplicate completion is acknowledged only once');
 state=ctx.CodingNative.snapshot();assert.equal(state.src,'/stream?series_id=123&ep=44');
 ctx.CodingNative.report(oldId,'playing',{dur:180,pos:43});assert.equal(nodes.get('#vload').style.display,'flex','old episode cannot dismiss new loading');
 ctx.CodingNative.report(state.id,'loadedmetadata',{dur:180,pos:0});await settle();state=ctx.CodingNative.snapshot();assert.equal(state.commands.some(c=>c.op==='seek'),false,'new episode starts at zero');
 assert.equal(state.commands.some(c=>c.op==='play'),true,'the next episode starts automatically');
 ctx.CodingNative.report(state.id,'playing',{dur:180,pos:0});assert.equal(nodes.get('#vload').style.display,'none');assert.deepEqual(events,[]);
 assert.equal(requests.some(r=>r.path==='/playback/close'),false,'playing and changing episodes must retain the NAS session');
 lifecycle.dispatchEvent(new Event('pagehide'));assert.equal(ctx.W.alive,false);
 assert.equal(requests.filter(r=>r.path==='/playback/close').length,1,'actually leaving the page still closes its viewing session');
 console.log('PASS: production W.bind + TV JS bridge with navigation lifecycle: automatic history resume, loading dismissal, duplicate-safe natural next episode, no premature close, stale events and real exit cleanup.');
})().catch(e=>{console.error(e);process.exitCode=1});
