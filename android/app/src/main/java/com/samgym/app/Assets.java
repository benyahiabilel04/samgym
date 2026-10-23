package com.samgym.app;

import android.content.Context;
import android.content.res.AssetManager;
import java.io.*;

/** ينسخ مشروع Node من assets إلى ذاكرة التطبيق عند أول تشغيل أو عند التحديث. */
class Assets {
    static File ensure(Context c, int version) throws IOException {
        File root = new File(c.getFilesDir(), "node-project");
        File mark = new File(c.getFilesDir(), "node-project.version");
        String v = String.valueOf(version);
        boolean ok = false;
        try { if (mark.exists()) { BufferedReader r = new BufferedReader(new FileReader(mark)); ok = v.equals(r.readLine()); r.close(); } } catch (Exception e) {}
        if (!ok || !root.exists()) {
            deleteRec(root);
            copy(c.getAssets(), "node", root);
            FileWriter w = new FileWriter(mark); w.write(v); w.close();
        }
        return root;
    }
    private static void copy(AssetManager am, String path, File dst) throws IOException {
        String[] list = am.list(path);
        if (list != null && list.length > 0) {
            dst.mkdirs();
            for (String n : list) copy(am, path + "/" + n, new File(dst, n));
        } else {
            dst.getParentFile().mkdirs();
            try (InputStream in = am.open(path); OutputStream out = new FileOutputStream(dst)) {
                byte[] b = new byte[65536]; int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
            }
        }
    }
    private static void deleteRec(File f) {
        if (f.isDirectory()) { File[] l = f.listFiles(); if (l != null) for (File x : l) deleteRec(x); }
        f.delete();
    }
}
