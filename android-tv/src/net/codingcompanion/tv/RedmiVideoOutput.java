package net.codingcompanion.tv;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;

/** Video-only output below the WebView; the holder, never the player, owns its Surface. */
final class RedmiVideoOutput extends FrameLayout implements SurfaceHolder.Callback {
    interface Listener { void ready(Surface surface); void gone(Surface surface); }
    private final SurfaceView video;
    private final Listener listener;
    private Surface active;
    private int videoWidth,videoHeight;
    private boolean closed;
    RedmiVideoOutput(Activity activity,Listener listener){
        super(activity);this.listener=listener;setBackgroundColor(Color.BLACK);
        video=new SurfaceView(activity);video.setZOrderOnTop(false);
        video.getHolder().setFormat(PixelFormat.OPAQUE);
        addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
        video.getHolder().addCallback(this);
    }
    void visible(boolean value){video.setVisibility(value?View.VISIBLE:View.INVISIBLE);}
    void fit(int width,int height){videoWidth=width;videoHeight=height;fit();}
    private void fit(){
        if(videoWidth<=0||videoHeight<=0||getWidth()<=0||getHeight()<=0)return;
        float ratio=Math.min(getWidth()/(float)videoWidth,getHeight()/(float)videoHeight);
        int w=Math.max(1,Math.round(videoWidth*ratio)),h=Math.max(1,Math.round(videoHeight*ratio));
        FrameLayout.LayoutParams lp=(FrameLayout.LayoutParams)video.getLayoutParams();
        if(lp.width!=w||lp.height!=h){lp.width=w;lp.height=h;video.setLayoutParams(lp);}
    }
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);post(()->{if(!closed)fit();});}
    @Override public void surfaceCreated(SurfaceHolder holder){
        if(closed)return;Surface surface=holder.getSurface();if(surface==null||!surface.isValid())return;
        active=surface;listener.ready(surface);
    }
    @Override public void surfaceChanged(SurfaceHolder holder,int format,int width,int height){fit();}
    @Override public void surfaceDestroyed(SurfaceHolder holder){
        Surface old=active;active=null;if(!closed&&old!=null)listener.gone(old);
    }
    void close(){closed=true;video.getHolder().removeCallback(this);active=null;}
}
