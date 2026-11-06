package com.bilidl.engine;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import org.json.JSONArray;
import org.json.JSONObject;

/** 定时追更：按订阅扫描 UP 主新作品并自动下载。 */
public class Subs {
    public static final int DEFAULT_INTERVAL = 600;
    public static final int MIN_INTERVAL = 120;
    public static final int SEEN_LIMIT = 600;
    public static final int MAX_SCAN_PAGES = 40;

    private final Engine engine;
    private final Api api;
    private final Settings settings;
    private final File file;
    private final JSONObject data = new JSONObject();
    private volatile boolean stop = false;
    private Thread loop;
    public volatile long lastScanAt = 0L;

    public Subs(Engine engine, File file) {
        this.engine = engine;
        this.api = engine.api;
        this.settings = engine.settings;
        this.file = file;
        load();
    }

    private void load() {
        try {
            if (file.exists()) {
                JSONObject o = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                java.util.Iterator<String> it = o.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    data.put(k, o.get(k));
                }
            }
        } catch (Exception ignored) {
        }
        if (!data.has("enabled")) data.put("enabled", false);
        if (!data.has("interval")) data.put("interval", DEFAULT_INTERVAL);
        if (!data.has("max_new")) data.put("max_new", 20);
        if (!data.has("min_gap")) data.put("min_gap", 90);
        if (!data.has("subs")) data.put("subs", new JSONArray());
    }

    public synchronized void save() {
        try {
            Files.write(file.toPath(), data.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    public synchronized JSONObject snapshot() {
        JSONObject o = new JSONObject();
        o.put("enabled", data.optBoolean("enabled", false));
        o.put("interval", data.optInt("interval", DEFAULT_INTERVAL));
        o.put("max_new", data.optInt("max_new", 20));
        o.put("min_gap", data.optInt("min_gap", 90));
        o.put("now", System.currentTimeMillis() / 1000);
        o.put("last_scan_at", lastScanAt / 1000);
        JSONArray arr = new JSONArray();
        JSONArray subs = data.optJSONArray("subs");
        for (int i = 0; i < subs.length(); i++) {
            JSONObject s = subs.optJSONObject(i);
            if (s == null) continue;
            JSONObject c = new JSONObject(s.toString());
            c.put("interval_effective", intervalOf(s));
            arr.put(c);
        }
        o.put("subs", arr);
        return o;
    }

    public int intervalOf(JSONObject sub) {
        int own = sub.optInt("interval", 0);
        return own >= MIN_INTERVAL ? own : data.optInt("interval", DEFAULT_INTERVAL);
    }

    public synchronized JSONObject setConfig(JSONObject cfg) {
        if (cfg.has("enabled")) data.put("enabled", cfg.optBoolean("enabled"));
        if (cfg.has("interval")) data.put("interval", Math.max(MIN_INTERVAL, cfg.optInt("interval")));
        if (cfg.has("max_new")) data.put("max_new", Math.max(1, Math.min(200, cfg.optInt("max_new"))));
        if (cfg.has("min_gap")) data.put("min_gap", Math.max(30, Math.min(3600, cfg.optInt("min_gap"))));
        save();
        return snapshot();
    }

    private static JSONObject channel(boolean enabled) {
        JSONObject ch = new JSONObject();
        ch.put("enabled", enabled);
        ch.put("dir", "");
        ch.put("since", "");
        ch.put("since_title", "");
        ch.put("since_time", 0);
        ch.put("seen", new JSONArray());
        JSONObject filt = new JSONObject();
        filt.put("include", "");
        filt.put("exclude", "");
        filt.put("min_dur", 0);
        filt.put("max_dur", 0);
        ch.put("filters", filt);
        ch.put("last_new", 0);
        ch.put("last_message", "");
        ch.put("last_error", "");
        return ch;
    }

    public synchronized JSONObject upsert(JSONObject payload) {
        String id = payload.optString("id", "");
        JSONArray subs = data.optJSONArray("subs");
        JSONObject sub = null;
        for (int i = 0; i < subs.length(); i++) {
            JSONObject s = subs.optJSONObject(i);
            if (s != null && s.optString("id").equals(id)) { sub = s; break; }
        }
        boolean created = false;
        if (sub == null) {
            sub = new JSONObject();
            sub.put("id", UUID.randomUUID().toString().substring(0, 8));
            sub.put("mid", payload.optString("mid"));
            sub.put("name", "");
            sub.put("face", "");
            sub.put("enabled", true);
            sub.put("interval", 0);
            sub.put("kind", payload.optString("kind", "up"));
            sub.put("target", payload.optString("target", ""));
            sub.put("video", channel(false));
            sub.put("opus", channel(true));
            sub.put("last_check", 0);
            sub.put("created", System.currentTimeMillis() / 1000);
            subs.put(sub);
            created = true;
        }
        if (payload.has("mid") && !payload.optString("mid").equals(sub.optString("mid"))) {
            sub.put("mid", payload.optString("mid"));
            sub.put("name", "");
            sub.put("face", "");
            sub.put("last_check", 0);
        }
        if (payload.has("enabled")) sub.put("enabled", payload.optBoolean("enabled"));
        if (payload.has("interval")) sub.put("interval", payload.optInt("interval"));
        if (payload.has("kind")) {
            String nk = payload.optString("kind", "up");
            if (!nk.equals(sub.optString("kind", "up"))) {
                sub.put("kind", nk);
                sub.put("target", "");
                sub.put("name", "");
            }
        }
        if (payload.has("target")) sub.put("target", payload.optString("target", ""));
        if (!"up".equals(sub.optString("kind", "up"))) {
            sub.optJSONObject("opus").put("enabled", false);
            if (!payload.has("video")) sub.optJSONObject("video").put("enabled", true);
            if (sub.optString("name").isEmpty()) {
                String k = sub.optString("kind", "up");
                sub.put("name", "fav".equals(k) ? "收藏夹" : "bangumi".equals(k) ? "番剧" : "稍后再看");
            }
        }
        String[] ks = "up".equals(sub.optString("kind", "up")) ? new String[]{"video", "opus"} : new String[]{"video"};
        for (String kind : ks) {
            if (!payload.has(kind)) continue;
            JSONObject src = payload.optJSONObject(kind);
            if (src == null) continue;
            JSONObject ch = sub.optJSONObject(kind);
            if (ch == null) { ch = channel(false); sub.put(kind, ch); }
            if (src.has("enabled")) ch.put("enabled", src.optBoolean("enabled"));
            if (src.has("dir")) ch.put("dir", src.optString("dir"));
            if (src.has("since")) {
                String since = src.optString("since");
                if (!since.equals(ch.optString("since"))) {
                    ch.put("seen", new JSONArray());
                sub.put("last_check", 0);
                }
                ch.put("since", since);
                ch.put("since_title", src.optString("since_title", ""));
                ch.put("since_time", src.optLong("since_time", 0));
            }
        }
        if (created && !sub.optString("mid").isEmpty()) {
            try {
                Api.UserCard card = api.userCard(sub.optString("mid"));
                sub.put("name", card.name);
                sub.put("face", card.face);
            } catch (Exception ignored) {
            }
        }
        save();
        JSONObject out = new JSONObject();
        out.put("sub", new JSONObject(sub.toString()));
        out.put("state", snapshot());
        return out;
    }

    public synchronized boolean delete(String id) {
        JSONArray subs = data.optJSONArray("subs");
        JSONArray out = new JSONArray();
        boolean removed = false;
        for (int i = 0; i < subs.length(); i++) {
            JSONObject s = subs.optJSONObject(i);
            if (s != null && s.optString("id").equals(id)) { removed = true; continue; }
            if (s != null) out.put(s);
        }
        data.put("subs", out);
        save();
        return removed;
    }

    public void start() {
        loop = new Thread(this::tickLoop, "bilidl-subs");
        loop.setDaemon(true);
        loop.start();
    }

    public void close() {
        stop = true;
        if (loop != null) loop.interrupt();
    }

    private void tickLoop() {
        while (!stop) {
            try {
                Thread.sleep(15000);
            } catch (InterruptedException e) {
                return;
            }
            try {
                tick();
            } catch (Exception e) {
                engine.log("追更调度异常：" + e.getMessage());
            }
        }
    }

    private synchronized JSONObject dueSub() {
        if (!data.optBoolean("enabled", false)) return null;
        if (engine.http.cooling()) return null;
        long now = System.currentTimeMillis() / 1000;
        int gap = data.optInt("min_gap", 90);
        if (now - lastScanAt < gap) return null;
        JSONArray subs = data.optJSONArray("subs");
        JSONObject best = null;
        long bestLast = Long.MAX_VALUE;
        for (int i = 0; i < subs.length(); i++) {
            JSONObject s = subs.optJSONObject(i);
            if (s == null || !s.optBoolean("enabled", true)) continue;
            long last = s.optLong("last_check", 0);
            if (now - last < intervalOf(s)) continue;
            if (last < bestLast) { bestLast = last; best = s; }
        }
        return best;
    }

    private void tick() {
        JSONObject sub = dueSub();
        if (sub == null) return;
        try {
            Thread.sleep(1000 + (long) (Math.random() * 3000));
        } catch (InterruptedException ignored) {
        }
        scan(sub);
    }

    public JSONObject checkNow(String id) {
        JSONObject sub = null;
        JSONArray subs = data.optJSONArray("subs");
        for (int i = 0; i < subs.length(); i++) {
            JSONObject s = subs.optJSONObject(i);
            if (s != null && s.optString("id").equals(id)) { sub = s; break; }
        }
        if (sub == null) throw new Errors.ParseError("订阅不存在");
        return scan(sub);
    }

    private JSONObject scan(JSONObject sub) {
        long now = System.currentTimeMillis() / 1000;
        JSONObject result = new JSONObject();
        int totalNew = 0;
        String mid = sub.optString("mid");
        String name = sub.optString("name", mid);
        String[] ks = "up".equals(sub.optString("kind", "up")) ? new String[]{"video", "opus"} : new String[]{"video"};
        for (String kind : ks) {
            JSONObject ch = sub.optJSONObject(kind);
            if (ch == null || !ch.optBoolean("enabled", false)) { result.put(kind, 0); continue; }
            try {
                List<Api.SpaceItem> works = fetch(kind, sub, knownIds(ch));
                int n = scanChannel(sub, kind, ch, works);
                totalNew += n;
                result.put(kind, n);
            } catch (Errors.RiskControl e) {
                ch.put("last_error", "触发风控");
                engine.http.coolDownUntil = System.currentTimeMillis() + 180_000L;
                result.put(kind, 0);
            } catch (Exception e) {
                ch.put("last_error", String.valueOf(e.getMessage()));
                result.put(kind, 0);
            }
            try {
                Thread.sleep((long) (settings.scanInterval * 1000 + 800 + Math.random() * 1400));
            } catch (InterruptedException ignored) {
            }
        }
        sub.put("last_check", now);
        lastScanAt = now;
        save();
        engine.log("追更扫描 " + name + "：视频新增 " + result.optInt("video") + " 个，图文新增 " + result.optInt("opus") + " 个");
        return result;
    }

    private List<Api.SpaceItem> fetch(String kind, JSONObject sub, java.util.Set<String> known) {
        List<Api.SpaceItem> out = new ArrayList<>();
        String sk = sub.optString("kind", "up");
        String target = sub.optString("target", "");
        if ("fav".equals(sk)) {
            for (int pn = 1; pn <= 12; pn++) {
                List<Api.SpaceItem> page = api.favItems(target, pn);
                if (page.isEmpty()) break;
                out.addAll(page);
                boolean hit = false;
                for (Api.SpaceItem s : page) if (known.contains(s.ident)) { hit = true; break; }
                if (hit) break;
                if (!api.hasMore) break;
                pause();
            }
            return out;
        }
        if ("toview".equals(sk)) return api.toview();
        if ("bangumi".equals(sk)) return api.seasonEpisodes(target);
        String mid = sub.optString("mid", "");
        if ("video".equals(kind)) {
            for (int pn = 1; pn <= 8; pn++) {
                List<Api.SpaceItem> page = api.spaceVideos(mid, pn, 30);
                if (page.isEmpty()) break;
                out.addAll(page);
                boolean hit = false;
                for (Api.SpaceItem s : page) if (known.contains(s.ident)) { hit = true; break; }
                if (hit) break;                       // 增量：翻到见过的作品就停
                if (api.lastSpaceCount > 0 && out.size() >= api.lastSpaceCount) break;
                if (page.size() < 20) break;
                pause();
            }
        } else {
            String offset = "";
            int page = 0;
            while (page < 12) {
                List<Api.SpaceItem> items = api.spaceOpus(mid, offset);
                if (items.isEmpty()) break;
                out.addAll(items);
                boolean hit = false;
                for (Api.SpaceItem s : items) if (known.contains(s.ident)) { hit = true; break; }
                if (hit) break;
                offset = api.spaceOpusOffset(mid, offset);
                page++;
                if (offset == null || offset.isEmpty()) break;
                pause();
            }
        }
        return out;
    }

    private void pause() {
        try {
            Thread.sleep((long) (settings.scanInterval * 1000 + Math.random() * 500));
        } catch (InterruptedException ignored) {
        }
    }

    /** 订阅过滤规则：标题包含 / 排除、视频时长上下限。 */
    private boolean keep(JSONObject ch, Api.SpaceItem w) {
        JSONObject f = ch.optJSONObject("filters");
        if (f == null) return true;
        String title = w.title == null ? "" : w.title.toLowerCase();
        String inc = f.optString("include", "").trim().toLowerCase();
        String exc = f.optString("exclude", "").trim().toLowerCase();
        if (!inc.isEmpty()) {
            for (String t : inc.split("\\s+")) if (!t.isEmpty() && !title.contains(t)) return false;
        }
        if (!exc.isEmpty()) {
            for (String t : exc.split("\\s+")) if (!t.isEmpty() && title.contains(t)) return false;
        }
        int min = f.optInt("min_dur", 0);
        int max = f.optInt("max_dur", 0);
        if (w.duration > 0 && min > 0 && w.duration < min) return false;
        if (w.duration > 0 && max > 0 && w.duration > max) return false;
        return true;
    }

    private java.util.Set<String> knownIds(JSONObject ch) {
        java.util.Set<String> known = new java.util.HashSet<>();
        JSONArray seen = ch.optJSONArray("seen");
        if (seen != null) for (int i = 0; i < seen.length(); i++) known.add(seen.optString(i));
        String since = ch.optString("since", "");
        if (!since.isEmpty()) known.add(since);
        return known;
    }

    private int scanChannel(JSONObject sub, String kind, JSONObject ch, List<Api.SpaceItem> works) {
        List<String> idents = new ArrayList<>();
        for (Api.SpaceItem s : works) idents.add(s.ident);
        if (idents.isEmpty()) { ch.put("last_message", "没有检索到作品"); return 0; }
        String since = ch.optString("since", "");
        List<Api.SpaceItem> newer = new ArrayList<>();
        if (since.isEmpty()) {
            JSONArray seen = new JSONArray();
            for (int i = 0; i < Math.min(idents.size(), SEEN_LIMIT); i++) seen.put(idents.get(i));
            ch.put("seen", seen);
            ch.put("last_message", "首次扫描仅建立基线（" + idents.size() + " 个作品，不下载旧作品）");
            return 0;
        }
        int idx = idents.indexOf(since);
        if (idx >= 0) {
            // 含起点：subList(0, idx) 会漏掉用户选中的那一部
            newer.addAll(works.subList(0, idx + 1));
        } else {
            long sinceTime = ch.optLong("since_time", 0);
            if (sinceTime > 0) {
                // 起点作品被删/翻页没取到时按发布日期兜底，同样包含同一天的作品
                String sinceDate = Api.fmtDate(sinceTime);
                for (Api.SpaceItem s : works) {
                    if (s.date != null && !s.date.isEmpty() && s.date.compareTo(sinceDate) >= 0) newer.add(s);
                }
            }
        }
        // 作品列表是新→旧，倒过来让起点作品排最前面：从起点开始往新下载
        Collections.reverse(newer);
        JSONArray seen = ch.optJSONArray("seen");
        List<String> seenList = new ArrayList<>();
        if (seen != null) for (int i = 0; i < seen.length(); i++) seenList.add(seen.optString(i));
        List<Api.SpaceItem> picked = new ArrayList<>();
        int maxNew = data.optInt("max_new", 20);
        int filtered = 0;
        for (Api.SpaceItem s : newer) {
            if (seenList.contains(s.ident)) continue;
            if (!keep(ch, s)) { filtered++; continue; }
            picked.add(s);
            if (picked.size() >= maxNew) break;
        }
        if (picked.isEmpty()) {
            ch.put("last_message", filtered > 0 ? "没有符合过滤规则的新作品" : "没有新作品");
            return 0;
        }
        int created = 0;
        String dir = ch.optString("dir", "");
        for (Api.SpaceItem s : picked) {
            if ("video".equals(kind)) {
                Engine.VideoSpec spec = new Engine.VideoSpec();
                spec.ident = s.ident;
                spec.title = s.title;
                spec.dir = dir;
                spec.allPages = true;
                engine.addVideo(spec);
            } else {
                Engine.OpusSpec spec = new Engine.OpusSpec();
                spec.ident = s.ident;
                spec.subKind = "opus";
                spec.title = s.title;
                spec.dir = dir;
                engine.addOpus(spec);
            }
            created++;
        }
        List<String> merged = new ArrayList<>();
        for (Api.SpaceItem s : picked) merged.add(s.ident);
        for (String id : seenList) if (!merged.contains(id)) merged.add(id);
        JSONArray newSeen = new JSONArray();
        for (int i = 0; i < Math.min(merged.size(), SEEN_LIMIT); i++) newSeen.put(merged.get(i));
        ch.put("seen", newSeen);
        ch.put("last_new", picked.size());
        ch.put("last_message", "新增 " + picked.size() + " 个作品，已建 " + created + " 个下载任务"
                + (filtered > 0 ? "，过滤掉 " + filtered + " 个" : ""));
        return picked.size();
    }
}
