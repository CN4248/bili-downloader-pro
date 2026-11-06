package com.bilidl.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Environment;
import android.os.PowerManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.bilidl.engine.Engine;
import com.bilidl.engine.Server;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** 单 Activity：内置引擎 + 本地 WebUI，全程不需要电脑。 */
public class MainActivity extends Activity {
    private static final String TAG = "BiliDL";
    private WebView web;
    private Engine engine;
    private Server server;
    private int port = 2196;
    private PowerManager.WakeLock wakeLock;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.setWebViewClient(new LocalClient(this));

        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BiliDL:download");
            wakeLock.acquire();
        } catch (Exception ignored) {
        }
        requestStorage();
        new Thread(this::boot, "bilidl-boot").start();
    }

    /** 申请「所有文件访问权限」，失败就退回 App 私有目录。 */
    private void requestStorage() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                if (!Environment.isExternalStorageManager()) {
                    Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                            Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                }
            } else if (Build.VERSION.SDK_INT >= 23) {
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE,
                            Manifest.permission.READ_EXTERNAL_STORAGE}, 1);
                }
            }
        } catch (Exception ignored) {
        }
    }

    /** 公共下载目录是否可写。 */
    private static File publicRoot() {
        File f = new File(Environment.getExternalStorageDirectory(), "Download/BiliDL");
        try {
            f.mkdirs();
            File probe = new File(f, ".w");
            if (probe.exists() || probe.createNewFile()) {
                probe.delete();
                return f;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 命名内部类（而不是匿名类）：d8 8.2 处理匿名类会 NPE。 */
    private static class LocalClient extends WebViewClient {
        private final Activity act;
        LocalClient(Activity act) { this.act = act; }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url.startsWith("http://127.0.0.1")) return false;
            try {
                act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    private void boot() {
        try {
            File data = new File(getFilesDir(), "data");
            data.mkdirs();
            File webRoot = new File(getFilesDir(), "web");
            copyAssets("web", webRoot);
            engine = new Engine(data);
            File pub = publicRoot();
            boolean firstRun = !new File(data, "settings.json").exists();
            if (firstRun) {
                File root = pub != null ? pub : new File(getExternalFilesDir(null), "BiliDL");
                engine.settings.videoDir = new File(root, "视频").getAbsolutePath();
                engine.settings.opusDir = new File(root, "图文").getAbsolutePath();
                engine.saveSettings();
            }
            server = new Server(engine, webRoot);
            server.start(2196, "127.0.0.1");
            port = server.port;
            runOnUiThread(() -> web.loadUrl("http://127.0.0.1:" + port + "/"));
        } catch (Exception e) {
            Log.e(TAG, "启动失败", e);
            final String msg = String.valueOf(e.getMessage());
            runOnUiThread(() -> {
                Toast.makeText(this, "启动失败：" + msg, Toast.LENGTH_LONG).show();
                web.loadData("<h3 style='color:#f66;font-family:sans-serif;padding:20px'>启动失败：" + msg + "</h3>",
                        "text/html", "utf-8");
            });
        }
    }

    private void copyAssets(String assetPath, File target) throws IOException {
        String[] list = getAssets().list(assetPath);
        if (list == null) return;
        if (list.length == 0) {
            copyFile(assetPath, target);
            return;
        }
        target.mkdirs();
        for (String name : list) {
            copyAssets(assetPath + "/" + name, new File(target, name));
        }
    }

    private void copyFile(String assetPath, File dest) throws IOException {
        if (dest.exists() && dest.length() > 0) return;
        dest.getParentFile().mkdirs();
        try (InputStream in = getAssets().open(assetPath); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (web != null && web.canGoBack()) { web.goBack(); return true; }
            moveTaskToBack(true);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (server != null) server.stop();
        if (engine != null) engine.shutdown();
        super.onDestroy();
    }
}
