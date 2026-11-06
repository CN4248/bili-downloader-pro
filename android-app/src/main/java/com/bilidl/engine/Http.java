package com.bilidl.engine;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.function.BooleanSupplier;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.zip.GZIPInputStream;

import org.json.JSONObject;

/**
 * B站会话：Cookie、节流、重试、下载。
 * 所有 API 请求串行并保持 apiInterval 秒间隔（带抖动），避免触发风控。
 */
public class Http {
    public interface Progress {
        void onProgress(long done, long total);
    }

    private final File cookieFile;
    private final Map<String, String> cookies = new LinkedHashMap<>();
    private final Random rnd = new Random();
    private final Object lock = new Object();
    private long lastRequest = 0L;

    public double apiInterval = 1.2;

    /** 最近一次 API 失败时间（毫秒），上层据此整体降速。 */
    public volatile long coolDownUntil = 0L;

    public Http(File dataDir) {
        this.cookieFile = new File(dataDir, "cookie.txt");
        loadCookie();
    }

    // ---------- Cookie ----------

    public static Map<String, String> parseCookie(String text) {
        Map<String, String> out = new LinkedHashMap<>();
        if (text == null) return out;
        String t = text.trim();
        if (t.isEmpty()) return out;
        if (t.startsWith("[") || t.startsWith("{")) {
            try {
                if (t.startsWith("[")) {
                    org.json.JSONArray arr = new org.json.JSONArray(t);
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject o = arr.optJSONObject(i);
                        if (o != null && o.has("name")) out.put(o.optString("name"), o.optString("value"));
                    }
                } else {
                    JSONObject o = new JSONObject(t);
                    java.util.Iterator<String> it = o.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        out.put(k, String.valueOf(o.get(k)));
                    }
                }
                return out;
            } catch (Exception ignored) {
                // 退回按键值对解析
            }
        }
        for (String part : t.replace('\n', ';').split(";")) {
            String p = part.trim();
            int eq = p.indexOf('=');
            if (eq <= 0) continue;
            String k = p.substring(0, eq).trim();
            String v = p.substring(eq + 1).trim();
            String lk = k.toLowerCase();
            if (lk.equals("cookie") || lk.equals("path") || lk.equals("domain") || lk.equals("expires")) continue;
            out.put(k, v);
        }
        return out;
    }

    public synchronized void setCookie(String text) {
        Map<String, String> parsed = parseCookie(text);
        cookies.clear();
        cookies.putAll(parsed);
        saveCookie();
    }

    public synchronized Map<String, String> cookieMap() {
        return new LinkedHashMap<>(cookies);
    }

    public synchronized String cookieHeader() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : cookies.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    public synchronized boolean hasCookie() {
        String s = cookies.get("SESSDATA");
        return s != null && !s.isEmpty();
    }

    public synchronized void clearCookie() {
        cookies.clear();
        saveCookie();
    }

    private void loadCookie() {
        try {
            if (!cookieFile.exists()) return;
            String text = new String(Files.readAllBytes(cookieFile.toPath()), StandardCharsets.UTF_8);
            cookies.putAll(parseCookie(text));
        } catch (IOException ignored) {
        }
    }

    public synchronized void saveCookie() {
        try {
            if (cookieFile.getParentFile() != null) cookieFile.getParentFile().mkdirs();
            Files.write(cookieFile.toPath(), cookieHeader().getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    // ---------- 请求 ----------

    public void throttle() {
        long wait;
        synchronized (lock) {
            long now = System.currentTimeMillis();
            long gap = (long) (apiInterval * 1000 + rnd.nextInt(400));
            long next = lastRequest + gap;
            wait = Math.max(0, next - now);
            lastRequest = Math.max(now, next);
        }
        if (wait > 0) {
            try { Thread.sleep(wait); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    private HttpURLConnection open(String url, String referer, boolean useCookie) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setRequestProperty("User-Agent", Const.UA);
        conn.setRequestProperty("Accept", "application/json, text/plain, */*");
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
        conn.setRequestProperty("Accept-Encoding", "gzip, deflate");
        if (referer != null && !referer.isEmpty()) conn.setRequestProperty("Referer", referer);
        if (useCookie) {
            String ck = cookieHeader();
            if (!ck.isEmpty()) conn.setRequestProperty("Cookie", ck);
        }
        return conn;
    }

    public String getText(String url, String referer, boolean useCookie) throws IOException {
        throttle();
        HttpURLConnection conn = open(url, referer, useCookie);
        try {
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) throw new IOException("HTTP " + code);
            if ("gzip".equalsIgnoreCase(conn.getContentEncoding())) in = new GZIPInputStream(in);
            return readAll(in);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 调用 api.bilibili.com 的 GET 接口，返回整个响应对象。 */
    public JSONObject api(String path, Map<String, String> params, String referer) {
        String url = path.startsWith("http") ? path : Const.API + path;
        String full = withQuery(url, params);
        for (int attempt = 0; attempt < Const.MAX_API_RETRY + 1; attempt++) {
            try {
                JSONObject root = readRoot(full, referer);
                int code = root.optInt("code", -1);
                if (code == 0) return root;
                if (isRisk(code)) {
                    backoff(attempt);
                    continue;
                }
                throw mapError(code, root.optString("message", ""));
            } catch (IOException e) {
                if (attempt >= Const.MAX_API_RETRY) throw new Errors.BiliError("请求失败：" + e.getMessage());
                backoff(attempt);
            }
        }
        throw new Errors.RiskControl("风控限制，请稍后再试");
    }

    public JSONObject readRoot(String fullUrl, String referer) throws IOException {
        String text = getText(fullUrl, referer, true);
        try {
            return new JSONObject(text);
        } catch (Exception e) {
            throw new IOException("响应不是 JSON：" + text.substring(0, Math.min(120, text.length())));
        }
    }

    public static String withQuery(String url, Map<String, String> params) {
        if (params == null || params.isEmpty()) return url;
        List<String> keys = new ArrayList<>(params.keySet());
        Collections.sort(keys);
        StringBuilder sb = new StringBuilder(url);
        sb.append(url.contains("?") ? '&' : '?');
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) sb.append('&');
            try {
                sb.append(URLEncoder.encode(keys.get(i), "UTF-8")).append('=')
                  .append(URLEncoder.encode(params.get(keys.get(i)), "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return sb.toString();
    }

    /** App 端接口（带 AppKey 签名），可绕开 Web 的 WBI 风控。 */
    public JSONObject appApi(String url, Map<String, String> params) {
        Map<String, String> p = new LinkedHashMap<>(params);
        p.put("appkey", Const.APP_KEY);
        p.put("ts", String.valueOf(System.currentTimeMillis() / 1000));
        p.put("mobi_app", Const.APP_MOBI_APP);
        p.put("platform", Const.APP_MOBI_APP);
        p.put("build", Const.APP_BUILD);
        p.put("sign", appSign(p));
        JSONObject root = api(url, p, Const.SITE + "/");
        return root;
    }

    public static String appSign(Map<String, String> params) {
        List<String> keys = new ArrayList<>(params.keySet());
        Collections.sort(keys);
        StringBuilder sb = new StringBuilder();
        for (String k : keys) {
            if (sb.length() > 0) sb.append('&');
            sb.append(k).append('=').append(params.get(k));
        }
        sb.append(Const.APP_SEC);
        return md5(sb.toString());
    }

    public static String md5(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private boolean isRisk(int code) {
        for (int c : Const.RISK_CODES) if (c == code) return true;
        return false;
    }

    private Errors.BiliError mapError(int code, String msg) {
        for (int c : Const.COOKIE_FAILURE_CODES) if (c == code) return new Errors.AuthRequired(msg.isEmpty() ? "需要登录" : msg);
        if (code == -404 || code == 62002 || code == 62004) return new Errors.NotFound(msg.isEmpty() ? "内容不存在" : msg);
        return new Errors.BiliError((msg.isEmpty() ? "接口错误" : msg) + "（code " + code + "）", code);
    }

    private void backoff(int attempt) {
        int idx = Math.min(attempt, Const.RISK_BACKOFF.length - 1);
        long ms = Const.RISK_BACKOFF[idx] * 1000L;
        coolDownUntil = System.currentTimeMillis() + ms;
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    public boolean cooling() {
        return System.currentTimeMillis() < coolDownUntil;
    }

    // ---------- 下载 ----------

    public long download(String url, File dest, String referer, Progress cb) {
        return download(url, dest, referer, cb, null);
    }

    /** 带取消检查的下载：stop 返回 true 时立刻中断（取消全部用）。 */
    public long download(String url, File dest, String referer, Progress cb, BooleanSupplier stop) {
        File part = new File(dest.getAbsolutePath() + ".part");
        File dir = dest.getParentFile();
        if (dir != null) dir.mkdirs();
        long existing = part.exists() ? part.length() : 0;
        try {
            HttpURLConnection conn = open(url, referer, false);
            if (existing > 0) conn.setRequestProperty("Range", "bytes=" + existing + "-");
            int code = conn.getResponseCode();
            if (code == 416) { existing = 0; conn.disconnect(); return download(url, dest, referer, cb, stop); }
            if (code >= 400) throw new IOException("HTTP " + code);
            long total = conn.getContentLengthLong();
            if (code != 206) existing = 0;
            if (total > 0 && existing > 0) total += existing;
            InputStream in = new BufferedInputStream(conn.getInputStream());
            long done = existing;
            try (RandomAccessFile raf = new RandomAccessFile(part, existing > 0 ? "rw" : "rw")) {
                raf.seek(existing);
                byte[] buf = new byte[Const.CHUNK_SIZE];
                int n;
                long lastCb = 0;
                while ((n = in.read(buf)) > 0) {
                    if (stop != null && stop.getAsBoolean()) throw new Errors.DownloadError("已取消");
                    raf.write(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (cb != null && now - lastCb > 300) { lastCb = now; cb.onProgress(done, total); }
                }
            } finally {
                in.close();
                conn.disconnect();
            }
            if (cb != null) cb.onProgress(done, total > 0 ? total : done);
            if (dest.exists()) dest.delete();
            if (!part.renameTo(dest)) {
                try (InputStream fi = new FileInputStream(part); OutputStream fo = new FileOutputStream(dest)) {
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = fi.read(b)) > 0) fo.write(b, 0, n);
                }
                part.delete();
            }
            return dest.length();
        } catch (IOException e) {
            throw new Errors.DownloadError("下载失败：" + e.getMessage());
        }
    }
}
