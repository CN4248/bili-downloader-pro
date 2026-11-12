package com.bilidl.engine;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

/** 下载设置，持久化到 dataDir/settings.json。 */
public class Settings {
    public String videoDir = "";
    public String opusDir = "";
    public String quality = "1080P60";
    public String videoTemplate = Const.DEFAULT_VIDEO_TEMPLATE;
    public String opusTemplate = Const.DEFAULT_OPUS_TEMPLATE;
    public boolean defaultAllPages = true;
    public boolean defaultSeasonAll = false;
    public boolean skipExisting = true;
    public double apiInterval = 1.2;
    public double scanInterval = 1.6;
    public double fileInterval = 0.8;
    public int concurrency = 2;
    public int maxPages = 200;
    public String proxy = "";

    public static Settings defaults(File dataDir) {
        Settings s = new Settings();
        s.videoDir = new File(dataDir, "视频").getAbsolutePath();
        s.opusDir = new File(dataDir, "图文").getAbsolutePath();
        return s;
    }

    public void normalize(File dataDir) {
        quality = Const.QUALITY.containsKey(quality) ? quality : "1080P60";
        if (videoDir == null || videoDir.trim().isEmpty()) videoDir = new File(dataDir, "视频").getAbsolutePath();
        if (opusDir == null || opusDir.trim().isEmpty()) opusDir = new File(dataDir, "图文").getAbsolutePath();
        if (videoTemplate == null || videoTemplate.trim().isEmpty()) videoTemplate = Const.DEFAULT_VIDEO_TEMPLATE;
        if (opusTemplate == null || opusTemplate.trim().isEmpty()) opusTemplate = Const.DEFAULT_OPUS_TEMPLATE;
        apiInterval = clamp(apiInterval, 0.5, 10);
        scanInterval = clamp(scanInterval, 0.8, 15);
        fileInterval = clamp(fileInterval, 0, 10);
        concurrency = (int) clamp(concurrency, 1, 4);
        maxPages = (int) clamp(maxPages, 1, 2000);
    }

    private static double clamp(double v, double lo, double hi) {
        if (Double.isNaN(v)) return lo;
        return Math.max(lo, Math.min(hi, v));
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        o.put("video_dir", videoDir);
        o.put("opus_dir", opusDir);
        o.put("quality", quality);
        o.put("video_template", videoTemplate);
        o.put("opus_template", opusTemplate);
        o.put("default_all_pages", defaultAllPages);
        o.put("default_season_all", defaultSeasonAll);
        o.put("skip_existing", skipExisting);
        o.put("api_interval", apiInterval);
        o.put("scan_interval", scanInterval);
        o.put("file_interval", fileInterval);
        o.put("concurrency", concurrency);
        o.put("max_pages", maxPages);
        o.put("proxy", proxy);
        return o;
    }

    public static Settings fromJson(JSONObject o, File dataDir) {
        Settings s = defaults(dataDir);
        s.videoDir = o.optString("video_dir", s.videoDir);
        s.opusDir = o.optString("opus_dir", s.opusDir);
        s.quality = o.optString("quality", s.quality);
        s.videoTemplate = o.optString("video_template", s.videoTemplate);
        s.opusTemplate = o.optString("opus_template", s.opusTemplate);
        s.defaultAllPages = o.optBoolean("default_all_pages", s.defaultAllPages);
        s.defaultSeasonAll = o.optBoolean("default_season_all", s.defaultSeasonAll);
        s.skipExisting = o.optBoolean("skip_existing", s.skipExisting);
        s.apiInterval = o.optDouble("api_interval", s.apiInterval);
        s.scanInterval = o.optDouble("scan_interval", s.scanInterval);
        s.fileInterval = o.optDouble("file_interval", s.fileInterval);
        s.concurrency = o.optInt("concurrency", s.concurrency);
        s.maxPages = o.optInt("max_pages", s.maxPages);
        s.proxy = o.optString("proxy", "");
        s.normalize(dataDir);
        return s;
    }

    public void merge(JSONObject o) {
        if (o.has("video_dir")) videoDir = o.optString("video_dir");
        if (o.has("opus_dir")) opusDir = o.optString("opus_dir");
        if (o.has("quality")) quality = o.optString("quality");
        if (o.has("video_template")) videoTemplate = o.optString("video_template");
        if (o.has("opus_template")) opusTemplate = o.optString("opus_template");
        if (o.has("default_all_pages")) defaultAllPages = o.optBoolean("default_all_pages");
        if (o.has("default_season_all")) defaultSeasonAll = o.optBoolean("default_season_all");
        if (o.has("skip_existing")) skipExisting = o.optBoolean("skip_existing");
        if (o.has("api_interval")) apiInterval = o.optDouble("api_interval", apiInterval);
        if (o.has("scan_interval")) scanInterval = o.optDouble("scan_interval", scanInterval);
        if (o.has("file_interval")) fileInterval = o.optDouble("file_interval", fileInterval);
        if (o.has("concurrency")) concurrency = o.optInt("concurrency", concurrency);
        if (o.has("max_pages")) maxPages = o.optInt("max_pages", maxPages);
        if (o.has("proxy")) proxy = o.optString("proxy");
    }

    public static List<String> variableHints() {
        List<String> out = new ArrayList<>();
        out.add("<video_title>=<video_title> 视频标题");
        out.add("<video_id>=<video_id> 视频BV号");
        out.add("<video_episode>=<video_episode> 视频分集序号");
        out.add("<opus_title>=<opus_title> 专栏或动态标题");
        out.add("<opus_id>=<opus_id> 专栏或动态id");
        out.add("<opus_order>=<opus_order> 专栏或动态图片序号");
        return out;
    }

    public static void save(File file, Settings s) {
        try {
            if (file.getParentFile() != null) file.getParentFile().mkdirs();
            Files.write(file.toPath(), s.toJson().toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    public static Settings load(File file, File dataDir) {
        try {
            if (!file.exists()) return defaults(dataDir);
            String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            Settings s = fromJson(new JSONObject(text), dataDir);
            s.normalize(dataDir);
            return s;
        } catch (Exception e) {
            return defaults(dataDir);
        }
    }

    public static JSONArray qualityList() {
        JSONArray arr = new JSONArray();
        for (String k : Const.QUALITY.keySet()) arr.put(k);
        return arr;
    }
}
