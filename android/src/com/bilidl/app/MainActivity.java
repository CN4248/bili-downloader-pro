package com.bilidl.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

/**
 * BiliDL 手机端：BiliDL 后端（WebUI）的原生外壳。
 *
 * 手机不跑 Python，只负责连接你局域网 / 公网上的 BiliDL 服务：
 * 粘贴链接、选分集 / 合集 / 图文、看进度，全部沿用同一套 WebUI。
 *
 * 注意：本文件刻意不使用匿名内部类（javac 21 生成的匿名类会让 build-tools 34 的
 * d8/R8 8.2 崩溃），改用 lambda 与具名静态内部类。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "bilidl";
    private static final String KEY_SERVER = "server";

    private WebView webView;
    private EditText serverInput;
    private ProgressBar progress;
    private String pendingLinks;

    /** 页面跳转：http(s) 留在 WebView 内，其它协议交给系统。 */
    static class PageClient extends WebViewClient {
        private final MainActivity activity;

        PageClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                return false;
            }
            activity.openExternal(url);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            activity.progress.setVisibility(View.GONE);
        }
    }

    /** 顶部进度条。 */
    static class PageChrome extends WebChromeClient {
        private final ProgressBar bar;

        PageChrome(ProgressBar bar) {
            this.bar = bar;
        }

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            bar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            bar.setProgress(newProgress);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0d1117"));

        // ---------------------------------------------------------- 顶部工具条
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(8), dp(6), dp(8), dp(6));
        bar.setBackgroundColor(Color.parseColor("#161b22"));

        serverInput = new EditText(this);
        serverInput.setHint("http://192.168.1.100:2196");
        serverInput.setTextColor(Color.parseColor("#e6edf3"));
        serverInput.setHintTextColor(Color.parseColor("#6e7681"));
        serverInput.setTextSize(12);
        serverInput.setSingleLine(true);
        serverInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        serverInput.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button go = new Button(this);
        go.setText("连接");
        go.setTextSize(12);
        go.setOnClickListener(v -> connect(serverInput.getText().toString()));

        Button refresh = new Button(this);
        refresh.setText("刷新");
        refresh.setTextSize(12);
        refresh.setOnClickListener(v -> webView.reload());

        bar.addView(serverInput);
        bar.addView(go);
        bar.addView(refresh);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setVisibility(View.GONE);

        // ------------------------------------------------------------- WebView
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
        }

        webView.setWebViewClient(new PageClient(this));
        webView.setWebChromeClient(new PageChrome(progress));

        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(progress, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        // -------------------------------------------------------------- 启动
        handleIntent(getIntent());
        String saved = prefs().getString(KEY_SERVER, "");
        if (saved == null || saved.isEmpty()) {
            promptServer();
        } else {
            serverInput.setText(saved);
            connect(saved);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
        if (webView != null && pendingLinks != null) {
            String server = normalize(prefs().getString(KEY_SERVER, ""));
            if (!server.isEmpty()) {
                connect(server);
            }
        }
    }

    /** 接收 B站 App「分享 → BiliDL」过来的文字（通常就是链接）。 */
    private void handleIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && !text.trim().isEmpty()) {
                pendingLinks = text.trim();
            }
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            pendingLinks = intent.getData().toString();
        }
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // 没有可处理的应用就忽略
        }
    }

    private void promptServer() {
        final EditText input = new EditText(this);
        input.setHint("例如 http://192.168.1.100:2196");
        input.setText("http://");
        input.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle("连接 BiliDL 服务")
                .setMessage("请填写运行 BiliDL 的电脑 / NAS 地址（默认端口 2196）。\n"
                        + "手机与它需在同一网络，或填公网地址。")
                .setView(input)
                .setPositiveButton("连接", (DialogInterface dialog, int which) ->
                        connect(input.getText().toString()))
                .setNegativeButton("稍后", null)
                .show();
    }

    private void connect(String raw) {
        String server = normalize(raw);
        if (server.isEmpty()) {
            promptServer();
            return;
        }
        serverInput.setText(server);
        prefs().edit().putString(KEY_SERVER, server).apply();
        hideKeyboard();

        String url = server + "/";
        if (pendingLinks != null && !pendingLinks.isEmpty()) {
            url += "?links=" + Uri.encode(pendingLinks);
            pendingLinks = null;
        }
        webView.loadUrl(url);
    }

    private static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty() || "http://".equals(s) || "https://".equals(s)) {
            return "";
        }
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            s = "http://" + s;
        }
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    private void hideKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                imm.hideSoftInputFromWindow(serverInput.getWindowToken(), 0);
            }
        } catch (Exception ignored) {
            // ignore
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
