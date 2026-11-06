package com.bilidl.engine;

import java.io.File;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

/** B站接口封装。 */
public class Api {
    private final Http http;

    public Api(Http http) { this.http = http; }

    // ---------- 数据结构 ----------

    public static class Page {
        public int index, duration;
        public long cid;
        public String part = "";
    }

    public static class SeasonEp {
        public String bvid = "", title = "";
        public long cid;
        public int duration, page = 1;
    }

    public static class VideoInfo {
        public String bvid = "", aid = "", title = "", cover = "", desc = "", pubdate = "";
        public String ownerName = "", ownerMid = "";
        public List<Page> pages = new ArrayList<>();
        public List<SeasonEp> season = new ArrayList<>();
        public String seasonTitle = "";
    }

    public static class OpusInfo {
        public String ident = "", title = "", author = "", pubdate = "";
        public List<String> images = new ArrayList<>();
        public String text = "";
    }

    public static class SpaceItem {
        public String kind, ident, title = "", cover = "", date = "";
        public int duration;
    }

    public static class UserCard {
        public String mid = "", name = "", face = "", sign = "";
        public int fans;
    }

    // ---------- 视频 ----------

    public VideoInfo video(String ident) {
        Map<String, String> p = new LinkedHashMap<>();
        if (ident.startsWith("av")) p.put("aid", ident.substring(2));
        else p.put("bvid", ident);
        JSONObject root = http.api("/x/web-interface/view", p, Const.SITE + "/");
        JSONObject d = root.optJSONObject("data");
        if (d == null) throw new Errors.NotFound("视频不存在");
        VideoInfo v = new VideoInfo();
        v.bvid = d.optString("bvid");
        v.aid = d.optString("aid");
        v.title = d.optString("title");
        v.cover = d.optString("pic");
        v.desc = d.optString("desc");
        v.pubdate = d.optLong("pubdate", 0) > 0 ? fmtDate(d.optLong("pubdate")) : "";
        JSONObject owner = d.optJSONObject("owner");
        if (owner != null) {
            v.ownerName = owner.optString("name");
            v.ownerMid = owner.optString("mid");
        }
        JSONArray pages = d.optJSONArray("pages");
        if (pages != null) {
            for (int i = 0; i < pages.length(); i++) {
                JSONObject pg = pages.optJSONObject(i);
                if (pg == null) continue;
                Page pp = new Page();
                pp.index = pg.optInt("page", i + 1);
                pp.cid = pg.optLong("cid");
                pp.part = pg.optString("part");
                pp.duration = pg.optInt("duration");
                v.pages.add(pp);
            }
        }
        JSONObject season = d.optJSONObject("ugc_season");
        if (season != null) {
            v.seasonTitle = season.optString("title");
            JSONArray sections = season.optJSONArray("sections");
            if (sections != null) {
                for (int i = 0; i < sections.length(); i++) {
                    JSONObject sec = sections.optJSONObject(i);
                    JSONArray eps = sec == null ? null : sec.optJSONArray("episodes");
                    if (eps == null) continue;
                    for (int j = 0; j < eps.length(); j++) {
                        JSONObject ep = eps.optJSONObject(j);
                        if (ep == null) continue;
                        SeasonEp e = new SeasonEp();
                        e.bvid = ep.optString("bvid");
                        e.title = ep.optString("title");
                        e.cid = ep.optLong("cid");
                        JSONObject pg = ep.optJSONObject("page");
                        if (pg != null) { e.page = pg.optInt("page", 1); e.duration = pg.optInt("duration"); }
                        if (e.cid <= 0) continue;
                        v.season.add(e);
                    }
                }
            }
        }
        if (v.pages.isEmpty()) {
            Page pp = new Page();
            pp.index = 1;
            pp.cid = d.optLong("cid");
            pp.part = v.title;
            pp.duration = d.optInt("duration");
            v.pages.add(pp);
        }
        return v;
    }

    public static class Stream {
        public String url = "", backup = "", quality = "";
        public int qn;
        public long size;
    }

