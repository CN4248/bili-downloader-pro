package com.bilidl.engine;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONObject;

/** 链接识别：视频 / 图文 / 专栏 / 动态 / 空间 / 短链。 */
public final class Links {
    public static final Pattern URL_RE =
            Pattern.compile("(?:https?://)?(?:[\\w-]+\\.)+[a-z]{2,}(?::\\d+)?/[^\\s\"'<>()\\[\\]{}，。；、】]+", Pattern.CASE_INSENSITIVE);
    public static final Pattern BV_RE = Pattern.compile("BV[0-9A-Za-z]{10}");
    public static final Pattern AV_RE = Pattern.compile("av(\\d{1,12})", Pattern.CASE_INSENSITIVE);
    public static final Pattern OPUS_RE = Pattern.compile("/opus/(\\d{6,})");
    public static final Pattern CV_RE = Pattern.compile("/read/cv(\\d{1,12})");
    public static final Pattern DYN_RE = Pattern.compile("t\\.bilibili\\.com/(\\d{15,})");
    public static final Pattern SPACE_RE = Pattern.compile("space\\.bilibili\\.com/(\\d{1,12})");

    private Links() {}

    /** 解析结果。kind: video|opus|article|dynamic|space */
    public static class Target {
        public String kind;
        public String ident;
        public String url;
        public String mid;       // space 时有效
        public String tab;       // space: video|opus
        public Map<String, Object> extra = new LinkedHashMap<>();
        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            o.put("kind", kind);
            o.put("ident", ident);
            o.put("url", url);
            if (mid != null) o.put("mid", mid);
            if (tab != null) o.put("tab", tab);
            for (Map.Entry<String, Object> e : extra.entrySet()) o.put(e.getKey(), e.getValue());
            return o;
        }
    }

    public static List<String> extract(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        for (String line : text.split("[\\s,，;；]+")) {
            String t = line.trim();
            if (t.isEmpty()) continue;
            Matcher m = URL_RE.matcher(t);
            if (m.find()) out.add(m.group());
            else if (BV_RE.matcher(t).find()) out.add("https://www.bilibili.com/video/" + BV_RE.matcher(t).group());
        }
        return out;
    }

    public static Target parse(Http http, String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) throw new Errors.ParseError("链接为空");
        if (!url.startsWith("http")) {
            Matcher bv = BV_RE.matcher(url);
            if (bv.find()) url = "https://www.bilibili.com/video/" + bv.group();
            else throw new Errors.ParseError("无法识别的链接：" + raw);
        }
        if (isShort(url)) url = expand(http, url);
        Target t = new Target();
        t.url = url;
        Matcher sp = SPACE_RE.matcher(url);
        if (sp.find()) {
            t.kind = "space";
            t.mid = sp.group(1);
            t.ident = t.mid;
            t.tab = (url.contains("/upload/opus") || url.contains("/article")) ? "opus" : "video";
            return t;
        }
        Matcher bv = BV_RE.matcher(url);
        if (bv.find()) { t.kind = "video"; t.ident = bv.group(); return t; }
        Matcher av = AV_RE.matcher(url);
        if (av.find()) { t.kind = "video"; t.ident = "av" + av.group(1); return t; }
        Matcher op = OPUS_RE.matcher(url);
        if (op.find()) { t.kind = "opus"; t.ident = op.group(1); return t; }
        Matcher cv = CV_RE.matcher(url);
        if (cv.find()) { t.kind = "article"; t.ident = cv.group(1); return t; }
        Matcher dy = DYN_RE.matcher(url);
        if (dy.find()) { t.kind = "dynamic"; t.ident = dy.group(1); return t; }
        throw new Errors.ParseError("无法识别的链接：" + raw);
    }

    public static boolean isShort(String url) {
        for (String host : Const.SHORT_HOSTS) if (url.contains("//" + host) || url.contains("://" + host)) return true;
        return false;
    }

    /** 跟随 30x 还原短链。 */
    public static String expand(Http http, String shortUrl) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(shortUrl).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("User-Agent", Const.UA);
            int code = conn.getResponseCode();
            String loc = conn.getHeaderField("Location");
            conn.disconnect();
            if (loc != null && (code == 301 || code == 302 || code == 303 || code == 307 || code == 308)) {
                if (loc.startsWith("/")) loc = "https://" + new URL(shortUrl).getHost() + loc;
                return expand(http, loc);
            }
            return shortUrl;
        } catch (IOException e) {
            throw new Errors.ParseError("短链解析失败：" + e.getMessage());
        }
    }
}
