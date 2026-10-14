package net.codingcompanion.tv;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Matrix;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.SystemClock;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.HashMap;
import java.util.Map;

/** Reads a bounded media state from our configured page; exposes no Java bridge. */
final class NativePlayer implements TextureView.SurfaceTextureListener {
    private final Activity activity;
    private final WebView web;
    private final TextureView picture;
    private final Handler handler=new Handler();
    private final NextMedia next;
    private MediaPlayer media;
    private boolean browser, resumeBrowser;
    private final SharedPreferences decoderPrefs;
    private PlaybackFallback fallback;
    private final TvPlaybackDiagnostics diagnostics;

    private long resumePosition, playbackStartedAt;
    private float speed=1;
    private boolean rendered;
    private String requestedMode=PlaybackFallback.AUTO;
    private Surface surface;
    private String site, source="";
    private int token=-1, videoW, videoH;
    private boolean running, prepared, playing, busy, failed, wakePending, completedNaturally;
    private long prepareDeadline;
    private final Runnable tick=new Runnable(){public void run(){poll();}};

    NativePlayer(Activity a, FrameLayout root, WebView w, String base) {
        activity=a;web=w;site=base;diagnostics=new TvPlaybackDiagnostics(a,w,base);next=new NextMedia(a);decoderPrefs=a.getSharedPreferences("tv-decoder",Activity.MODE_PRIVATE);requestedMode=decoderPrefs.getString("mode",PlaybackFallback.AUTO);if(!validSelection(requestedMode)){requestedMode=PlaybackFallback.AUTO;decoderPrefs.edit().putString("mode",requestedMode).apply();}if(!PlaybackFallback.valid(decoderPrefs.getString("successful","")))decoderPrefs.edit().putString("successful","").apply();
        picture=new TextureView(a);picture.setOpaque(false);picture.setSurfaceTextureListener(this);
        picture.setVisibility(View.INVISIBLE);root.addView(picture,0,new FrameLayout.LayoutParams(1,1));
    }
    void setSite(String base){stopMedia();site=base;diagnostics.setSite(base);}
    void installDiagnostics(){if(trustedPage())diagnostics.install();}
    void resume(){if(running)return;running=true;if(media!=null&&!prepared)prepareDeadline=SystemClock.elapsedRealtime()+20000;if(browser){prepareDeadline=SystemClock.elapsedRealtime()+20000;if(resumeBrowser)browserControl("play");resumeBrowser=false;}handler.post(tick);}
    private static boolean validSelection(String mode){return PlaybackFallback.valid(mode);}
    void wake(){
        if(!running||!trustedPage())return;
        handler.removeCallbacks(tick);
        if(busy){wakePending=true;return;}
        handler.post(tick);
    }
    void suspend(){diagnostics.resetFrames(false);running=false;prepareDeadline=0;next.clear();handler.removeCallbacks(tick);if(browser){resumeBrowser=playing;browserControl("pause");playing=false;}else if(prepared&&media!=null){try{media.pause();}catch(Exception ignored){} playing=false;}}
    void destroy(){diagnostics.close();suspend();stopMedia();if(surface!=null){surface.release();surface=null;}}
    private boolean trustedPage(){
        Uri page=Uri.parse(web.getUrl()==null?"":web.getUrl()),base=Uri.parse(site);
        return sameOrigin(page,base) && "/ui".equals(page.getPath());
    }
    private static boolean sameOrigin(Uri u,Uri b){
        int p=u.getPort()<0?("https".equals(u.getScheme())?443:80):u.getPort();
        int bp=b.getPort()<0?("https".equals(b.getScheme())?443:80):b.getPort();
        return b.getScheme().equals(u.getScheme())&&b.getHost().equalsIgnoreCase(u.getHost()==null?"":u.getHost())&&p==bp&&u.getUserInfo()==null;
    }
    private String mediaURL(String raw) throws Exception {
        Uri u=Uri.parse(raw);if(u.getScheme()==null) u=Uri.parse(site+raw);
        if(!sameOrigin(u,Uri.parse(site))||!"/stream".equals(u.getPath())||u.getFragment()!=null) throw new Exception("视频地址不属于当前网站");
        String sid=u.getQueryParameter("series_id"),ep=u.getQueryParameter("ep");
        if(sid==null||!sid.matches("[0-9]{1,24}")||ep==null||!ep.matches("[0-9]{1,6}")||Integer.parseInt(ep)<1) throw new Exception("视频编号无效");
        Uri.Builder address=Uri.parse(site).buildUpon().path("/stream").appendQueryParameter("series_id",sid).appendQueryParameter("ep",ep);
        if(TvCompatibility.applies(Build.MODEL))address.appendQueryParameter("tv_profile","tcl-hevc");
        return diagnostics.tag(address.build().toString(),fallback!=null&&PlaybackFallback.BROWSER.equals(fallback.mode())?"browser":"system");
    }
    private void poll(){
        if(!running)return;
        if(busy){handler.postDelayed(tick,250);return;}
        if(!trustedPage()){stopMedia();handler.postDelayed(tick,250);return;}
        next.expire();
        if((media!=null||browser)&&!prepared&&prepareDeadline>0&&SystemClock.elapsedRealtime()>=prepareDeadline)
            failure("本集视频准备超时，请重试本集或选择其他集");
        if(prepared&&playing&&media!=null&&fallback!=null&&fallback.confirm(positionMs(),rendered,SystemClock.elapsedRealtime()))
            decoderPrefs.edit().putString("successful",fallback.mode()).apply();
        busy=true;
        String remembered=decoderPrefs.getString("successful","");
        web.evaluateJavascript("window.CodingNative ? (CodingNative.decoderState("+JSONObject.quote(requestedMode)+","+JSONObject.quote(remembered)+","+JSONObject.quote(TvCompatibility.profile(Build.MODEL))+"),CodingNative.snapshot()) : null",result->{
            busy=false;
            if(!running)return;
            try{
                Object value=new JSONTokener(result).nextValue();
                if(!(value instanceof JSONObject)){stopMedia();return;}
                JSONObject data=(JSONObject)value;
                String selection=data.optString("decoderMode");
                if(validSelection(selection)&&!selection.equals(requestedMode)){
                    requestedMode=selection;decoderPrefs.edit().putString("mode",selection).apply();stopMedia();
                }
                if(!data.has("rect")){stopMedia();return;}
                position(data);
                String raw=data.optString("src");int id=data.getInt("id");
                if(raw.isEmpty()){stopMedia(false);return;}
                if(id!=token||!raw.equals(source)){
                    MediaPlayer standby=completedNaturally&&!browser?next.take(mediaURL(raw),token):null;
                    stopMedia(false);token=id;source=raw;fallback=new PlaybackFallback(requestedMode,decoderPrefs.getString("successful",""));if(surface!=null)open(raw,id,standby);else if(standby!=null)standby.release();
                }
                else if(media==null&&!browser&&!failed&&surface!=null&&source.length()>0)open(raw,id);
                JSONArray commands=data.optJSONArray("commands");
                if(browser){
                    if(!data.optBoolean("browser"))return;
                    diagnostics.browser(data.optJSONObject("browserDiagnostics"));
                    resumePosition=(long)(data.optDouble("pos")*1000);
                    prepared=data.optBoolean("browserReady");playing=data.optBoolean("browserPlaying");
                    if(playing&&playbackStartedAt==0)playbackStartedAt=SystemClock.elapsedRealtime();if(!playing)playbackStartedAt=0;
                    if(prepared)prepareDeadline=0;
                    if(data.optBoolean("browserSeeking")&&fallback!=null){fallback.resetEvidence();playbackStartedAt=playing?SystemClock.elapsedRealtime():0;}
                    if(playing&&playbackStartedAt>0&&SystemClock.elapsedRealtime()-playbackStartedAt>15000&&data.optBoolean("pictureMeasured")&&!data.optBoolean("pictureOutput")){failure("浏览器没有输出视频画面，请在设置中切换播放器");return;}
                    if(data.optBoolean("browserError")){failure("浏览器播放器未能载入本集");return;}
                    if(prepared&&playing&&fallback!=null&&fallback.confirm(resumePosition,data.optBoolean("pictureOutput"),SystemClock.elapsedRealtime()))
                        decoderPrefs.edit().putString("successful",fallback.mode()).apply();
                    return;
                }
                if(prepared&&media!=null&&commands!=null)for(int i=0;i<commands.length();i++)command(commands.getJSONObject(i));
                if(prepared&&media!=null){
                    diagnostics.systemProgress(media,positionMs(),playing,speed);
                    report("timeupdate",positionMs()/1000.0,durationMs()/1000.0,null);
                    String hint=data.optString("next"),url="";
                    long remaining=durationMs()-positionMs();
                    if(!TvCompatibility.applies(Build.MODEL)&&playing&&remaining>0&&remaining<=2000&&!hint.isEmpty()){
                        try{
                            String proposed=mediaURL(hint);Uri current=Uri.parse(mediaURL(source)),following=Uri.parse(proposed);
                            if(current.getQueryParameter("series_id").equals(following.getQueryParameter("series_id"))&&Integer.parseInt(following.getQueryParameter("ep"))==Integer.parseInt(current.getQueryParameter("ep"))+1)url=proposed;
                        }catch(Exception ignored){}
                    }
                    // At natural end retain the prepared next player while the page hands over.
                    if(!completedNaturally&&!browser&&fallback!=null&&PlaybackFallback.SYSTEM.equals(fallback.mode()))next.update(url,token,headers());
                }
            }catch(Exception e){failure("系统播放器无法读取本集");}
            finally{handler.removeCallbacks(tick);if(running)handler.postDelayed(tick,wakePending?0:250);wakePending=false;}
        });
    }
    private void open(String raw,int id){
        open(raw,id,null);
    }
    private void open(String raw,int id,MediaPlayer standby){
        if(fallback==null)fallback=new PlaybackFallback(requestedMode,decoderPrefs.getString("successful",""));
        if(!PlaybackFallback.SYSTEM.equals(fallback.mode())){
            if(standby!=null)standby.release();openBrowser(raw,id);return;
        }
        rendered=false;playbackStartedAt=0;diagnostics.resetFrames(true);
        try{
            final MediaPlayer p=standby==null?(TvCompatibility.applies(Build.MODEL)?TclMediaSource.createHardware():TclMediaSource.create()):standby;media=p;
            prepareDeadline=SystemClock.elapsedRealtime()+20000;
            p.setSurface(surface);
            p.setOnVideoSizeChangedListener((m,w,h)->{if(media==m){videoW=w;videoH=h;fit();}});
            p.setOnPreparedListener(m->{if(media!=m||token!=id)return;onPrepared(m);});
            p.setOnCompletionListener(m->{if(media==m){playing=false;completedNaturally=true;report("ended",m.getDuration()/1000.0,m.getDuration()/1000.0,null,true);}});
            p.setOnSeekCompleteListener(m->{if(media==m)report("seeked",m.getCurrentPosition()/1000.0,m.getDuration()/1000.0,null);});
            p.setOnErrorListener((m,what,extra)->{if(media==m){diagnostics.systemError(m,what,extra);failure("电视解码失败（"+what+" / "+extra+"）");}return true;});
            String url=mediaURL(raw);diagnostics.source(url);
            if(standby!=null)onPrepared(p);
            else {diagnostics.record("system-open","starting");TclMediaSource.set(p,activity,url,headers(),note->diagnostics.transport(url,note));p.prepareAsync();}
        }catch(Exception e){
            diagnostics.record("system-exception",e.getClass().getSimpleName());
            if(standby!=null){if(media!=null){media.release();media=null;}prepared=false;playing=false;open(raw,id);}
            else failure("系统播放器无法连接视频，请检查登录与网络");
        }
    }
    private Map<String,String> headers(){
        Map<String,String> headers=new HashMap<>();String cookie=CookieManager.getInstance().getCookie(site);
        if(cookie!=null)headers.put("Cookie",cookie);
        headers.put("android-allow-cross-domain-redirect","0");return headers;
    }
    private long positionMs(){try{return media!=null&&prepared?media.getCurrentPosition():resumePosition;}catch(Exception ignored){return resumePosition;}}
    private long durationMs(){try{return media!=null&&prepared?media.getDuration():0;}catch(Exception ignored){return 0;}}
    private void openBrowser(String raw,int id){
        next.clear();
        try{
            String url=mediaURL(raw);diagnostics.source(url);diagnostics.record("browser-open","starting");browser=true;picture.setAlpha(0f);web.setBackgroundColor(Color.BLACK);prepareDeadline=SystemClock.elapsedRealtime()+20000;
            web.evaluateJavascript("window.CodingNative && CodingNative.useBrowser("+id+","+JSONObject.quote(url)+","+(resumePosition/1000.0)+","+speed+")",result->wake());
        }catch(Exception e){failure("浏览器播放器暂不可用");}
    }
    private void browserControl(String op){
        if(token>=0&&trustedPage())web.evaluateJavascript("window.CodingNative && CodingNative.browserControl("+token+","+JSONObject.quote(op)+")",null);
    }
    private void onPrepared(MediaPlayer m){
        prepared=true;prepareDeadline=0;videoW=m.getVideoWidth();videoH=m.getVideoHeight();fit();
        diagnostics.record("system-prepared","width="+videoW+",height="+videoH+",durationMs="+m.getDuration());
        if(resumePosition>0)m.seekTo((int)Math.min(Math.max(0,m.getDuration()-250),resumePosition));
        report("loadedmetadata",resumePosition/1000.0,m.getDuration()/1000.0,null,true);
    }
    private void command(JSONObject c)throws Exception{
        // Match the working 1.0.6 start acknowledgement; OEM render callbacks are not a startup prerequisite.
        switch(c.optString("op")){
            case "play":media.start();playing=true;if(playbackStartedAt==0)playbackStartedAt=SystemClock.elapsedRealtime();report("playing",media.getCurrentPosition()/1000.0,media.getDuration()/1000.0,null);break;
            case "pause":media.pause();playing=false;playbackStartedAt=0;prepareDeadline=0;report("pause",media.getCurrentPosition()/1000.0,media.getDuration()/1000.0,null);break;
            case "seek":diagnostics.resetFrames(false);if(fallback!=null)fallback.resetEvidence();media.seekTo((int)Math.max(0,Math.min(media.getDuration()-250,c.optDouble("value")*1000)));break;
            case "rate":diagnostics.resetFrames(false);speed=(float)Math.max(.5,Math.min(2,c.optDouble("value",1)));if(Build.VERSION.SDK_INT>=23){boolean was=playing;media.setPlaybackParams(media.getPlaybackParams().setSpeed((float)Math.max(.5,Math.min(2,c.optDouble("value",1)))));if(!was)media.pause();}break;
            default:break;
        }
    }
    private void report(String event,double pos,double dur,String message){
        report(event,pos,dur,message,false);
    }
    private void report(String event,double pos,double dur,String message,boolean immediate){
        if(token<0||!trustedPage())return;
        JSONObject data=new JSONObject();try{data.put("pos",pos);data.put("dur",dur);if(message!=null)data.put("message",message);}catch(Exception ignored){}
        web.evaluateJavascript("window.CodingNative && CodingNative.report("+token+","+JSONObject.quote(event)+","+data+")",immediate?result->wake():null);
    }
    private void failure(String message){
        diagnostics.record("failure",message);
        if(token<0)return;
        resumePosition=Math.max(0,positionMs());
        if(fallback!=null&&fallback.mode().equals(decoderPrefs.getString("successful","")))decoderPrefs.edit().putString("successful","").apply();
        releasePlayers();
        if(fallback!=null&&fallback.next()){
            report("switching",resumePosition/1000.0,0,"正在尝试"+PlaybackFallback.label(fallback.mode()));
            open(source,token);return;
        }
        terminalFailure(message+"；可在设置中选择解码方式");
    }
    private void releasePlayers(){next.clear();
        diagnostics.resetFrames(false);
        if(media!=null){media.release();media=null;}if(browser){browserControl("stop");browser=false;resumeBrowser=false;web.setBackgroundColor(Color.TRANSPARENT);}
        prepared=false;playing=false;prepareDeadline=0;playbackStartedAt=0;rendered=false;
    }
    private void terminalFailure(String message){releasePlayers();report("error",resumePosition/1000.0,0,message);failed=true;}
    private void position(JSONObject data)throws Exception{
        JSONObject r=data.getJSONObject("rect");double scale=web.getWidth()/Math.max(1,data.optDouble("viewport",1920));
        int w=Math.max(1,Math.min(web.getWidth(),(int)(r.getDouble("w")*scale))),h=Math.max(1,Math.min(web.getHeight(),(int)(r.getDouble("h")*scale)));
        FrameLayout.LayoutParams lp=(FrameLayout.LayoutParams)picture.getLayoutParams();
        int x=Math.max(0,(int)(r.getDouble("x")*scale)),y=Math.max(0,(int)(r.getDouble("y")*scale));
        if(lp.width!=w||lp.height!=h||lp.leftMargin!=x||lp.topMargin!=y){lp.width=w;lp.height=h;lp.leftMargin=x;lp.topMargin=y;picture.setLayoutParams(lp);fit();}
        picture.setAlpha(browser?0f:1f);picture.setVisibility(View.VISIBLE);
    }
    private void fit(){
        if(videoW<=0||videoH<=0)return;
        FrameLayout.LayoutParams lp=(FrameLayout.LayoutParams)picture.getLayoutParams();
        float ratio=Math.min(lp.width/(float)videoW,lp.height/(float)videoH);
        Matrix transform=new Matrix();transform.setScale(videoW*ratio/lp.width,videoH*ratio/lp.height,lp.width/2f,lp.height/2f);picture.setTransform(transform);
    }
    private void stopMedia(){stopMedia(true);}
    private void stopMedia(boolean hide){releasePlayers();completedNaturally=false;failed=false;token=-1;source="";fallback=null;resumePosition=0;speed=1;if(hide)picture.setVisibility(View.INVISIBLE);}
    public void onSurfaceTextureAvailable(SurfaceTexture t,int w,int h){surface=new Surface(t);wake();}
    public void onSurfaceTextureSizeChanged(SurfaceTexture t,int w,int h){fit();}
    public boolean onSurfaceTextureDestroyed(SurfaceTexture t){if(!browser)stopMedia();if(surface!=null){surface.release();surface=null;}return true;}
    public void onSurfaceTextureUpdated(SurfaceTexture t){if(prepared&&playing){rendered=true;diagnostics.frame();}}
}
