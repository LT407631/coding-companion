package net.codingcompanion.tv;

import android.app.Activity;
import android.os.Build;
import android.media.MediaCodecInfo;
import android.media.MediaPlayer;
import android.os.PersistableBundle;
import android.media.MediaCodecList;
import android.webkit.CookieManager;
import android.webkit.WebView;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Small, bounded diagnostics for the reported TCL; never records credential values. */
final class TvPlaybackDiagnostics {
    private final Activity activity;
    private final WebView web;
    private final boolean enabled=TclMediaSource.localTransport();
    private final AtomicBoolean probing=new AtomicBoolean();
    private volatile HttpURLConnection connection;
    private volatile boolean closed;
    private String site;
    private volatile String source="";
    private int reports, probes;
    private long browserAt;
    private String browserState="";
    private final TvFrameStats frames=new TvFrameStats();

    TvPlaybackDiagnostics(Activity a,WebView w,String base){activity=a;web=w;site=base;}
    void setSite(String base){site=base;source="";}
    void source(String url){if(enabled)source=url.replaceAll("&tv_diag_route=(system|browser)","");}
    private static String shortText(String text,int limit){return text.length()>limit?text.substring(0,limit):text;}
    void install(){
        if(!enabled||closed)return;
        JSONObject info=new JSONObject();
        try{
            info.put("model",Build.MODEL);info.put("sdk",Build.VERSION.SDK_INT);
            if(Build.VERSION.SDK_INT>=26&&WebView.getCurrentWebViewPackage()!=null)
                info.put("webview",WebView.getCurrentWebViewPackage().versionName);
            StringBuilder codecs=new StringBuilder();int count=0;
            for(MediaCodecInfo codec:new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()){
                if(codec.isEncoder())continue;
                for(String type:codec.getSupportedTypes())if("video/hevc".equalsIgnoreCase(type)&&count++<6){
                    try{
                        MediaCodecInfo.CodecCapabilities caps=codec.getCapabilitiesForType(type);
                        codecs.append(shortText(codec.getName(),64)).append(":1080p30=")
                            .append(caps.getVideoCapabilities().areSizeAndRateSupported(1920,1080,30));
                        if(Build.VERSION.SDK_INT>=29)codecs.append(",hw=").append(codec.isHardwareAccelerated());
                        codecs.append(",levels=");int levels=0;
                        for(MediaCodecInfo.CodecProfileLevel level:caps.profileLevels)if(levels++<6)
                            codecs.append(level.profile).append('/').append(level.level).append(',');
                        codecs.append(';');
                    }catch(Exception ignored){codecs.append("capability-unavailable;");}
                }
            }
            info.put("hevc",shortText(codecs.toString(),800));
        }catch(Exception ignored){}
        web.evaluateJavascript("window.CodingTVDiagnostics && CodingTVDiagnostics.enable("+info+")",null);
    }
    String tag(String url,String route){return enabled?url+"&tv_diag_route="+route:url;}
    void transport(String url,String note){activity.runOnUiThread(()->{if(!closed&&url.replaceAll("&tv_diag_route=(system|browser)","").equals(source))record("native-range",note);});}
    void record(String event,String note){
        if(!enabled||closed||reports>=48)return;
        reports++;
        JSONObject data=new JSONObject();try{data.put("event",event);data.put("note",shortText(note,800));}catch(Exception ignored){}
        web.evaluateJavascript("window.CodingTVDiagnostics && CodingTVDiagnostics.record("+data+")",null);
    }
    void resetFrames(boolean newSource){if(enabled)frames.reset(newSource);}
    void frame(){if(enabled&&!closed)frames.frame(android.os.SystemClock.elapsedRealtime());}
    void systemProgress(MediaPlayer player,long position,boolean playing,float rate){
        if(!enabled||closed)return;
        String note=frames.poll(android.os.SystemClock.elapsedRealtime(),position,playing,rate);
        if(note==null)return;
        try{if(Build.VERSION.SDK_INT>=26){PersistableBundle m=player.getMetrics();if(m!=null){
            String selected=m.getString(MediaPlayer.MetricsConstants.CODEC_VIDEO);
            note+=",codec="+selected+",hardware="+hardware(selected);
            if(m.containsKey("coding.video.pts"))note+=",avDeltaMs="+(m.getLong("coding.video.pts")-position);
            // OEMs may omit either counter. Missing is never reported as zero drops.
            Object count=m.get(MediaPlayer.MetricsConstants.FRAMES),dropped=m.get(MediaPlayer.MetricsConstants.FRAMES_DROPPED);
            note+=",framesTotal="+(count instanceof Number?count:"unavailable")+",droppedTotal="+(dropped instanceof Number?dropped:"unavailable");
        }}}catch(Exception ignored){note+=",metrics=unavailable";}
        record("system-frames",note);
    }
    private static String hardware(String selected){
        if(selected==null||Build.VERSION.SDK_INT<29)return "unknown";
        for(MediaCodecInfo info:new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos())
            if(!info.isEncoder()&&info.getName().equals(selected))return String.valueOf(info.isHardwareAccelerated()&&!info.isSoftwareOnly());
        return "unknown";
    }
    void systemError(MediaPlayer player,int what,int extra){
        if(!enabled)return;
        String note="what="+what+",extra="+extra;
        try{if(Build.VERSION.SDK_INT>=26){PersistableBundle m=player.getMetrics();if(m!=null){
            note+=",codec="+m.getString(MediaPlayer.MetricsConstants.CODEC_VIDEO)+",mime="+m.getString(MediaPlayer.MetricsConstants.MIME_TYPE_VIDEO);if(m.containsKey(MediaPlayer.MetricsConstants.ERROR_CODE))note+=",metricError="+String.valueOf(m.get(MediaPlayer.MetricsConstants.ERROR_CODE));}}}
        catch(Exception ignored){}
        record("system-error",note);
    }
    void browser(JSONObject state){
        if(!enabled||state==null)return;
        String text=state.toString();long now=android.os.SystemClock.elapsedRealtime();
        if(!text.equals(browserState)&&(browserAt==0||now-browserAt>=5000||state.optInt("error")>0)){
            browserAt=now;browserState=text;record("browser-state",text);
        }
    }
    void probe(String url){
        if(!enabled||closed||probes>=2||!probing.compareAndSet(false,true))return;
        probes++;
        final String cookie=CookieManager.getInstance().getCookie(site);
        record("native-request","siteCookie="+(cookie!=null&&cookie.contains("coding_session=")));
        new Thread(()->{
            String note;HttpURLConnection c=null;
            try{
                c=(HttpURLConnection)new URL(url+"&tv_diag_probe=native").openConnection();connection=c;
                c.setConnectTimeout(4000);c.setReadTimeout(6000);c.setInstanceFollowRedirects(false);
                c.setRequestProperty("Range","bytes=0-7");c.setRequestProperty("User-Agent","CodingCompanionTV-Diagnostic/1.0.27");
                if(cookie!=null)c.setRequestProperty("Cookie",cookie);
                int status=c.getResponseCode();note="status="+status+",type="+c.getContentType()+",range="+c.getHeaderField("Content-Range");
            }catch(Exception e){note="exception="+e.getClass().getSimpleName();}
            finally{if(c!=null)c.disconnect();connection=null;probing.set(false);}
            final String result=note;activity.runOnUiThread(()->{if(!closed&&url.replaceAll("&tv_diag_route=(system|browser)","").equals(source))record("native-range",result);});
        },"tcl-playback-probe").start();
    }
    void close(){closed=true;HttpURLConnection c=connection;if(c!=null)c.disconnect();}
}
