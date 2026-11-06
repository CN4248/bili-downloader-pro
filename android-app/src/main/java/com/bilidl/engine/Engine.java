package com.bilidl.engine;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.json.JSONArray;
import org.json.JSONObject;

/** 下载引擎：任务队列、串行下载、工作区命名。 */
public class Engine {
    public static class Task {
        public String id = UUID.randomUUID().toString().substring(0, 8);
        public String kind = "video";      // video | opus
        public String title = "";
        public String ident = "";
        public String status = "queued";   // queued|running|done|error|skipped|canceled
        public String message = "";
        public String dir = "";
        public int total = 0, done = 0;
        public long bytes = 0;
        public long created = System.currentTimeMillis();
        public List<JSONObject> files = new ArrayList<>();
        public volatile boolean cancel = false;

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("kind", kind);
            o.put("title", title);
            o.put("ident", ident);
            o.put("status", status);
            o.put("message", message);
            o.put("dir", dir);
            o.put("total", total);
            o.put("done", done);
            o.put("bytes", bytes);
            o.put("created", created);
            JSONArray arr = new JSONArray();
            for (JSONObject f : files) arr.put(f);
            o.put("files", arr);
            return o;
        }
    }

    public static class VideoSpec {
        public String ident = "";
        public String title = "";
        public String dir = "";
        public boolean allPages = true;
        public List<Integer> pages = new ArrayList<>();     // 分集序号，空=全部
        public List<String> seasonBvids = new ArrayList<>(); // 选中的合辑内视频
        public boolean seasonAll = false;
    }

    public static class OpusSpec {
        public String ident = "";
        public String subKind = "opus";  // opus | dynamic | article
        public String title = "";
        public String dir = "";
    }

    public final File dataDir;
    public final Http http;
    public final Api api;
    public final Settings settings;
    public final File settingsFile;

    private final List<Task> tasks = Collections.synchronizedList(new ArrayList<>());
    private final List<String> events = Collections.synchronizedList(new ArrayList<>());
    private final ExecutorService pool;
    private final LinkedBlockingQueue<Task> queue = new LinkedBlockingQueue<>();
    private final long started = System.currentTimeMillis();
    public volatile long lastErrorAt = 0L;

    public Engine(File dataDir) {
        this.dataDir = dataDir;
        dataDir.mkdirs();
        this.http = new Http(dataDir);
        this.api = new Api(http);
        this.settingsFile = new File(dataDir, "settings.json");
        this.settings = Settings.load(settingsFile, dataDir);
        this.http.apiInterval = settings.apiInterval;
        this.pool = Executors.newFixedThreadPool(Math.max(1, Math.min(4, settings.concurrency)));
        for (int i = 0; i < Math.max(1, settings.concurrency); i++) {
            pool.submit(this::workerLoop);
        }
        log("引擎已启动，下载目录：" + settings.videoDir);
    }

    public void log(String msg) {
        String line = new SimpleDateFormat("HH:mm:ss", Locale.CHINA).format(new Date()) + " " + msg;
        events.add(line);
        while (events.size() > 400) events.remove(0);
    }

    public List<String> eventsSnapshot() {
        synchronized (events) { return new ArrayList<>(events); }
    }

    public void saveSettings() {
        settings.normalize(dataDir);
        http.apiInterval = settings.apiInterval;
        Settings.save(settingsFile, settings);
    }

    // ---------- 任务 ----------

    public Task addVideo(VideoSpec spec) {
        Task t = new Task();
        t.kind = "video";
        t.ident = spec.ident;
        t.title = spec.title.isEmpty() ? spec.ident : spec.title;
        t.dir = spec.dir;
        tasks.add(0, t);
        queue.offer(t);
        pendingSpecs.put(t.id, spec);
        log("加入视频任务：" + t.title);
        return t;
    }

    private final Map<String, VideoSpec> pendingSpecs = Collections.synchronizedMap(new LinkedHashMap<>());
    private final Map<String, OpusSpec> pendingOpus = Collections.synchronizedMap(new LinkedHashMap<>());

    public Task addOpus(OpusSpec spec) {
        Task t = new Task();
        t.kind = "opus";
        t.ident = spec.ident;
        t.title = spec.title.isEmpty() ? spec.ident : spec.title;
        t.dir = spec.dir;
        tasks.add(0, t);
        queue.offer(t);
        pendingOpus.put(t.id, spec);
        log("加入图文任务：" + t.title);
        return t;
    }

    public List<Task> tasks() {
        synchronized (tasks) { return new ArrayList<>(tasks); }
    }

    public Task task(String id) {
        synchronized (tasks) {
            for (Task t : tasks) if (t.id.equals(id)) return t;
        }
        return null;
    }

    public boolean cancel(String id) {
        Task t = task(id);
        if (t == null) return false;
        t.cancel = true;
        if ("queued".equals(t.status)) t.status = "canceled";
        log("已取消：" + t.title);
        return true;
    }

    /** 取消全部：直接从任务列表和排队里删除（不是留一堆 canceled 占位）。 */
    public int cancelAll() {
        List<Task> current = tasks();
        for (Task t : current) t.cancel = true;   // 正在跑的 worker 会在检查点退出
        queue.clear();
        synchronized (tasks) { tasks.clear(); }
        pendingSpecs.clear();
        pendingOpus.clear();
        if (!current.isEmpty()) log("已取消并移除 " + current.size() + " 个任务");
        return current.size();
    }

    public JSONObject status() {
        JSONObject o = new JSONObject();
        JSONArray arr = new JSONArray();
        for (Task t : tasks()) arr.put(t.toJson());
        o.put("tasks", arr);
        o.put("events", new JSONArray(eventsSnapshot()));
        o.put("uptime", (System.currentTimeMillis() - started) / 1000);
        o.put("queue", queue.size());
        o.put("quality", settings.quality);
        o.put("login", http.hasCookie());
        o.put("ffmpeg", false);
        return o;
    }

    // ---------- 工作线程 ----------

    private void workerLoop() {
        while (true) {
            Task t;
            try {
                t = queue.take();
            } catch (InterruptedException e) {
                return;
            }
            if (t.cancel) continue;
            // 图文任务要拉详情 + 逐张下载，比视频更容易触发风控：间隔更长，并且批量之间休息
            if (!"video".equals(t.kind)) {
                sleepMs((long) (Math.max(settings.fileInterval, 2.6) * 1000 + 400 + Math.random() * 1400));
                opusStreak++;
                if (opusStreak >= 8) {
                    opusStreak = 0;
                    long rest = 25000 + (long) (Math.random() * 20000);
                    log("图文已连下 8 个，休息 " + (rest / 1000) + " 秒避免触发风控");
                    sleepMs(rest);
                }
            }
            t.status = "running";
            try {
                if ("video".equals(t.kind)) runVideo(t);
                else runOpus(t);
                if (t.cancel) t.status = "canceled";
                else if (!"error".equals(t.status)) t.status = "done";
            } catch (Errors.AuthRequired e) {
                t.status = "error";
                t.message = "需要登录：" + e.getMessage();
                log("失败（需登录）：" + t.title + " " + e.getMessage());
            } catch (Errors.RiskControl e) {
                t.status = "error";
                t.message = "触发风控，已暂停 2 分钟：" + e.getMessage();
                http.coolDownUntil = System.currentTimeMillis() + 120_000L;
                log("风控：" + t.title + "，暂停 2 分钟");
            } catch (Exception e) {
                t.status = "error";
                t.message = String.valueOf(e.getMessage());
                lastErrorAt = System.currentTimeMillis();
                log("失败：" + t.title + " → " + e.getMessage());
            }
        }
    }

    private int opusStreak = 0;

    private void sleepMs(long ms) {
        try { if (ms > 0) Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }

    /** 把失败的任务重新排队（spec 保留，进度归零）。 */
    public int retryFailed() {
        return retryFailed("");
    }

    /** 传 id 只重试那一个失败任务，传空串重试全部。 */
    public int retryFailed(String id) {
        int n = 0;
        for (Task t : tasks()) {
            if (id != null && !id.isEmpty() && !id.equals(t.id)) continue;
            if (!"error".equals(t.status)) continue;
            if (!pendingSpecs.containsKey(t.id) && !pendingOpus.containsKey(t.id)) continue;
            t.status = "queued";
            t.done = 0;
            t.message = "";
            t.cancel = false;
            queue.offer(t);
            n++;
        }
        if (n > 0) log("重新排队 " + n + " 个失败任务");
        return n;
    }

    /** 只清理已完成/已跳过/已取消；失败任务保留，方便重试。 */
    public int clearFinished() {
        int n = 0;
        synchronized (tasks) {
            for (int i = tasks.size() - 1; i >= 0; i--) {
                Task t = tasks.get(i);
                if ("done".equals(t.status) || "skipped".equals(t.status) || "canceled".equals(t.status)) {
                    tasks.remove(i);
                    pendingSpecs.remove(t.id);
                    pendingOpus.remove(t.id);
                    n++;
                }
            }
        }
        return n;
    }

    private void pauseBetweenFiles() {
        try {
            long ms = (long) (settings.fileInterval * 1000 + Math.random() * 400);
            if (ms > 0) Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    private void runVideo(Task t) {
        VideoSpec spec = pendingSpecs.get(t.id);
        if (spec == null) spec = new VideoSpec();
        Api.VideoInfo info;
        try {
            info = api.video(spec.ident);
        } catch (Errors.BiliError e) {
            if (e instanceof Errors.RiskControl) throw e;
            t.status = "error";
            t.message = e.getMessage();
            return;
        }
        t.title = info.title;
        t.ident = info.bvid;
        File dir = resolveDir(spec.dir, settings.videoDir);
        t.dir = dir.getAbsolutePath();
        dir.mkdirs();

        List<Api.Page> pages = new ArrayList<>();
        for (Api.Page p : info.pages) {
            if (t.cancel) return;
            if (!spec.pages.isEmpty() && !spec.pages.contains(p.index)) continue;
            pages.add(p);
        }
        int qn = Const.qnOf(settings.quality);
        List<Api.SeasonEp> extra = new ArrayList<>();
        if (spec.seasonAll && !info.season.isEmpty()) {
            for (Api.SeasonEp ep : info.season) if (!ep.bvid.equals(info.bvid)) extra.add(ep);
        }
        for (String bv : spec.seasonBvids) {
            if (bv.equals(info.bvid)) continue;
            for (Api.SeasonEp ep : info.season) if (ep.bvid.equals(bv)) { extra.add(ep); break; }
        }
        t.total = pages.size() + extra.size();
        if (t.total == 0) { t.message = "没有可下载的分集"; return; }

        for (Api.Page p : pages) {
            if (t.cancel) return;
            downloadOne(t, info, p, qn, dir);
            pauseBetweenFiles();
        }
        for (Api.SeasonEp ep : extra) {
            if (t.cancel) return;
            try {
                Api.VideoInfo other = api.video(ep.bvid);
                Api.Page p = new Api.Page();
                p.index = ep.page <= 0 ? 1 : ep.page;
                p.cid = ep.cid;
                p.part = ep.title;
                p.duration = ep.duration;
                downloadOne(t, other, p, qn, dir);
            } catch (Errors.BiliError e) {
                t.done++;
                log("跳过分集：" + ep.title + " → " + e.getMessage());
            }
            pauseBetweenFiles();
        }
    }

    private void downloadOne(Task t, Api.VideoInfo info, Api.Page p, int qn, File dir) {
        String title = info.pages.size() > 1 ? info.title : info.title;
        try {
            Api.Stream s = api.playMp4(info.bvid, p.cid, qn);
            Map<String, String> vars = new LinkedHashMap<>();
            vars.put("video_title", info.title);
            vars.put("video_id", info.bvid);
            vars.put("video_episode", String.valueOf(p.index));
            vars.put("video_page_title", p.part == null ? "" : p.part);
            vars.put("video_author", info.ownerName);
            vars.put("video_quality", s.quality);
            vars.put("video_date", info.pubdate);
            vars.put("ext", "mp4");
            String rel = Naming.renderPath(settings.videoTemplate, vars, Const.DEFAULT_VIDEO_TEMPLATE);
            rel = Naming.ensureExtPath(rel, "mp4");
            String name = rel.substring(rel.lastIndexOf('/') + 1);
            File out = new File(dir, rel);
            if (out.getParentFile() != null) out.getParentFile().mkdirs();
            if (settings.skipExisting && out.exists() && out.length() > 0) {
                t.done++;
                t.message = "已存在，跳过";
                log("已存在：" + rel);
                return;
            }
            if (out.exists()) out = Naming.unique(out.getParentFile(), out.getName());
            long size = http.download(s.url, out, Const.SITE + "/video/" + info.bvid,
                    (done, total) -> t.message = "下载中 " + (total > 0 ? (done * 100 / total) + "%" : (done / 1048576) + "MB"),
                    () -> t.cancel);
            t.done++;
            t.bytes += size;
            JSONObject f = new JSONObject();
            f.put("name", name);
            f.put("size", size);
            f.put("path", out.getAbsolutePath());
            t.files.add(f);
            t.message = "完成";
            log("视频完成：" + name + "（" + (size / 1048576) + "MB, " + s.quality + "）");
        } catch (Errors.BiliError e) {
            if (e instanceof Errors.RiskControl) throw e;
            if (t.cancel) return;   // 「取消全部」删掉任务后的预期中断，不记失败
            t.done++;
            log("分集失败：" + title + " P" + p.index + " cid=" + p.cid + " → " + e.getMessage());
            t.message = e.getMessage();
        } finally {
            t.title = title;
        }
    }

    private void runOpus(Task t) {
        OpusSpec spec = pendingOpus.get(t.id);
        if (spec == null) spec = new OpusSpec();
        Api.OpusInfo info;
        try {
            if ("dynamic".equals(spec.subKind)) info = api.dynamic(spec.ident);
            else if ("article".equals(spec.subKind)) info = api.article(spec.ident);
            else info = api.opus(spec.ident);
        } catch (Errors.BiliError e) {
            if (e instanceof Errors.RiskControl) throw e;
            t.status = "error";
            t.message = e.getMessage();
            return;
        }
        t.title = info.title;
        File dir = resolveDir(spec.dir, settings.opusDir);
        t.dir = dir.getAbsolutePath();
        dir.mkdirs();
        t.total = info.images.size();
        int idx = 0;
        for (String img : info.images) {
            if (t.cancel) return;
            idx++;
            final int order = idx;
            try {
                String ext = guessExt(img);
                Map<String, String> vars = new LinkedHashMap<>();
                vars.put("opus_title", info.title);
                vars.put("opus_id", info.ident);
                vars.put("opus_order", String.valueOf(idx));
                vars.put("opus_author", info.author);
                vars.put("opus_date", info.pubdate);
                vars.put("ext", ext);
                String rel = Naming.renderPath(settings.opusTemplate, vars, Const.DEFAULT_OPUS_TEMPLATE);
                rel = Naming.ensureExtPath(rel, ext);
                String name = rel.substring(rel.lastIndexOf('/') + 1);
                File out = new File(dir, rel);
                if (out.getParentFile() != null) out.getParentFile().mkdirs();
                if (settings.skipExisting && out.exists() && out.length() > 0) {
                    t.done++;
                    continue;
                }
                if (out.exists()) out = Naming.unique(out.getParentFile(), out.getName());
                long size = http.download(img, out, "https://www.bilibili.com/",
                        (done, total) -> t.message = "下载中 " + order + "/" + info.images.size(), () -> t.cancel);
                if (size < 1024) {
                    out.delete();
                    throw new Errors.DownloadError("图片返回异常");
                }
                t.done++;
                t.bytes += size;
                JSONObject f = new JSONObject();
                f.put("name", name);
                f.put("size", size);
                f.put("path", out.getAbsolutePath());
                t.files.add(f);
            } catch (Errors.BiliError e) {
                if (e instanceof Errors.RiskControl) throw e;
                if (t.cancel) return;
                t.done++;
                log("图片失败：" + t.title + " #" + idx + " → " + e.getMessage());
            }
            pauseBetweenFiles();
        }
        t.message = "完成";
        log("图文完成：" + t.title + "（" + t.done + "/" + t.total + " 张）");
    }

    static String guessExt(String url) {
        String path = url;
        int q = path.indexOf('?');
        if (q > 0) path = path.substring(0, q);
        int dot = path.lastIndexOf('.');
        if (dot > 0 && path.length() - dot <= 6) {
            String ext = path.substring(dot + 1).toLowerCase(Locale.ROOT);
            if (ext.matches("[a-z0-9]{2,5}")) return ext;
        }
        return "jpg";
    }

    public File resolveDir(String custom, String fallback) {
        String d = custom == null ? "" : custom.trim();
        if (d.isEmpty()) d = fallback;
        File f = new File(d);
        if (!f.isAbsolute()) f = new File(dataDir, d);
        return f;
    }

    public void shutdown() {
        pool.shutdownNow();
        try { pool.awaitTermination(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
    }
}
