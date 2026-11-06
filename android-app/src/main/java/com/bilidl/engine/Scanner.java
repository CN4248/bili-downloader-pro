package com.bilidl.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONObject;

/** 检索 UP 主空间作品（视频 / 图文），串行 + 延迟，尽量不触发风控。 */
public class Scanner {
    public static class Job {
        public String id = UUID.randomUUID().toString().substring(0, 8);
        public String mid = "";
        public String name = "";
        public String status = "running";   // running|done|error|canceled
        public String message = "正在检索…";
        public boolean cancel = false;
        public List<Api.SpaceItem> videos = new ArrayList<>();
        public List<Api.SpaceItem> opus = new ArrayList<>();

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("mid", mid);
            o.put("name", name);
            o.put("status", status);
            o.put("message", message);
            o.put("videos", items(videos));
            o.put("opus", items(opus));
            return o;
        }

        private static JSONArray items(List<Api.SpaceItem> list) {
            JSONArray arr = new JSONArray();
            for (Api.SpaceItem s : list) {
                JSONObject o = new JSONObject();
                o.put("kind", s.kind);
                o.put("ident", s.ident);
                o.put("title", s.title);
                o.put("cover", s.cover);
                o.put("date", s.date);
                o.put("duration", s.duration);
                arr.put(o);
            }
            return arr;
        }
    }

    private final Engine engine;
    private final Api api;
    private final Settings settings;
    private final Map<String, Job> jobs = Collections.synchronizedMap(new LinkedHashMap<>());
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    public Scanner(Engine engine) {
        this.engine = engine;
        this.api = engine.api;
        this.settings = engine.settings;
    }

    public Job start(String mid, List<String> tabs) {
        Job job = new Job();
        job.mid = mid;
        jobs.put(job.id, job);
        pool.submit(() -> run(job, tabs));
        return job;
    }

    public Job get(String id) { return jobs.get(id); }

    public void cancel(String id) {
        Job j = jobs.get(id);
        if (j != null) { j.cancel = true; j.status = "canceled"; j.message = "已取消"; }
    }

    private void pause() {
        try {
            long ms = (long) (settings.scanInterval * 1000 + Math.random() * 600);
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    private void run(Job job, List<String> tabs) {
        try {
            Api.UserCard card = api.userCard(job.mid);
            job.name = card.name;
            if (tabs.contains("video")) {
                job.message = "正在检索视频…";
                int pn = 1;
                int expected = 0;
                while (!job.cancel && pn <= settings.maxPages) {
                    List<Api.SpaceItem> page = api.spaceVideos(job.mid, pn, 30);
                    if (expected == 0) expected = api.lastSpaceCount;
                    if (page.isEmpty()) break;
                    job.videos.addAll(page);
                    job.message = "已检索 " + job.videos.size() + " 个视频…";
                    // 服务端可能每页只返回 20 条，不能只看 page.size() 判断是否最后一页
                    if (expected > 0 && job.videos.size() >= expected) break;
                    if (expected <= 0 && page.size() < 20) break;
                    pn++;
                    pause();
                }
            }
            if (tabs.contains("opus")) {
                job.message = "正在检索图文…";
                String offset = "";
                int page = 0;
                while (!job.cancel && page < settings.maxPages) {
                    List<Api.SpaceItem> items = api.spaceOpus(job.mid, offset);
                    if (items.isEmpty()) break;
                    job.opus.addAll(items);
                    job.message = "已检索 " + job.opus.size() + " 个图文…";
                    offset = api.spaceOpusOffset(job.mid, offset);
                    page++;
                    if (offset == null || offset.isEmpty()) break;
                    pause();
                }
            }
            job.status = job.cancel ? "canceled" : "done";
            job.message = "检索完成：视频 " + job.videos.size() + " 个，图文 " + job.opus.size() + " 个";
            engine.log("检索完成 " + job.name + "：" + job.message);
        } catch (Errors.RiskControl e) {
            job.status = "error";
            job.message = "触发风控，请稍后再试：" + e.getMessage();
            engine.log("检索风控：" + job.message);
        } catch (Exception e) {
            job.status = "error";
            job.message = "检索失败：" + e.getMessage();
            engine.log("检索失败：" + e.getMessage());
        }
    }
}
