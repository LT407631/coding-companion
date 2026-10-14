package net.codingcompanion.tv;

import java.util.ArrayList;
import java.util.List;

/** One bounded attempt per route. A preference is evidence, never a permanent lock. */
final class PlaybackFallback {
    static final String AUTO="auto", SYSTEM="system", BROWSER="browser";
    static final String[] MODES={SYSTEM,BROWSER};
    private final List<String> order=new ArrayList<>();
    private int index;
    private long firstProgress=-1, firstTime=-1;
    private boolean confirmed;
    PlaybackFallback(String requested,String remembered){
        if(valid(requested)&&!AUTO.equals(requested)) order.add(requested);
        else {
            if(valid(remembered)&&!AUTO.equals(remembered)) order.add(remembered);
            for(String mode:MODES)if(!order.contains(mode))order.add(mode);
        }
    }
    static boolean valid(String mode){if(AUTO.equals(mode))return true;for(String value:MODES)if(value.equals(mode))return true;return false;}
    String mode(){return order.get(index);}
    boolean next(){if(index+1>=order.size())return false;index++;resetEvidence();confirmed=false;return true;}
    void resetEvidence(){firstProgress=-1;firstTime=-1;}
    boolean confirm(long position,boolean pictureOutput,long now){
        if(confirmed||!pictureOutput||position<0)return false;
        if(firstProgress<0||position<firstProgress){firstProgress=position;firstTime=now;return false;}
        if(position-firstProgress<2000||now-firstTime<2000)return false;
        confirmed=true;return true;
    }
    static String label(String mode){
        switch(mode){case SYSTEM:return "系统硬件播放器";case BROWSER:return "浏览器播放器";default:return "自动选择";}
    }
}
