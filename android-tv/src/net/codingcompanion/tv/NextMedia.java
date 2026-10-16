package net.codingcompanion.tv;

import android.app.Activity;
import android.media.MediaPlayer;
import android.os.SystemClock;
import java.util.Map;

/** A silent, bounded standby player. Its failure must never fail the active episode. */
final class NextMedia {
    private final Activity activity;
    private MediaPlayer player;
    private String source="", blockedSource="";
    private int owner=-1, blocked=-1;
    private long deadline;
    private boolean ready;
    NextMedia(Activity activity){this.activity=activity;}
    private void block(){blocked=owner;blockedSource=source;clear();}
    void expire(){if(player!=null&&SystemClock.elapsedRealtime()>=deadline)block();}
    void update(String url,int id,Map<String,String> headers){
        expire();
        if(url.isEmpty()){clear();return;}
        if(player!=null&&owner==id&&source.equals(url))return;
        clear();if(blocked==id&&blockedSource.equals(url))return;
        try{
            final boolean metadataOnly=RedmiPlayback.applies();
            final MediaPlayer p=metadataOnly?TclMediaSource.createHardware():TclMediaSource.create();player=p;source=url;owner=id;deadline=SystemClock.elapsedRealtime()+(metadataOnly?8000:3000);
            // No surface and no start/rate/seek: current video and audio keep playing until their end.
            p.setOnPreparedListener(m->{if(player==m){ready=true;deadline=SystemClock.elapsedRealtime()+(metadataOnly?12000:5000);}});
            p.setOnErrorListener((m,what,extra)->{if(player==m)block();return true;});
            TclMediaSource.set(p,activity,url,headers,null);p.prepareAsync();
        }catch(Exception ignored){block();}
    }
    MediaPlayer take(String url,int id){
        expire();
        if(player==null||!ready||owner!=id||!source.equals(url))return null;
        MediaPlayer result=player;player=null;source="";owner=-1;ready=false;deadline=0;
        return result;
    }
    void clear(){if(player!=null){player.release();player=null;}source="";owner=-1;ready=false;deadline=0;}
}
