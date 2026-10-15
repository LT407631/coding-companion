package net.codingcompanion.tv;

import android.app.Activity;
import android.content.Intent;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** TV shell for the existing private site. No credentials or JS-to-Java bridge. */
public final class MainActivity extends Activity {
    private static final String DEFAULT_SITE = "http://nas.local:8010";
    private static final int LOGIN_BACKGROUND = Color.rgb(245,246,248);
    private WebView web;
    private FrameLayout root;
    private View custom;
    private WebChromeClient.CustomViewCallback customCallback;
    private SharedPreferences prefs;
    private String site, adapter;
    private View errorView;
    private long exitAt;
    private NativePlayer nativePlayer;
    private TvUpdater updater;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        immersive();
        prefs = getSharedPreferences("tv", MODE_PRIVATE);
        site = prefs.getString("site", DEFAULT_SITE);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17,19,24));
        setContentView(root);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        web.setBackgroundColor(LOGIN_BACKGROUND);
        nativePlayer=new NativePlayer(this,root,web,site);
        updater=new TvUpdater(this);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString()+" CodingCompanionTV/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        try {
            adapter = "(function(){document.documentElement.classList.add('coding-tv-legacy');if(document.getElementById('coding-tv-style'))return;var s=document.createElement('style');s.id='coding-tv-style';s.textContent="+JSONObject.quote(asset("tv.css")+"\n"+asset("tv-phone-input.css")+"\n"+asset("tv-legacy.css"))+";document.head.appendChild(s);})();\n"+asset("tv-appearance.js")+"\n"+asset("tv-native.js")+"\n"+asset("tv-diagnostics.js")+"\n"+asset("tv-transition.js")+"\n"+asset("tv-hud.js")+"\n"+asset("tv-phone-input.js")+"\n"+asset("tv.js")+"\nwindow.CodingTVPhone.installKeys();";
        } catch (Exception e) { showError("电视适配文件无法读取，请重新安装 APK。"); return; }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return navigation(url); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest r) { return r.isForMainFrame() && navigation(r.getUrl().toString()); }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { pageBackground(url);hideError(); }
            @Override public void onPageFinished(WebView view, String url) {
                if (!allowed(url)) return;
                pageBackground(url);
                Uri page=Uri.parse(url);
                if ("/ui".equals(page.getPath()) && !"1".equals(page.getQueryParameter("compat"))) {
                    view.loadUrl(uiUrl());
                    return;
                }
                if (!"/ui".equals(page.getPath())) {
                    CookieManager.getInstance().flush();
                    return;
                }
                // TV firmware often reports a phone-sized CSS viewport even on a 4K panel.
                int width=Math.max(1280,Math.min(2560,view.getWidth()));
                float scale=view.getWidth()/getResources().getDisplayMetrics().density/width;
                view.evaluateJavascript("(function(){var m=document.querySelector('meta[name=viewport]');if(m)m.content='width="+width+",initial-scale="+scale+"';})();\n"+"window.CodingTVConnection={wan:"+JSONObject.quote(savedSites()[1])+"};\n"+adapter, null);
                CookieManager.getInstance().flush();
                nativePlayer.installDiagnostics();
                view.postDelayed(() -> view.evaluateJavascript("typeof W!=='undefined'", value -> {
                    if (!url.equals(view.getUrl()) || !allowed(view.getUrl())) return;
                    if ("true".equals(value)) updater.autoCheck(site);
                    else if ("false".equals(value) && errorView==null) showError("服务器已连接，但当前电视浏览器仍无法运行页面。请升级系统 WebView 或安装更新后的 APK。");
                }), 1200);
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if(r.isForMainFrame()) showError("连接网站失败。请确认电视和 NAS 网络互通，或选择下方修改服务器地址。");
            }
            @Override public void onReceivedError(WebView v, int code, String text, String url) {
                if(Build.VERSION.SDK_INT<23) showError("连接网站失败。请检查网络与服务器地址。");
            }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError e) {
                handler.cancel();
                showError("HTTPS 证书验证失败，请检查域名、电视日期和证书。不会忽略证书错误。");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if(custom!=null) {callback.onCustomViewHidden();return;}
                custom=view;customCallback=callback;
                root.addView(view,new FrameLayout.LayoutParams(-1,-1));
                web.setVisibility(View.INVISIBLE);
                view.requestFocus();immersive();
            }
            @Override public void onHideCustomView() { closeFullscreen(); }
        });
        nativePlayer.resume();web.loadUrl(uiUrl());
        web.requestFocus();
        if(!prefs.getBoolean("configured",false)) configure();
    }
    private boolean allowed(String url) {
        Uri u=Uri.parse(url), base=Uri.parse(site);
        int p=u.getPort()<0?("https".equals(u.getScheme())?443:80):u.getPort();
        int bp=base.getPort()<0?("https".equals(base.getScheme())?443:80):base.getPort();
        return base.getScheme().equals(u.getScheme()) && base.getHost().equalsIgnoreCase(u.getHost()==null?"":u.getHost()) && p==bp;
    }
    private void pageBackground(String url) {
        Uri page=Uri.parse(url==null?"":url);
        web.setBackgroundColor(url!=null&&allowed(url)&&"/ui".equals(page.getPath())?Color.TRANSPARENT:LOGIN_BACKGROUND);
    }
    private boolean navigation(String url) {
        if("codingtv://media".equals(url)) {nativePlayer.wake();return true;}
        if("codingtv://update".equals(url)) {if(allowed(web.getUrl()))updater.show(site);return true;}
        if("codingtv://settings".equals(url)) {configure();return true;}
        return !allowed(url);
    }
    private String asset(String name) throws Exception {
        try(InputStream in=getAssets().open(name);ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1) out.write(b,0,n);
            return out.toString("UTF-8");
        }
    }
    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY|View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
    private void closeFullscreen() {
        if(custom==null) return;
        root.removeView(custom);custom=null;
        web.setVisibility(View.VISIBLE);
        WebChromeClient.CustomViewCallback callback=customCallback;customCallback=null;
        if(callback!=null) callback.onCustomViewHidden();
        web.requestFocus();immersive();
    }
    private String[] savedSites(){return new String[]{prefs.getString("lan",DEFAULT_SITE),prefs.getString("wan","https://nas.example.com")};}
    private String uiUrl(){return site+"/ui?compat=1";}
    private void configure() {
        String[] urls=savedSites();final int[] selected={site.equals(urls[1])?1:0};
        String[] labels={"内网 · 家中\n"+urls[0],"外网 · 外出\n"+urls[1]};
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("选择已保存的网站地址")
            .setSingleChoiceItems(labels,selected[0],(d,n)->selected[0]=n)
            .setPositiveButton("连接",(d,n)->{
                site=urls[selected[0]];prefs.edit().putString("site",site).putBoolean("configured",true).apply();
                closeFullscreen();nativePlayer.setSite(site);hideError();web.loadUrl(uiUrl());web.requestFocus();
            }).setNeutralButton("编辑并保存地址",(d,n)->editAddress(selected[0])).setNegativeButton("关闭",null).create();
        dialog.show();dialog.getListView().setSelection(selected[0]);dialog.getListView().requestFocus();
    }
    private void editAddress(int slot) {
        EditText input=new EditText(this);
        input.setSingleLine(true);input.setText(savedSites()[slot]);input.setTextSize(22);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_URI);
        LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(32,16,32,16);
        TextView info=new TextView(this);info.setText("地址会保存在投影仪 / 电视中，下次直接选择。\n无需填写密码或 /ui；登录仍使用网站密码。");info.setTextSize(20);
        box.addView(info);box.addView(input);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("编辑并保存网站地址").setView(box).setPositiveButton("保存",null).setNegativeButton("取消",null).create();
        dialog.setOnShowListener(d -> dialog.getButton(-1).setOnClickListener(v -> {
            String value=input.getText().toString().trim();
            try {
                Uri uri=Uri.parse(value);
                if(!("http".equals(uri.getScheme())||"https".equals(uri.getScheme())) || uri.getHost()==null || uri.getUserInfo()!=null || uri.getFragment()!=null || uri.getQuery()!=null || uri.getPort()>65535) throw new IllegalArgumentException();
                String path=uri.getPath();
                if(path!=null&&!path.isEmpty()&&!"/".equals(path)&&!"/ui".equals(path)&&!"/ui/".equals(path)) throw new IllegalArgumentException();
                String saved=uri.buildUpon().path(null).query(null).fragment(null).build().toString();
                prefs.edit().putString(new String[]{"lan","wan"}[slot],saved).apply();
                dialog.dismiss();configure();
            } catch (Exception e) {input.setError("填写 http://IP:端口 或 https://域名:端口");}
        }));
        dialog.show();input.requestFocus();input.selectAll();
    }
    private void hideError() {if(errorView!=null) {root.removeView(errorView);errorView=null;}}
    private void showError(String text) {
        if(errorView!=null) return;
        LinearLayout box=new LinearLayout(this);box.setOrientation(1);box.setPadding(48,48,48,48);box.setBackgroundColor(Color.rgb(17,19,24));
        TextView message=new TextView(this);message.setText(text);message.setTextColor(Color.WHITE);message.setTextSize(26);box.addView(message);
        Button retry=new Button(this);retry.setText("重新连接");retry.setOnClickListener(v->{hideError();web.loadUrl(uiUrl());});box.addView(retry);
        Button address=new Button(this);address.setText("修改服务器地址");address.setOnClickListener(v->configure());box.addView(address);
        errorView=box;root.addView(box,new FrameLayout.LayoutParams(-1,-1));retry.requestFocus();
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        int code=event.getKeyCode();
        if(code==KeyEvent.KEYCODE_MENU) {
            if(event.getAction()==KeyEvent.ACTION_DOWN&&event.getRepeatCount()==0) {
                if(custom!=null) closeFullscreen();
                else if(errorView==null) web.evaluateJavascript("window.CodingTV && CodingTV.key(82)",null);
            }
            return true;
        }
        if(code==KeyEvent.KEYCODE_BACK) {
            if(event.getAction()==KeyEvent.ACTION_DOWN&&event.getRepeatCount()==0) onBackPressed();return true;
        }
        boolean remote=(code>=19&&code<=23)||code==66||(code>=85&&code<=90)||code==126||code==127;
        if(!remote||custom!=null||errorView!=null) return super.dispatchKeyEvent(event);
        if(event.getAction()!=KeyEvent.ACTION_DOWN) return true;
        if((code==23||code==66||code==85)&&event.getRepeatCount()>0) return true;
        web.evaluateJavascript("window.CodingTV ? CodingTV.key("+code+") : false", value -> {
            if(!"true".equals(value)) {
                web.dispatchKeyEvent(event);
                web.dispatchKeyEvent(KeyEvent.changeAction(event,KeyEvent.ACTION_UP));
            }
        });
        return true;
    }
    @Override public void onBackPressed() {
        if(custom!=null) {closeFullscreen();return;}
        web.evaluateJavascript("window.CodingTV ? CodingTV.back() : false", value -> {
            if("true".equals(value)) return;
            if(System.currentTimeMillis()-exitAt<2000) finish();
            else {exitAt=System.currentTimeMillis();Toast.makeText(this,"再次按返回退出；网站地址可在设置中修改",Toast.LENGTH_SHORT).show();}
        });
    }
    @Override protected void onPause() {
        if(web!=null) {web.evaluateJavascript("window.CodingTV && CodingTV.suspend()",null);web.onPause();CookieManager.getInstance().flush();
                nativePlayer.installDiagnostics();}
        if(nativePlayer!=null)nativePlayer.suspend();super.onPause();
    }
    @Override protected void onResume() {super.onResume();if(web!=null) web.onResume();if(nativePlayer!=null)nativePlayer.resume();if(updater!=null)updater.resume();immersive();}
    @Override protected void onDestroy() {if(updater!=null)updater.destroy();if(nativePlayer!=null)nativePlayer.destroy();if(web!=null) {closeFullscreen();root.removeView(web);web.destroy();}super.onDestroy();}
}
