package net.codingcompanion.tv;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build;
import android.view.Surface;
import java.io.IOException;

/** Select an actual platform hardware component; never substitute a software decoder. */
final class HardwareVideoCodec {
    static String select(MediaFormat format) throws IOException {
        if(Build.VERSION.SDK_INT<29&&!RedmiPlayback.applies())throw new IOException("Hardware classification unavailable");
        String type=format.getString(MediaFormat.KEY_MIME);
        for(MediaCodecInfo info:new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()){
            if(info.isEncoder()||!eligible(info,type))continue;
            for(String supported:info.getSupportedTypes())if(supported.equalsIgnoreCase(type)){
                try{if(info.getCapabilitiesForType(type).isFormatSupported(format))return info.getName();}
                catch(IllegalArgumentException ignored){}
            }
        }
        throw new IOException("No supported hardware video decoder");
    }
    private static boolean eligible(MediaCodecInfo info,String mime) {
        if(Build.VERSION.SDK_INT>=29)return info.isHardwareAccelerated()&&!info.isSoftwareOnly();
        // API28 cannot report hardware classification. Only the observed vendor
        // component on this exact device is allowed; never guess from a prefix.
        return RedmiPlayback.accepts(info.getName(),mime);
    }
    interface Report { void status(String note); }
    private static void note(Report report,String text){if(report!=null)report.status(text);}
    private static String formatSummary(MediaFormat format){
        StringBuilder text=new StringBuilder();
        for(String key:new String[]{"width","height","profile","level","max-input-size"})
            try{if(format.containsKey(key))text.append(',').append(key).append('=').append(format.getInteger(key));}catch(RuntimeException ignored){}
        try{java.nio.ByteBuffer csd=format.getByteBuffer("csd-0");if(csd!=null)text.append(",csd0Bytes=").append(csd.remaining());}catch(RuntimeException ignored){}
        return text.toString();
    }
    static MediaCodec open(String name,MediaFormat format,Surface surface) throws IOException {
        return open(name,format,surface,null);
    }
    static MediaCodec open(String name,MediaFormat format,Surface surface,Report report) throws IOException {
        if(surface==null)throw new IOException("Video surface unavailable");
        MediaCodec codec=null;String stage="create";
        try{
            note(report,"decoder-phase,stage=create,name="+name+formatSummary(format));
            codec=MediaCodec.createByCodecName(name);
            if(!eligible(codec.getCodecInfo(),format.getString(MediaFormat.KEY_MIME)))
                throw new IOException("Selected component is not hardware accelerated");
            stage="configure";note(report,"decoder-phase,stage=configure,name="+codec.getName());
            codec.configure(format,surface,null,0);
            stage="start";note(report,"decoder-phase,stage=start,name="+codec.getName());
            codec.start();return codec;
        }catch(IOException|RuntimeException e){
            String detail="decoder-open-error,stage="+stage+",name="+name+",type="+e.getClass().getSimpleName();
            if(e instanceof MediaCodec.CodecException){
                MediaCodec.CodecException error=(MediaCodec.CodecException)e;
                String code=error.getDiagnosticInfo();
                if(code!=null){code=code.replaceAll("[^A-Za-z0-9_.-]","_");detail+=",diagnostic="+code.substring(0,Math.min(120,code.length()));}
                detail+=",recoverable="+error.isRecoverable()+",transient="+error.isTransient();
            }
            note(report,detail);if(codec!=null)codec.release();throw e;
        }
    }
}
