package net.codingcompanion.tv;

/** Only the reported TCL platform opts into a separate NAS metadata copy. */
final class TvCompatibility {
    static boolean applies(String model) {
        return "TCL_MT5879_CN".equalsIgnoreCase(model);
    }
    static String profile(String model) {
        return applies(model) ? "tcl-hevc" : "";
    }
}
