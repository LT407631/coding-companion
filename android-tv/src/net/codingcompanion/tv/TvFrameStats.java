package net.codingcompanion.tv;

import java.util.Locale;

/** Three five-second Texture update windows; no images, timer or per-frame allocations. */
final class TvFrameStats {
    private long start=-1, position, lastPoll, lastPosition, lastFrame, maxGap;
    private int updates, gaps, windows;
    void reset(boolean source){start=-1;updates=0;gaps=0;maxGap=0;if(source)windows=0;}
    private void begin(long now,long pos){start=lastPoll=lastFrame=now;position=lastPosition=pos;updates=0;gaps=0;maxGap=0;}
    void frame(long now){
        if(start<0||windows>=3)return;
        long gap=Math.max(0,now-lastFrame);maxGap=Math.max(maxGap,gap);
        if(gap>200)gaps++;
        lastFrame=now;updates++;
    }
    String poll(long now,long pos,boolean playing,float rate){
        if(windows>=3)return null;
        if(!playing){reset(false);return null;}
        if(start<0){begin(now,pos);return null;}
        // Explicit seek/rate resets are supplemented by a guard against stale positions.
        if(pos<lastPosition||Math.abs((pos-lastPosition)-(now-lastPoll)*rate)>1500){begin(now,pos);return null;}
        lastPoll=now;lastPosition=pos;
        long elapsed=now-start;if(elapsed<5000)return null;
        long tail=Math.max(0,now-lastFrame);
        String note=String.format(Locale.US,"windowMs=%d,positionMs=%d,updates=%d,textureFps=%.2f,maxGapMs=%d,gapsOver200ms=%d,rate=%.2f",
            elapsed,pos-position,updates,updates*1000.0/elapsed,Math.max(maxGap,tail),gaps+(tail>200?1:0),rate);
        windows++;begin(now,pos);return note;
    }
}
