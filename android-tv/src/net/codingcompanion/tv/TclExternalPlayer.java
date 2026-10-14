package net.codingcompanion.tv;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONObject;

/** Explicit, manual handoff to a preinstalled video app on the reported TCL only. */
final class TclExternalPlayer {
    static final String MODE="external";
    static final int REQUEST=4172;
    private final Activity activity;
    private final TvPlaybackDiagnostics diagnostics;
    private ComponentName target;
    private String label="";
    private TclMediaSource.Input input;
    private boolean returned;
    private int generation;

    TclExternalPlayer(Activity a,TvPlaybackDiagnostics d){activity=a;diagnostics=d;refresh();}
    static boolean allowed(String mode){return MODE.equals(mode)&&TvCompatibility.applies(Build.MODEL);}
    private static Intent video(String address){return new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(address),"video/mp4");}
    void refresh(){
        target=null;label="";
        if(!TvCompatibility.applies(Build.MODEL))return;
        try{
            PackageManager pm=activity.getPackageManager();
            String address="http://127.0.0.1/video.mp4";
            Set<String> browsers=new HashSet<>();
            for(ResolveInfo r:pm.queryIntentActivities(new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(address),"text/html"),PackageManager.MATCH_DEFAULT_ONLY))
                if(r.activityInfo!=null)browsers.add(r.activityInfo.packageName);
            List<ResolveInfo> candidates=new ArrayList<>();
            for(ResolveInfo r:pm.queryIntentActivities(video(address),PackageManager.MATCH_DEFAULT_ONLY)){
                ActivityInfo a=r.activityInfo;
                if(a==null||!a.exported||!a.enabled||a.applicationInfo==null||!a.applicationInfo.enabled||a.packageName.equals(activity.getPackageName())||browsers.contains(a.packageName))continue;
                if((a.applicationInfo.flags&(ApplicationInfo.FLAG_SYSTEM|ApplicationInfo.FLAG_UPDATED_SYSTEM_APP))==0)continue;
                if(a.permission!=null&&activity.checkCallingOrSelfPermission(a.permission)!=PackageManager.PERMISSION_GRANTED)continue;
                candidates.add(r);
            }
            ResolveInfo preferred=pm.resolveActivity(video(address),PackageManager.MATCH_DEFAULT_ONLY);
            String defaultName=preferred!=null&&preferred.activityInfo!=null?preferred.activityInfo.packageName:"";
            Collections.sort(candidates,(a,b)->{
                int difference=score(b,defaultName)-score(a,defaultName);
                return difference!=0?difference:(a.activityInfo.packageName+"/"+a.activityInfo.name).compareTo(b.activityInfo.packageName+"/"+b.activityInfo.name);
            });
            if(!candidates.isEmpty()){
                ResolveInfo r=candidates.get(0);target=new ComponentName(r.activityInfo.packageName,r.activityInfo.name);
                CharSequence title=r.loadLabel(pm);label=title==null?"电视自带播放器":title.toString();
                if(label.length()>80)label=label.substring(0,80);
            }
            diagnostics.record("external-detected","count="+candidates.size()+",target="+(target==null?"none":target.flattenToShortString()));
        }catch(RuntimeException e){diagnostics.record("external-detection-error",e.getClass().getSimpleName());}
    }
    private static int score(ResolveInfo r,String defaultName){
        String p=r.activityInfo.packageName.toLowerCase(Locale.ROOT);
        return (p.startsWith("com.tcl.")?100:0)+(p.equals(defaultName)?10:0);
    }
    JSONObject state(){JSONObject data=new JSONObject();try{data.put("available",target!=null);data.put("label",label);}catch(Exception ignored){}return data;}
    boolean active(){return input!=null;}
    void open(String url,String cookie)throws Exception{
        close();refresh();
        if(target==null)throw new IllegalStateException("No preinstalled network video activity");
        final int turn=generation;
        input=new TclMediaSource.Input(url,cookie,note->activity.runOnUiThread(()->{if(turn==generation&&active())diagnostics.record("external-transport",note);}));
        try{
            Intent intent=video(input.address()).setComponent(target).putExtra(Intent.EXTRA_TITLE,"coding伴侣 · 当前剧集");
            diagnostics.record("external-open",target.flattenToShortString());
            activity.startActivityForResult(intent,REQUEST);
        }catch(RuntimeException e){close();diagnostics.record("external-open-error",e.getClass().getSimpleName());throw e;}
    }
    boolean result(int request,int result){
        if(request!=REQUEST)return false;
        boolean wasActive=active();close();returned=wasActive;
        diagnostics.record("external-return","result="+result);return true;
    }
    boolean takeReturn(){boolean result=returned;returned=false;return result;}
    void close(){generation++;if(input!=null){input.close();input=null;}returned=false;}
}
