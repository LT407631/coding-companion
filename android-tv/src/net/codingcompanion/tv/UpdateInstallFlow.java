package net.codingcompanion.tv;

/** System UI fallback order; it never grants permission or installs silently. */
final class UpdateInstallFlow {
    static final int APP_SOURCES=0, VIEW_APK=1, INSTALL_PACKAGE=2, SECURITY_SETTINGS=3, SETTINGS=4;
    enum Result { INSTALLER, PERMISSION_SETTINGS, UNAVAILABLE }
    interface Launcher { boolean open(int target); }
    static Result launch(boolean permissionNeeded, Launcher launcher) {
        if(permissionNeeded && launcher.open(APP_SOURCES)) return Result.PERMISSION_SETTINGS;
        if(launcher.open(VIEW_APK) || launcher.open(INSTALL_PACKAGE)) return Result.INSTALLER;
        if(permissionNeeded && (launcher.open(SECURITY_SETTINGS) || launcher.open(SETTINGS))) return Result.PERMISSION_SETTINGS;
        return Result.UNAVAILABLE;
    }
}
