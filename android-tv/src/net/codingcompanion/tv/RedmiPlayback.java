package net.codingcompanion.tv;

import android.os.Build;

/** Controlled comparison for the reported Android 9 Redmi; other models keep their route. */
final class RedmiPlayback {
    static boolean applies() {
        return Build.VERSION.SDK_INT==28 && "MiTV-ASTP0".equalsIgnoreCase(Build.MODEL);
    }
    static boolean accepts(String name,String mime) {
        if(!applies())return false;
        return ("video/hevc".equals(mime) && "OMX.amlogic.hevc.decoder.awesome".equals(name))
            || ("video/avc".equals(mime) && "OMX.amlogic.avc.decoder.awesome".equals(name));
    }
}
