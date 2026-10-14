package net.codingcompanion.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/** Startup checks are silent; downloads are authenticated and use system installation UI. */
final class TvUpdater {
    private final Activity activity;
    private AlertDialog dialog;
    private TextView status;
    private volatile boolean cancelled;
    private volatile HttpURLConnection connection;
    private Thread worker;
    private JSONObject ready;
    private File apk;
    private boolean waitingForPermission;
    private boolean startupChecked, autoChecking, destroyed;
    private String manualAfterCheck;
    TvUpdater(Activity activity) {this.activity=activity;}
    void autoCheck(String site) {
        if(startupChecked||destroyed)return;
        startupChecked=true;
        if(dialog!=null||(worker!=null&&worker.isAlive()))return;
        cancelled=false;autoChecking=true;
        String cookie=CookieManager.getInstance().getCookie(site+"/updates/android-tv/latest");
        worker=new Thread(()->{
            JSONObject found=null;
            try {
                JSONObject release=readRelease(site,cookie);
                PackageInfo installed=activity.getPackageManager().getPackageInfo(activity.getPackageName(),0);
                if(release.getBoolean("available")&&UpdatePolicy.newer(release.getString("package"),release.getInt("version_code"),
                    release.getInt("min_sdk"),release.getLong("size"),release.getString("sha256"),installed.versionCode,Build.VERSION.SDK_INT)) {
                    UpdatePolicy.download(site,release.getString("url"),release.getString("sha256"));
                    if(release.getString("version_name").length()>64||release.optString("notes","").length()>2000)throw new Exception("更新信息无效");
                    found=release;
                }
            } catch(Exception ignored) { /* Startup network/auth failures do not interrupt watching. */ }
            final JSONObject release=found;
            activity.runOnUiThread(()->{
                autoChecking=false;worker=null;
                if(destroyed||activity.isFinishing())return;
                String manual=manualAfterCheck;manualAfterCheck=null;
                if(manual!=null){show(manual);return;}
                if(release==null||cancelled||dialog!=null)return;
                AlertDialog notice=new AlertDialog.Builder(activity).setTitle("发现电视应用新版")
                    .setMessage("新版 "+release.optString("version_name","")+"\n"+release.optString("notes",""))
                    .setPositiveButton("更新",(d,n)->{dialog=null;show(site);})
                    .setNegativeButton("稍后",null).create();
                dialog=notice;
                notice.setOnDismissListener(d->{if(dialog==notice)dialog=null;});
                notice.show();
            });
        },"tv-startup-update");worker.start();
    }
    void show(String site) {
        if(destroyed)return;
        if(autoChecking){manualAfterCheck=site;return;}
        if(dialog!=null&&dialog.isShowing()) return;
        if(worker!=null&&worker.isAlive()) {
            android.widget.Toast.makeText(activity,"正在结束上次检查，请稍后重试",android.widget.Toast.LENGTH_SHORT).show();return;
        }
        cancelled=false;ready=null;waitingForPermission=false;
        status=new TextView(activity);status.setTextSize(22);status.setPadding(32,24,32,24);
        try {status.setText("当前版本 "+activity.getPackageManager().getPackageInfo(activity.getPackageName(),0).versionName+"\n正在检查 NAS 更新…");}
        catch(Exception e) {status.setText("正在检查 NAS 更新…");}
        dialog=new AlertDialog.Builder(activity).setTitle("电视应用更新").setView(status)
            .setNegativeButton("关闭",null).create();
        dialog.setOnDismissListener(d->{cancelled=true;HttpURLConnection c=connection;if(c!=null)c.disconnect();});
        dialog.show();
        String cookie=CookieManager.getInstance().getCookie(site+"/updates/android-tv/latest");
        worker=new Thread(()->check(site,cookie),"tv-update");worker.start();
    }
    private void message(String text) {
        AlertDialog owner=dialog;
        activity.runOnUiThread(()->{if(dialog==owner&&!cancelled&&!activity.isFinishing())status.setText(text);});
    }
    private HttpURLConnection open(URI url,String cookie) throws Exception {
        if(cancelled) throw new Exception("已取消更新");
        HttpURLConnection c=(HttpURLConnection)url.toURL().openConnection();connection=c;
        c.setInstanceFollowRedirects(false);c.setConnectTimeout(12000);c.setReadTimeout(20000);
        c.setRequestProperty("Accept-Encoding","identity");c.setRequestProperty("Cache-Control","no-cache");
        if(cookie!=null&&!cookie.isEmpty())c.setRequestProperty("Cookie",cookie);
        int code=c.getResponseCode();
        if(code==401||code==403)throw new Exception("请先登录网站，再检查更新");
        if(code==404)throw new Exception("NAS 尚未启用电视更新服务");
        if(code!=200)throw new Exception("NAS 更新服务暂不可用（"+code+"）");
        return c;
    }
    private void check(String site,String cookie) {
        AlertDialog owner=dialog;
        File partial=new File(activity.getCacheDir(),"tv-update.part");
        try {
            JSONObject release=readRelease(site,cookie);
            if(!release.getBoolean("available")){message("当前 NAS 尚未发布电视安装包。");return;}
            PackageInfo installed=activity.getPackageManager().getPackageInfo(activity.getPackageName(),PackageManager.GET_SIGNATURES);
            int version=release.getInt("version_code"),sdk=release.getInt("min_sdk");
            long size=release.getLong("size");String hash=release.getString("sha256");
            if(!UpdatePolicy.newer(release.getString("package"),version,sdk,size,hash,installed.versionCode,Build.VERSION.SDK_INT)) {
                message("已经是最新版本（"+installed.versionName+"）。");return;
            }
            URI url=UpdatePolicy.download(site,release.getString("url"),hash);
            String name=release.getString("version_name");if(name.length()>64)throw new Exception("更新版本信息无效");
            String notes=release.optString("notes","");if(notes.length()>2000)throw new Exception("更新说明过长");
            message("发现新版 "+name+"，正在自动下载…\n"+notes);
            HttpURLConnection c=open(url,cookie);MessageDigest digest=MessageDigest.getInstance("SHA-256");long total=0,lastPercent=-1;
            try(InputStream in=c.getInputStream();FileOutputStream out=new FileOutputStream(partial)) {
                byte[] buffer=new byte[65536];int count;
                while((count=in.read(buffer))!=-1) {
                    if(cancelled)throw new Exception("已取消更新");
                    total+=count;if(total>size||total>UpdatePolicy.MAX_BYTES)throw new Exception("安装包大小不匹配");
                    out.write(buffer,0,count);digest.update(buffer,0,count);
                    long percent=total*100/size;
                    if(percent!=lastPercent){message("正在下载 "+name+" · "+percent+"%\n"+notes);lastPercent=percent;}
                }
            } finally {c.disconnect();connection=null;}
            if(total!=size||!hex(digest.digest()).equals(hash))throw new Exception("安装包下载不完整或校验失败，请重试");
            verifyArchive(partial,version);
            apk=new File(activity.getCacheDir(),"tv-update.apk");
            if(apk.exists()&&!apk.delete())throw new Exception("旧更新文件无法替换");
            if(!partial.renameTo(apk))throw new Exception("更新文件无法保存");
            if(cancelled)return;
            activity.runOnUiThread(()->{if(dialog==owner&&!cancelled){ready=release;install();}});
        } catch(Exception e) {
            message(e.getMessage()==null?"更新失败，请检查网络后重试":e.getMessage());
        } finally {
            partial.delete();HttpURLConnection c=connection;if(c!=null)c.disconnect();connection=null;
        }
    }
    private JSONObject readRelease(String site,String cookie) throws Exception {
        HttpURLConnection c=null;
        try {
            c=open(UpdatePolicy.origin(site).resolve("/updates/android-tv/latest"),cookie);
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()) {
                byte[] buffer=new byte[4096];int count;
                while((count=in.read(buffer))!=-1) {
                    if(cancelled)throw new Exception("已取消更新");
                    if(out.size()+count>16384)throw new Exception("更新信息过大");
                    out.write(buffer,0,count);
                }
                return new JSONObject(out.toString("UTF-8"));
            }
        } finally {HttpURLConnection active=c==null?connection:c;if(active!=null)active.disconnect();connection=null;}
    }
    static String hex(byte[] bytes) {
        StringBuilder value=new StringBuilder();for(byte b:bytes)value.append(String.format(java.util.Locale.US,"%02x",b&255));return value.toString();
    }
    private Set<String> signers(PackageInfo info) throws Exception {
        Set<String> set=new HashSet<>();
        if(info.signatures!=null)for(Signature s:info.signatures)set.add(hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray())));
        return set;
    }
    private void verifyArchive(File file,int expected) throws Exception {
        PackageManager pm=activity.getPackageManager();
        PackageInfo candidate=pm.getPackageArchiveInfo(file.getAbsolutePath(),PackageManager.GET_SIGNATURES);
        if(candidate==null)throw new Exception("安装包无法识别");
        PackageInfo installed=pm.getPackageInfo(activity.getPackageName(),PackageManager.GET_SIGNATURES);
        if(candidate.versionCode<=installed.versionCode)throw new Exception("已安装相同或更新版本");
        UpdatePolicy.archive(candidate.packageName,candidate.versionCode,expected,signers(installed),signers(candidate));
    }
    private void install() {
        if(ready==null||cancelled)return;
        try {
            verifyArchive(apk,ready.getInt("version_code"));
            boolean permissionNeeded=Build.VERSION.SDK_INT>=26&&!activity.getPackageManager().canRequestPackageInstalls();
            UpdateInstallFlow.Result result=UpdateInstallFlow.launch(permissionNeeded,this::openInstallScreen);
            waitingForPermission=result==UpdateInstallFlow.Result.PERMISSION_SETTINGS;
            if(waitingForPermission) status.setText("下载与校验完成。请在系统设置的安全/应用安装选项中允许 coding伴侣 TV 安装应用，返回后将打开安装页面。");
            else if(result==UpdateInstallFlow.Result.INSTALLER) {
                ready=null;status.setText("安装页面已打开，请按系统提示允许安装并用遥控器确认。若已取消，可关闭后重新检查。");
            } else {
                ready=null;status.setText("安装包已下载并校验，但此固件未提供可用安装入口。请使用设备自带的应用安装功能手动更新。");
            }
        } catch(Exception e) {status.setText("无法打开安装页面："+(e.getMessage()==null?"此设备不支持应用内安装":e.getMessage()));ready=null;}
    }
    private boolean openInstallScreen(int target) {
        Intent intent;
        if(target==UpdateInstallFlow.APP_SOURCES) intent=new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName()));
        else if(target==UpdateInstallFlow.SECURITY_SETTINGS) intent=new Intent(Settings.ACTION_SECURITY_SETTINGS);
        else if(target==UpdateInstallFlow.SETTINGS) intent=new Intent(Settings.ACTION_SETTINGS);
        else {
            intent=new Intent(target==UpdateInstallFlow.VIEW_APK?Intent.ACTION_VIEW:Intent.ACTION_INSTALL_PACKAGE)
                .setDataAndType(UpdateApkProvider.uri(),"application/vnd.android.package-archive");
            intent.setClipData(ClipData.newRawUri("电视更新",UpdateApkProvider.uri()));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        try {activity.startActivity(intent);return true;}
        catch(ActivityNotFoundException|SecurityException e) {return false;}
    }
    void resume() {
        if(!waitingForPermission||ready==null||cancelled)return;
        waitingForPermission=false;
        if(Build.VERSION.SDK_INT<26||activity.getPackageManager().canRequestPackageInstalls())install();
        else {status.setText("尚未允许安装应用。请在系统设置中允许后，关闭并重新检查更新。");ready=null;}
    }
    void destroy() {destroyed=true;cancelled=true;manualAfterCheck=null;HttpURLConnection c=connection;if(c!=null)c.disconnect();if(dialog!=null)dialog.dismiss();}
}
