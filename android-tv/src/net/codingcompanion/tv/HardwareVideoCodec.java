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
        if(Build.VERSION.SDK_INT<29)throw new IOException("Hardware classification unavailable");
        String type=format.getString(MediaFormat.KEY_MIME);
        for(MediaCodecInfo info:new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()){
            if(info.isEncoder()||!info.isHardwareAccelerated()||info.isSoftwareOnly())continue;
            for(String supported:info.getSupportedTypes())if(supported.equalsIgnoreCase(type)){
                try{if(info.getCapabilitiesForType(type).isFormatSupported(format))return info.getName();}
                catch(IllegalArgumentException ignored){}
            }
        }
        throw new IOException("No supported hardware video decoder");
    }
    static MediaCodec open(String name,MediaFormat format,Surface surface) throws IOException {
        if(surface==null)throw new IOException("Video surface unavailable");
        MediaCodec codec=MediaCodec.createByCodecName(name);
        try{
            if(!codec.getCodecInfo().isHardwareAccelerated()||codec.getCodecInfo().isSoftwareOnly())
                throw new IOException("Selected component is not hardware accelerated");
            codec.configure(format,surface,null,0);codec.start();return codec;
        }catch(IOException|RuntimeException e){codec.release();throw e;}
    }
}
