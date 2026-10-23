package com.samgym.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.*;
import android.widget.*;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    static final String HOME = "http://localhost:3000/";
    WebView web; TextView msg; ValueCallback<Uri[]> fileCb; PermissionRequest pendingPerm;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        msg = new TextView(this);
        msg.setText("جارٍ تشغيل الخادم…\nSAM GYM"); msg.setTextSize(18); msg.setGravity(android.view.Gravity.CENTER);
        root.addView(web, new ViewGroup.LayoutParams(-1, -1));
        root.addView(msg, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false); s.setDatabaseEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("localhost".equals(u.getHost()) || "127.0.0.1".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) {}
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(p.createIntent(), 77); } catch (Exception e) { fileCb = null; return false; }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest req) {
                runOnUiThread(() -> {
                    String[] need = new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO};
                    boolean all = true;
                    for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) all = false;
                    if (all) req.grant(req.getResources()); else { pendingPerm = req; requestPermissions(need, 78); }
                });
            }
        });

        Intent svc = new Intent(this, KeepAliveService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
        askBatteryExemption();
        waitServer();
    }

    void askBatteryExemption() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            }
        } catch (Exception e) {}
    }

    void waitServer() {
        new Thread(() -> {
            for (int i = 0; i < 120; i++) {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:3000/api/ping").openConnection();
                    c.setConnectTimeout(800); c.setReadTimeout(1500);
                    if (c.getResponseCode() == 200) { runOnUiThread(() -> { msg.setVisibility(View.GONE); web.loadUrl(HOME); }); return; }
                } catch (Exception e) {}
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
            }
            runOnUiThread(() -> msg.setText("تعذر تشغيل الخادم.\nأغلق التطبيق وافتحه من جديد."));
        }).start();
    }

    @Override protected void onActivityResult(int rc, int res, Intent d) {
        if (rc == 77 && fileCb != null) { fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, d)); fileCb = null; }
        else super.onActivityResult(rc, res, d);
    }
    @Override public void onRequestPermissionsResult(int rc, String[] p, int[] r) {
        if (rc == 78 && pendingPerm != null) {
            boolean ok = false; for (int x : r) if (x == PackageManager.PERMISSION_GRANTED) ok = true;
            if (ok) pendingPerm.grant(pendingPerm.getResources()); else pendingPerm.deny();
            pendingPerm = null;
        }
    }
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else moveTaskToBack(true); }
}
