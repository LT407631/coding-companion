package net.codingcompanion.tv;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.os.SystemClock;
import android.view.Surface;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.Map;

/** Scoped platform codecs: one hardware video decoder and a small PCM audio sink. */
final class TclHardwarePlayer extends MediaPlayer {
    private final Handler callbacks=new Handler(Looper.getMainLooper());
    private volatile boolean closed, ready, playing, launched, videoDone, audioDone;
    private volatile int duration, width, height, target, generation;
    private volatile float speed=1;
    private volatile long wall, wallPosition, audioBase=-1, audioEpoch=-1;
    private volatile AudioTrack audio;
    private volatile int audioRate;
    private volatile long frames, dropped, renderedFrames;
    private Runnable renderedFrame;
    private volatile long videoPts=-1;
    private Surface surface;
    private TclMediaSource.Input input;
    private MediaExtractor videoInput, audioInput;
    private MediaFormat videoFormat, audioFormat;
    private String component="";
    private TclMediaSource.Report report;
    private volatile String openedComponent="";
    private OnPreparedListener preparedListener;
    private OnCompletionListener completionListener;
    private OnSeekCompleteListener seekListener;
    private OnVideoSizeChangedListener sizeListener;
    private OnErrorListener errorListener;
    private boolean completionReported;

    void source(String url,Map<String,String> headers,TclMediaSource.Report report)throws IOException{
        if(input!=null)throw new IOException("Source already assigned");
        this.report=report;
        input=new TclMediaSource.Input(url,headers.get("Cookie"),headers.get("X-Coding-Media"),report);
    }
    void rendered(Runnable callback){renderedFrame=callback;}
    void ticket(String value){TclMediaSource.Input current=input;if(current!=null)current.ticket(value);}
    private void note(String text){if(!closed&&report!=null)report.status(text);}
    @Override public void setSurface(Surface value){surface=value;}
    @Override public void setOnPreparedListener(OnPreparedListener value){preparedListener=value;}
    @Override public void setOnCompletionListener(OnCompletionListener value){completionListener=value;}
    @Override public void setOnSeekCompleteListener(OnSeekCompleteListener value){seekListener=value;}
    @Override public void setOnVideoSizeChangedListener(OnVideoSizeChangedListener value){sizeListener=value;}
    @Override public void setOnErrorListener(OnErrorListener value){errorListener=value;}
    private void post(Runnable task){callbacks.post(()->{if(!closed)task.run();});}
    private static int track(MediaExtractor extractor,String prefix){
        for(int i=0;i<extractor.getTrackCount();i++){
            String mime=extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
            if(mime!=null&&mime.startsWith(prefix))return i;
        }
        return -1;
    }
    @Override public void prepareAsync(){
        if(input==null||ready)throw new IllegalStateException("Invalid preparation");
        new Thread(()->{
            MediaExtractor v=new MediaExtractor(),a=null;
            try{
                v.setDataSource(input.address(),Collections.<String,String>emptyMap());
                if(closed)return;
                int index=track(v,"video/");if(index<0)throw new IOException("Missing video track");
                videoFormat=v.getTrackFormat(index);v.selectTrack(index);
                component=HardwareVideoCodec.select(videoFormat);
                width=videoFormat.getInteger(MediaFormat.KEY_WIDTH);height=videoFormat.getInteger(MediaFormat.KEY_HEIGHT);
                duration=(int)Math.min(Integer.MAX_VALUE,videoFormat.getLong(MediaFormat.KEY_DURATION)/1000);
                if(track(v,"audio/")>=0){
                    a=new MediaExtractor();a.setDataSource(input.address(),Collections.<String,String>emptyMap());
                    int ai=track(a,"audio/");audioFormat=a.getTrackFormat(ai);a.selectTrack(ai);
                }
                synchronized(this){if(closed)return;videoInput=v;audioInput=a;v=null;a=null;ready=true;}
                post(()->{if(sizeListener!=null)sizeListener.onVideoSizeChanged(this,width,height);if(preparedListener!=null)preparedListener.onPrepared(this);});
            }catch(Exception e){note("decoder-prepare-error,type="+e.getClass().getSimpleName());error();}
            finally{if(v!=null)v.release();if(a!=null)a.release();}
        },"tcl-hardware-prepare").start();
    }
    private void error(){
        playing=false;
        post(()->{if(errorListener!=null)errorListener.onError(this,MEDIA_ERROR_UNKNOWN,MEDIA_ERROR_UNSUPPORTED);});
    }
    @Override public synchronized void start(){
        if(!ready||closed)throw new IllegalStateException("Player not ready");
        wallPosition=position();wall=SystemClock.elapsedRealtime();playing=true;
        AudioTrack sink=audio;if(sink!=null)try{sink.play();}catch(IllegalStateException ignored){}
        if(!launched){
            launched=true;audioDone=audioInput==null;
            new Thread(this::video,"tcl-hardware-video").start();
            if(audioInput!=null)new Thread(this::audio,"tcl-platform-audio").start();
        }
    }
    @Override public void pause(){
        wallPosition=position();wall=SystemClock.elapsedRealtime();playing=false;
        AudioTrack sink=audio;if(sink!=null)try{sink.pause();}catch(IllegalStateException ignored){}
    }
    private long position(){
        AudioTrack sink=audio;
        if(audioInput!=null){
            if(sink!=null&&audioEpoch==generation&&audioBase>=0&&audioRate>0)
                try{return Math.min(duration,audioBase+Integer.toUnsignedLong(sink.getPlaybackHeadPosition())*1000/audioRate);}
                catch(IllegalStateException ignored){}
            return target;
        }
        return Math.min(duration,wallPosition+(playing?(long)((SystemClock.elapsedRealtime()-wall)*speed):0));
    }
    @Override public int getCurrentPosition(){return (int)Math.max(0,position());}
    @Override public int getDuration(){return duration;}
    @Override public int getVideoWidth(){return width;}
    @Override public int getVideoHeight(){return height;}
    @Override public synchronized void seekTo(int ms){
        long before=position();
        target=Math.min(Math.max(0,ms),Math.max(0,duration-1));generation++;
        wallPosition=target;wall=SystemClock.elapsedRealtime();audioBase=-1;audioEpoch=-1;
        completionReported=false;videoDone=false;audioDone=audioInput==null;
        if(RedmiPlayback.applies())note("decoder-seek,fromMs="+before+",targetMs="+target+",generation="+generation);
    }
    @Override public PlaybackParams getPlaybackParams(){return new PlaybackParams().allowDefaults().setSpeed(speed);}
    @Override public void setPlaybackParams(PlaybackParams params){
        wallPosition=position();wall=SystemClock.elapsedRealtime();speed=params.getSpeed();
        AudioTrack sink=audio;if(sink!=null)try{sink.setPlaybackParams(params);}catch(IllegalStateException ignored){}
    }
    private boolean awaitPlaying()throws InterruptedException{
        while(!closed&&!playing)Thread.sleep(10);
        return !closed;
    }
    private static boolean feed(MediaCodec codec,MediaExtractor extractor,boolean eos){
        if(eos)return true;
        int index=codec.dequeueInputBuffer(0);if(index<0)return false;
        ByteBuffer buffer=codec.getInputBuffer(index);int bytes=extractor.readSampleData(buffer,0);
        if(bytes<0){codec.queueInputBuffer(index,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);return true;}
        codec.queueInputBuffer(index,0,bytes,extractor.getSampleTime(),0);extractor.advance();return false;
    }
    private void video(){
        MediaCodec codec=null;MediaExtractor extractor=videoInput;
        try{
            codec=HardwareVideoCodec.open(component,videoFormat,surface,this::note);openedComponent=codec.getName();
            note("decoder-open,name="+openedComponent+",classification="+(android.os.Build.VERSION.SDK_INT>=29?"platform-hardware":"vendor-allowlist")+",width="+width+",height="+height);
            if(renderedFrame!=null)codec.setOnFrameRenderedListener((decoder,pts,nanos)->{if(!closed){renderedFrames++;renderedFrame.run();}},callbacks);
            MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();int epoch=-1;boolean eos=false,seekReported=false;
            while(!closed){
                if(!awaitPlaying())break;
                if(epoch!=generation){if(epoch>=0)codec.flush();epoch=generation;extractor.seekTo(target*1000L,MediaExtractor.SEEK_TO_PREVIOUS_SYNC);eos=false;seekReported=false;}
                eos=feed(codec,extractor,eos);
                int output=codec.dequeueOutputBuffer(info,10000);if(output<0)continue;
                boolean end=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;
                long pts=info.presentationTimeUs/1000;
                if((!end||info.size>0)&&pts>=target){
                    while(!closed&&epoch==generation&&(!playing||pts-position()>15))Thread.sleep(5);
                    boolean render=!closed&&epoch==generation&&pts-position()>-100;
                    if(render){codec.releaseOutputBuffer(output,System.nanoTime()+Math.max(0,pts-position())*1000000);frames++;videoPts=pts;}
                    else{codec.releaseOutputBuffer(output,false);dropped++;}
                    if(render&&!seekReported){seekReported=true;post(()->{if(seekListener!=null)seekListener.onSeekComplete(this);});}
                }else codec.releaseOutputBuffer(output,false);
                if(end&&epoch==generation){
                    videoDone=true;completeIfEnded();
                    // Keep the instance seekable until the page adopts the next episode.
                    while(!closed&&epoch==generation)Thread.sleep(10);
                }
            }
        }catch(Exception e){if(!closed){note("decoder-error,type="+e.getClass().getSimpleName());error();}}
        finally{if(codec!=null)codec.release();extractor.release();}
    }
    private AudioTrack sink(MediaFormat format){
        int rate=format.getInteger(MediaFormat.KEY_SAMPLE_RATE),channels=format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
        if(channels<1||channels>2)throw new IllegalArgumentException("Unsupported audio layout");
        int mask=channels==1?AudioFormat.CHANNEL_OUT_MONO:AudioFormat.CHANNEL_OUT_STEREO;
        if(format.containsKey(MediaFormat.KEY_PCM_ENCODING)&&format.getInteger(MediaFormat.KEY_PCM_ENCODING)!=AudioFormat.ENCODING_PCM_16BIT)
            throw new IllegalArgumentException("Unsupported PCM encoding");
        audioRate=rate;
        AudioTrack track=new AudioTrack.Builder().setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(mask).build())
            .setBufferSizeInBytes(Math.max(AudioTrack.getMinBufferSize(rate,mask,AudioFormat.ENCODING_PCM_16BIT)*2,8192))
            .setTransferMode(AudioTrack.MODE_STREAM).build();
        track.setPlaybackParams(getPlaybackParams());return track;
    }
    private MediaCodec audioCodec()throws IOException{
        MediaCodec codec=MediaCodec.createDecoderByType(audioFormat.getString(MediaFormat.KEY_MIME));
        try{codec.configure(audioFormat,null,null,0);codec.start();return codec;}
        catch(RuntimeException e){codec.release();throw e;}
    }
    private MediaExtractor reopenAudio(MediaExtractor old)throws IOException{
        old.release();MediaExtractor fresh=new MediaExtractor();
        try{
            fresh.setDataSource(input.address(),Collections.<String,String>emptyMap());
            int index=track(fresh,"audio/");if(index<0)throw new IOException("Missing audio track");
            fresh.selectTrack(index);audioInput=fresh;return fresh;
        }catch(IOException|RuntimeException e){fresh.release();throw e;}
    }
    private void audio(){
        MediaCodec codec=null;AudioTrack track=null;MediaExtractor extractor=audioInput;
        try{
            codec=audioCodec();
            MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();int epoch=-1,seekTarget=0;boolean eos=false,landing=false,recovered=false;long written=0,inputMs=-1;
            while(!closed){
                if(!awaitPlaying())break;
                if(epoch!=generation){
                    if(epoch>=0)codec.flush();epoch=generation;seekTarget=target;extractor.seekTo(seekTarget*1000L,MediaExtractor.SEEK_TO_PREVIOUS_SYNC);eos=false;written=0;audioBase=-1;
                    landing=RedmiPlayback.applies()&&epoch>0;recovered=false;inputMs=extractor.getSampleTime()/1000;
                    if(track!=null){
                        track.pause();
                        if(RedmiPlayback.applies()){
                            audio=null;long oldHead=Integer.toUnsignedLong(track.getPlaybackHeadPosition());
                            track.release();track=null;
                            note("decoder-audio-reset,generation="+epoch+",targetMs="+target+",oldHeadFrames="+oldHead+",method=recreate");
                        }else track.flush();
                    }
                }
                eos=feed(codec,extractor,eos);int output=codec.dequeueOutputBuffer(info,10000);
                if(output==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){
                    if(track!=null){audio=null;track.release();}
                    track=sink(codec.getOutputFormat());audio=track;continue;
                }
                if(output<0)continue;
                boolean end=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;
                if(info.size>0&&info.presentationTimeUs/1000>=seekTarget&&epoch==generation){
                    if(landing){
                        long outputMs=info.presentationTimeUs/1000;
                        note("decoder-audio-land,generation="+epoch+",targetMs="+seekTarget+",inputMs="+inputMs+",outputMs="+outputMs+",method="+(recovered?"cold-reopen":"flush"));
                        if(outputMs-seekTarget>500){
                            if(recovered)throw new IOException("Audio seek did not land");
                            // Some OEM audio pipelines retain pre-seek samples after flush.
                            // Reopen only after proving the first PCM is at the wrong time.
                            codec.release();codec=null;
                            audio=null;if(track!=null){track.pause();track.release();track=null;}
                            MediaExtractor previous=extractor;extractor=null;extractor=reopenAudio(previous);extractor.seekTo(seekTarget*1000L,MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
                            inputMs=extractor.getSampleTime()/1000;codec=audioCodec();
                            audioBase=-1;audioEpoch=-1;written=0;eos=false;recovered=true;continue;
                        }
                        landing=false;
                    }
                    if(track==null){track=sink(codec.getOutputFormat());audio=track;}
                    ByteBuffer buffer=codec.getOutputBuffer(output);buffer.position(info.offset);buffer.limit(info.offset+info.size);
                    if(audioBase<0){audioBase=info.presentationTimeUs/1000;audioEpoch=epoch;}
                    int channel=codec.getOutputFormat().getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if(playing)track.play();
                    while(buffer.hasRemaining()&&!closed&&epoch==generation){
                        if(!awaitPlaying())break;
                        int n=track.write(buffer,buffer.remaining(),AudioTrack.WRITE_NON_BLOCKING);
                        if(n<0)throw new IOException("Audio output failed");
                        written+=n/(channel*2);if(n==0)Thread.sleep(5);
                    }
                }
                codec.releaseOutputBuffer(output,false);
                if(end&&epoch==generation){
                    while(!closed&&epoch==generation&&track!=null&&Integer.toUnsignedLong(track.getPlaybackHeadPosition())<written)Thread.sleep(10);
                    if(epoch==generation){audioDone=true;completeIfEnded();}
                    while(!closed&&epoch==generation)Thread.sleep(10);
                }
            }
        }catch(Exception e){if(!closed){note("decoder-audio-error,type="+e.getClass().getSimpleName()+(e instanceof MediaCodec.CodecException?",code="+((MediaCodec.CodecException)e).getDiagnosticInfo():""));error();}}
        finally{audio=null;if(track!=null)track.release();if(codec!=null)codec.release();if(extractor!=null)extractor.release();}
    }
    private synchronized void completeIfEnded(){
        if(!closed&&videoDone&&audioDone&&!completionReported){completionReported=true;playing=false;post(()->{if(completionListener!=null)completionListener.onCompletion(this);});}
    }
    @Override public PersistableBundle getMetrics(){
        PersistableBundle metrics=new PersistableBundle();
        if(!openedComponent.isEmpty())metrics.putString(MetricsConstants.CODEC_VIDEO,openedComponent);
        metrics.putString("coding.video.engine","named-platform");
        if(renderedFrame!=null){metrics.putString("coding.video.output","surface-view");metrics.putLong("coding.video.rendered",renderedFrames);}
        metrics.putLong("coding.video.pts",videoPts);
        metrics.putLong(MetricsConstants.FRAMES,frames);metrics.putLong(MetricsConstants.FRAMES_DROPPED,dropped);return metrics;
    }
    @Override public synchronized void release(){
        if(closed)return;closed=true;playing=false;
        if(input!=null){input.close();input=null;}
        AudioTrack track=audio;if(track!=null)try{track.pause();}catch(IllegalStateException ignored){}
        if(ready&&!launched){if(videoInput!=null)videoInput.release();if(audioInput!=null)audioInput.release();}
        super.release();
    }
}
