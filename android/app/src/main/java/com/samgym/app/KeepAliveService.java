package com.samgym.app;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.os.*;
import android.system.Os;
import android.util.Log;
import java.io.*;

/** خدمة أمامية تُبقي الخادم (Node) وبرنامج Tailscale يعملان في الخلفية. */
public class KeepAliveService extends Service {
    static final String TAG = "SAMGYM";
    static volatile boolean nodeStarted = false;
    static volatile Process helper = null;
    private PowerManager.WakeLock wl;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder nb;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel("srv", "Server", NotificationManager.IMPORTANCE_LOW));
            nb = new Notification.Builder(this, "srv");
        } else nb = new Notification.Builder(this);
        PendingIntent pi = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), 0);
        nb.setContentTitle("Smart Gym Manager").setContentText("الخادم يعمل").setSmallIcon(android.R.drawable.ic_dialog_info).setContentIntent(pi).setOngoing(true);
        startForeground(1, nb.build());
        if (wl == null) {
            wl = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "samgym:server");
            wl.acquire();
        }
        startNodeOnce();
        startHelper();
        return START_STICKY;
    }

    private void startNodeOnce() {
        if (nodeStarted) return;
        nodeStarted = true;
        final Context c = getApplicationContext();
        Thread t = new Thread(null, () -> {
            try {
                File project = Assets.ensure(c, BuildConfig.VERSION_CODE);
                File data = new File(c.getFilesDir(), "data"); data.mkdirs();
                File tmp = new File(c.getCacheDir(), "tmp"); tmp.mkdirs();
                Os.setenv("PORT", "3000", true);
                Os.setenv("DATA_DIR", data.getAbsolutePath(), true);
                Os.setenv("TS_HELPER", "http://127.0.0.1:3001", true);
                Os.setenv("HOME", c.getFilesDir().getAbsolutePath(), true);
                Os.setenv("TMPDIR", tmp.getAbsolutePath(), true);
                int rc = NodeBridge.startNode(new String[]{"node", new File(project, "android-main.js").getAbsolutePath()});
                Log.e(TAG, "node exited " + rc);
            } catch (Throwable e) { Log.e(TAG, "node failed", e); }
            nodeStarted = false;
        }, "node", 4 * 1024 * 1024);
        t.start();
    }

    private void startHelper() {
        if (helper != null) return;
        final Context c = getApplicationContext();
        Thread t = new Thread(() -> {
            while (true) {
                try {
                    File bin = new File(c.getApplicationInfo().nativeLibraryDir, "libtsfunnel.so");
                    if (!bin.exists()) { Log.e(TAG, "libtsfunnel.so غير موجود"); return; }
                    File state = new File(c.getFilesDir(), "ts-state"); state.mkdirs();
                    ProcessBuilder pb = new ProcessBuilder(bin.getAbsolutePath(), "-state", state.getAbsolutePath(),
                            "-target", "127.0.0.1:3000", "-control", "127.0.0.1:3001", "-hostname", "samgym");
                    pb.environment().put("HOME", c.getFilesDir().getAbsolutePath());
                    pb.environment().put("TMPDIR", c.getCacheDir().getAbsolutePath());
                    pb.redirectErrorStream(true);
                    helper = pb.start();
                    BufferedReader r = new BufferedReader(new InputStreamReader(helper.getInputStream()));
                    String line; while ((line = r.readLine()) != null) Log.i("SAMGYM-TS", line);
                    helper.waitFor();
                } catch (Throwable e) { Log.e(TAG, "helper", e); }
                helper = null;
                try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
            }
        }, "tsfunnel");
        t.setDaemon(true); t.start();
    }

    @Override public void onDestroy() { if (wl != null && wl.isHeld()) wl.release(); super.onDestroy(); }
}