    /** 取可直下的 MP4 流（fnval=0，单文件，无需合并音视频）。 */
    public Stream playMp4(String bvid, long cid, int qn) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("bvid", bvid);
        p.put("cid", String.valueOf(cid));
        p.put("qn", String.valueOf(qn));
        p.put("fnval", String.valueOf(Const.FNVAL_PROGRESSIVE));
        p.put("fnver", "0");
        p.put("fourk", "1");
        p.put("platform", "pc");
        p.put("type", "mp4");
        JSONObject root = http.api("/x/player/playurl", p, Const.SITE + "/video/" + bvid);
        JSONObject d = root.optJSONObject("data");
        if (d == null) throw new Errors.BiliError("无法获取播放地址");
        Stream s = new Stream();
        JSONArray durl = d.optJSONArray("durl");
        if (durl == null || durl.length() == 0) {
            throw new Errors.BiliError("该清晰度需要 DASH（当前版本仅支持单文件 MP4，请选择较低清晰度）");
        }
        JSONObject first = durl.optJSONObject(0);
        s.url = first.optString("url");
        s.backup = first.optString("backup_url").isEmpty() ? "" : first.optString("backup_url");
        if (s.url.isEmpty() && first.optJSONArray("backup_url") != null) s.backup = first.optJSONArray("backup_url").optString(0);
        s.size = first.optLong("size");
        s.qn = d.optInt("quality", qn);
        JSONArray accept = d.optJSONArray("accept_quality");
        JSONArray desc = d.optJSONArray("accept_description");
        s.quality = qualityName(s.qn);
        if (accept != null && desc != null) {
            int cq = d.optInt("quality", 0);
            for (int i = 0; i < accept.length(); i++) {
                if (accept.optInt(i) == cq) { s.quality = desc.optString(i); break; }
            }
        }
        if (s.url.isEmpty()) throw new Errors.BiliError("播放地址为空");
        return s;
    }

    public static String qualityName(int qn) {
        for (Map.Entry<String, Integer> e : Const.QUALITY.entrySet()) if (e.getValue() == qn) return e.getKey();
        return "qn" + qn;
    }

    // ---------- 图文 / 动态 / 专栏 ----------

    public OpusInfo opus(String oid) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("id", oid);
        p.put("timezone_offset", "-480");
        JSONObject root = http.api("/x/polymer/web-dynamic/v1/opus/detail", p,
                "https://www.bilibili.com/opus/" + oid);
        JSONObject d = root.optJSONObject("data");
        JSONObject item = d == null ? null : d.optJSONObject("item");
        if (item == null) throw new Errors.NotFound("图文不存在");
        OpusInfo info = new OpusInfo();
        info.ident = oid;
        JSONArray modules = item.optJSONArray("modules");
        StringBuilder text = new StringBuilder();
        if (modules != null) {
            for (int i = 0; i < modules.length(); i++) {
                JSONObject m = modules.optJSONObject(i);
                if (m == null) continue;
                String type = m.optString("module_type");
                if ("MODULE_TYPE_TITLE".equals(type)) {
                    JSONObject t = m.optJSONObject("module_title");
                    if (t != null) info.title = t.optString("text");
                } else if ("MODULE_TYPE_AUTHOR".equals(type)) {
                    JSONObject a = m.optJSONObject("module_author");
                    if (a != null) {
                        info.author = a.optString("name");
                        long ts = a.optLong("pub_ts", 0);
                        if (ts > 0) info.pubdate = fmtDate(ts);
                    }
                } else if ("MODULE_TYPE_CONTENT".equals(type)) {
                    JSONObject c = m.optJSONObject("module_content");
                    JSONArray paras = c == null ? null : c.optJSONArray("paragraphs");
                    if (paras == null) continue;
                    for (int j = 0; j < paras.length(); j++) {
                        JSONObject para = paras.optJSONObject(j);
                        if (para == null) continue;
                        int pt = para.optInt("para_type", 1);
                        if (pt == 1) {
                            JSONObject tn = para.optJSONObject("text");
                            JSONArray nodes = tn == null ? null : tn.optJSONArray("nodes");
                            if (nodes != null) {
                                for (int k = 0; k < nodes.length(); k++) {
                                    JSONObject n = nodes.optJSONObject(k);
                                    JSONObject w = n == null ? null : n.optJSONObject("word");
                                    if (w != null) text.append(w.optString("words"));
                                }
                            }
                        } else if (pt == 2) {
                            JSONObject pic = para.optJSONObject("pic");
                            JSONArray pics = pic == null ? null : pic.optJSONArray("pics");
                            if (pics != null) {
                                for (int k = 0; k < pics.length(); k++) {
                                    JSONObject pc = pics.optJSONObject(k);
                                    if (pc != null) addImage(info.images, pc.optString("url"));
                                }
                            }
                        }
                    }
                }
            }
        }
        JSONObject basic = item.optJSONObject("basic");
        if (basic != null && info.title.isEmpty()) info.title = basic.optString("title", "");
        info.text = text.toString();
        if (info.title.isEmpty()) info.title = info.text.isEmpty() ? ("图文" + oid) : firstLine(info.text);
        if (info.images.isEmpty()) throw new Errors.NotFound("该图文没有图片");
        return info;
    }

    public OpusInfo dynamic(String dynId) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("id", dynId);
        p.put("timezone_offset", "-480");
        JSONObject root = http.api("/x/polymer/web-dynamic/v1/detail", p,
                "https://t.bilibili.com/" + dynId);
        JSONObject d = root.optJSONObject("data");
        JSONObject item = d == null ? null : d.optJSONObject("item");
        if (item == null) throw new Errors.NotFound("动态不存在");
        OpusInfo info = new OpusInfo();
        info.ident = dynId;
        JSONObject modules = item.optJSONObject("modules");
        if (modules != null) {
            JSONObject author = modules.optJSONObject("module_author");
            if (author != null) {
                info.author = author.optString("name");
                long ts = author.optLong("pub_ts", 0);
                if (ts > 0) info.pubdate = fmtDate(ts);
            }
            JSONObject dyn = modules.optJSONObject("module_dynamic");
            if (dyn != null) {
                JSONObject desc = dyn.optJSONObject("desc");
                if (desc != null) info.text = desc.optString("text", "");
                JSONObject major = dyn.optJSONObject("major");
                if (major != null) {
                    JSONObject opus = major.optJSONObject("opus");
                    if (opus != null && opus.optJSONArray("pics") != null) {
                        JSONArray pics = opus.optJSONArray("pics");
                        for (int i = 0; i < pics.length(); i++) {
                            JSONObject pc = pics.optJSONObject(i);
                            if (pc != null) addImage(info.images, pc.optString("url"));
                        }
                    }
                    JSONObject draw = major.optJSONObject("draw");
                    if (draw != null && draw.optJSONArray("items") != null) {
                        JSONArray items = draw.optJSONArray("items");
                        for (int i = 0; i < items.length(); i++) {
                            JSONObject it = items.optJSONObject(i);
                            if (it != null) addImage(info.images, it.optString("src"));
                        }
                    }
                    JSONObject article = major.optJSONObject("article");
                    if (article != null && article.optJSONArray("covers") != null) {
                        JSONArray covers = article.optJSONArray("covers");
                        for (int i = 0; i < covers.length(); i++) addImage(info.images, covers.optString(i));
                    }
                    JSONObject common = major.optJSONObject("common");
                    if (common != null && common.optJSONObject("cover") != null) {
                        addImage(info.images, common.optJSONObject("cover").optString("url"));
                    }
                }
            }
        }
        info.title = info.text.isEmpty() ? ("动态" + dynId) : firstLine(info.text);
        if (info.images.isEmpty()) throw new Errors.NotFound("该动态没有可下载的图片");
        return info;
    }

    /** 专栏（read/cv）：抓 HTML 页面里的原图。 */
    public OpusInfo article(String cv) {
        String url = "https://www.bilibili.com/read/cv" + cv;
        String html;
        try {
            html = http.getText(url, Const.SITE + "/", true);
        } catch (IOException e) {
            throw new Errors.BiliError("专栏页面读取失败：" + e.getMessage());
        }
        OpusInfo info = new OpusInfo();
        info.ident = cv;
        info.title = firstGroup(html, "<h1[^>]*>(.*?)</h1>");
        if (info.title.isEmpty()) info.title = firstGroup(html, "<title>(.*?)</title>");
        info.title = stripTags(info.title);
        info.author = stripTags(firstGroup(html, "class=\"up-name\"[^>]*>(.*?)<"));
        info.pubdate = stripTags(firstGroup(html, "class=\"create-time\"[^>]*>(.*?)<"));
        Matcher m = Pattern.compile("<img[^>]+(?:data-src|src)=\"([^\"]+)\"").matcher(html);
        while (m.find()) {
            String src = m.group(1);
            if (src.startsWith("//")) src = "https:" + src;
            if (src.contains("hdslb.com") || src.contains("bilibili.com/bfs")) addImage(info.images, src);
        }
        if (info.title.isEmpty()) info.title = "专栏" + cv;
        if (info.images.isEmpty()) throw new Errors.NotFound("该专栏没有可下载的图片");
        return info;
    }

    static void addImage(List<String> list, String url) {
        if (url == null || url.isEmpty()) return;
        String clean = url;
        int at = clean.indexOf('@');
        if (at > 0) clean = clean.substring(0, at);
        if (clean.startsWith("//")) clean = "https:" + clean;
        if (!clean.startsWith("http")) return;
        if (!list.contains(clean)) list.add(clean);
    }

    // ---------- 空间 ----------

    public boolean hasMore = false;

    public int lastSpaceCount = 0;

    public List<SpaceItem> spaceVideos(String mid, int pn, int ps) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("vmid", mid);
        p.put("ps", String.valueOf(ps));
        p.put("pn", String.valueOf(pn));
        p.put("order", "pubdate");
        JSONObject root;
        try {
            root = http.appApi(Const.APP_API + "/x/v2/space/archive", p);
        } catch (Errors.BiliError e) {
            root = null;
        }
        List<SpaceItem> out = new ArrayList<>();
        JSONObject data = root == null ? null : root.optJSONObject("data");
        if (data == null) return out;
        lastSpaceCount = data.optInt("count", 0);
        JSONArray items = data.optJSONArray("item");
        if (items == null) return out;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            SpaceItem s = new SpaceItem();
            s.kind = "video";
            s.ident = it.optString("bvid");
            s.title = it.optString("title");
            s.cover = it.optString("cover");
            s.duration = it.optInt("duration");
            long ctime = it.optLong("ctime", 0);
            if (ctime > 0) s.date = fmtDate(ctime);
            if (!s.ident.isEmpty()) out.add(s);
        }
        return out;
    }

    public List<SpaceItem> spaceOpus(String mid, String offset) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("host_mid", mid);
        p.put("page", "1");
        if (offset != null && !offset.isEmpty()) p.put("offset", offset);
        JSONObject root = http.api("/x/polymer/web-dynamic/v1/opus/feed/space", p,
                "https://space.bilibili.com/" + mid + "/upload/opus");
        List<SpaceItem> out = new ArrayList<>();
        JSONObject data = root.optJSONObject("data");
        if (data == null) return out;
        JSONArray items = data.optJSONArray("items");
        if (items == null) return out;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            SpaceItem s = new SpaceItem();
            s.kind = "opus";
            s.ident = it.optString("opus_id");
            String content = it.optString("content", "");
            s.title = content.isEmpty() ? ("图文" + s.ident) : firstLine(content);
            JSONObject cover = it.optJSONObject("cover");
            if (cover != null) s.cover = cover.optString("url");
            if (!s.ident.isEmpty()) out.add(s);
        }
        return out;
    }

    public String spaceOpusOffset(String mid, String offset) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("host_mid", mid);
        p.put("page", "1");
        if (offset != null && !offset.isEmpty()) p.put("offset", offset);
        JSONObject root = http.api("/x/polymer/web-dynamic/v1/opus/feed/space", p,
                "https://space.bilibili.com/" + mid + "/upload/opus");
        JSONObject data = root.optJSONObject("data");
        if (data == null) return "";
        String next = data.optString("offset", "");
        boolean more = data.optBoolean("has_more", false);
        return more ? next : "";
    }

    public SpaceItem videoInSeason(String bvid) {
        VideoInfo v = video(bvid);
        SpaceItem s = new SpaceItem();
        s.kind = "video";
        s.ident = v.bvid;
        s.title = v.title;
        s.cover = v.cover;
        s.date = v.pubdate;
        return s;
    }

    public UserCard userCard(String mid) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("vmid", mid);
        JSONObject root = http.appApi(Const.APP_API + "/x/v2/space", p);
        UserCard c = new UserCard();
        c.mid = mid;
        JSONObject data = root.optJSONObject("data");
        JSONObject card = data == null ? null : data.optJSONObject("card");
        if (card != null) {
            c.name = card.optString("name");
            c.face = card.optString("face");
            c.sign = card.optString("sign");
        }
        JSONObject rel = data == null ? null : data.optJSONObject("relation");
        if (rel != null) c.fans = rel.optInt("follower");
        return c;
    }

    // ---------- 登录 ----------

    public static class QrCode {
        public String url = "", key = "";
    }

    public QrCode qrGenerate() {
        JSONObject root = http.api(Const.PASSPORT + "/x/passport-login/web/qrcode/generate",
                new LinkedHashMap<>(), "https://www.bilibili.com/");
        JSONObject d = root.optJSONObject("data");
        if (d == null) throw new Errors.BiliError("二维码生成失败");
        QrCode q = new QrCode();
        q.url = d.optString("url");
        q.key = d.optString("qrcode_key");
        return q;
    }

    /** 返回 {code, message}；成功时已写入 Cookie。 */
    public JSONObject qrPoll(String key, Http target) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("qrcode_key", key);
        JSONObject root = http.api(Const.PASSPORT + "/x/passport-login/web/qrcode/poll", p, "https://www.bilibili.com/");
        JSONObject d = root.optJSONObject("data");
        JSONObject out = new JSONObject();
        if (d == null) { out.put("code", -1); out.put("message", "轮询失败"); return out; }
        int code = d.optInt("code", -1);
        out.put("code", code);
        String url = d.optString("url", "");
        if (code == 0) {
            Map<String, String> picked = new LinkedHashMap<>();
            if (!url.isEmpty()) {
                int q = url.indexOf('?');
                String query = q >= 0 ? url.substring(q + 1) : url;
                for (String kv : query.split("&")) {
                    int eq = kv.indexOf('=');
                    if (eq <= 0) continue;
                    try {
                        String k = URLDecoder.decode(kv.substring(0, eq), "UTF-8");
                        String v = URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                        picked.put(k, v);
                    } catch (Exception ignored) {
                    }
                }
            }
            JSONObject ci = d.optJSONObject("cookie_info");
            if (ci != null && ci.optJSONArray("cookies") != null) {
                JSONArray arr = ci.optJSONArray("cookies");
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject ck = arr.optJSONObject(i);
                    if (ck != null) picked.put(ck.optString("name"), ck.optString("value"));
                }
            }
            if (!picked.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                for (Map.Entry<String, String> e : picked.entrySet()) {
                    if (sb.length() > 0) sb.append("; ");
                    sb.append(e.getKey()).append('=').append(e.getValue());
                }
                target.setCookie(sb.toString());
            }
            out.put("message", "登录成功");
        } else if (code == 86101) out.put("message", "未扫码");
        else if (code == 86090) out.put("message", "已扫码，等待确认");
        else out.put("message", "二维码已过期");
        return out;
    }

    public JSONObject nav() {
        JSONObject root = http.api("/x/web-interface/nav", new LinkedHashMap<>(), Const.SITE + "/");
        JSONObject d = root.optJSONObject("data");
        JSONObject out = new JSONObject();
        if (d == null) { out.put("is_login", false); return out; }
        out.put("is_login", d.optBoolean("isLogin", false));
        out.put("uname", d.optString("uname"));
        out.put("mid", d.optString("mid"));
        out.put("face", d.optString("face"));
        out.put("vip", d.optJSONObject("vipStatus") != null);
        return out;
    }

    // ---------- 工具 ----------

    public static String fmtDate(long ts) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyyMMdd");
        f.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        return f.format(new java.util.Date(ts * 1000L));
    }

    public static String firstLine(String text) {
        String t = text.replace("\r", "");
        int nl = t.indexOf('\n');
        if (nl > 0) t = t.substring(0, nl);
        t = t.trim();
        return t.length() > 90 ? t.substring(0, 90) : t;
    }

    public static String firstGroup(String text, String regex) {
        try {
            Matcher m = Pattern.compile(regex, Pattern.DOTALL).matcher(text);
            if (m.find()) return m.group(1);
        } catch (Exception ignored) {
        }
        return "";
    }

    public static String stripTags(String s) {
        return s == null ? "" : s.replaceAll("<[^>]+>", "").replace("&amp;", "&").replace("&quot;", "\"")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'").trim();
    }

    // ---------- 收藏夹 / 稍后再看 / 番剧 ----------

    /** 收藏夹内容（按收藏时间倒序）。需要登录 Cookie。 */
    public List<SpaceItem> favItems(String mediaId, int pn) {
        if (!http.cookieHeader().contains("SESSDATA")) throw new Errors.BiliError("收藏夹需要登录：先在「账号」页登录");
        Map<String, String> p = new LinkedHashMap<>();
        p.put("media_id", mediaId);
        p.put("pn", String.valueOf(pn));
        p.put("ps", "20");
        p.put("order", "mtime");
        p.put("platform", "web");
        JSONObject root;
        try {
            root = http.api("/x/v3/fav/resource/list", p,
                    "https://www.bilibili.com/medialist/detail/ml" + mediaId);
        } catch (Errors.BiliError e) {
            throw e;
        }
        List<SpaceItem> out = new ArrayList<>();
        JSONObject data = root.optJSONObject("data");
        if (data == null) return out;
        hasMore = data.optBoolean("has_more", false);
        JSONArray items = data.optJSONArray("medias");
        if (items == null) return out;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            SpaceItem s = new SpaceItem();
            s.kind = "video";
            s.ident = it.optString("bvid");
            s.title = it.optString("title");
            s.cover = it.optString("cover");
            s.duration = it.optInt("duration");
            if (!s.ident.isEmpty()) out.add(s);
        }
        return out;
    }

    /** 稍后再看（加入时间倒序）。需要登录 Cookie。 */
    public List<SpaceItem> toview() {
        if (!http.cookieHeader().contains("SESSDATA")) throw new Errors.BiliError("稍后再看需要登录：先在「账号」页登录");
        Map<String, String> p = new LinkedHashMap<>();
        JSONObject root = http.api("/x/v2/history/toview", p, "https://www.bilibili.com/");
        List<SpaceItem> out = new ArrayList<>();
        JSONObject data = root.optJSONObject("data");
        if (data == null) return out;
        JSONArray items = data.optJSONArray("list");
        if (items == null) return out;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            SpaceItem s = new SpaceItem();
            s.kind = "video";
            s.ident = it.optString("bvid");
            s.title = it.optString("title");
            s.cover = it.optString("cover");
            s.duration = it.optInt("duration");
            if (!s.ident.isEmpty()) out.add(s);
        }
        return out;
    }

    /** 番剧剧集（最新一集在前）。 */
    public List<SpaceItem> seasonEpisodes(String seasonId) {
        Map<String, String> p = new LinkedHashMap<>();
        if (seasonId.matches("\\d+")) p.put("season_id", seasonId);
        else p.put("ep_id", seasonId);
        JSONObject root;
        try {
            root = http.api("https://api.bilibili.com/pgc/view/web/season", p,
                    "https://www.bilibili.com/bangumi/play/ss" + seasonId);
        } catch (Errors.BiliError e) {
            throw e;
        }
        List<SpaceItem> out = new ArrayList<>();
        JSONObject result = root.optJSONObject("result");
        if (result == null) return out;
        JSONArray eps = result.optJSONArray("episodes");
        if (eps == null) return out;
        for (int i = 0; i < eps.length(); i++) {
            JSONObject ep = eps.optJSONObject(i);
            if (ep == null) continue;
            SpaceItem s = new SpaceItem();
            s.kind = "video";
            s.ident = ep.optString("bvid");
            s.title = ep.optString("share_copy");
            if (s.title.isEmpty()) s.title = ep.optString("long_title");
            if (s.title.isEmpty()) s.title = "第 " + ep.optString("title") + " 话";
            s.cover = ep.optString("cover");
            s.duration = ep.optInt("duration") / 1000;
            if (!s.ident.isEmpty()) out.add(s);
        }
        java.util.Collections.reverse(out);   // 最新一集在前
        return out;
    }
}
