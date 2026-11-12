package com.bilidl.engine;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONObject;

/** 内置 HTTP 服务：提供本地 WebUI + REST API。 */
public class Server {
    public interface Route {
        JSONObject handle(JSONObject body, Map<String, String> query) throws Exception;
    }

    private final Engine engine;
    private final Subs subs;
    private final Scanner scanner;
    private final File webDir;
    private final Map<String, Route> getRoutes = new LinkedHashMap<>();
    private final Map<String, Route> postRoutes = new LinkedHashMap<>();
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    private volatile ServerSocket socket;
    private volatile boolean running = false;
    public int port;

    public Server(Engine engine, File webDir) {
        this.engine = engine;
        this.webDir = webDir;
        this.subs = new Subs(engine, new File(engine.dataDir, "subs.json"));
        this.scanner = new Scanner(engine);
        routes();
    }

    public void start(int port, String host) throws IOException {
        socket = new ServerSocket(port, 50, host == null ? null : InetAddress.getByName(host));
        this.port = socket.getLocalPort();
        running = true;
        subs.start();
        Thread t = new Thread(() -> {
            while (running) {
                try {
                    final Socket s = socket.accept();
                    pool.submit(() -> serve(s));
                } catch (IOException e) {
                    if (running) engine.log("HTTP 异常：" + e.getMessage());
                }
            }
        }, "bilidl-http");
        t.setDaemon(true);
        t.start();
        engine.log("WebUI 已启动：http://127.0.0.1:" + this.port);
    }

    public void stop() {
        running = false;
        subs.close();
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
        pool.shutdownNow();
    }

    // ---------- 路由 ----------

    private void routes() {
        getRoutes.put("/api/health", (b, q) -> {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("version", "2.0.0-android");
            o.put("ffmpeg", false);
            o.put("login", engine.http.hasCookie());
            return o;
        });
        getRoutes.put("/api/status", (b, q) -> engine.status());
        getRoutes.put("/api/settings", (b, q) -> {
            JSONObject o = engine.settings.toJson();
            o.put("qualities", Settings.qualityList());
            o.put("hints", new JSONArray(Settings.variableHints()));
            return o;
        });
        postRoutes.put("/api/settings", (b, q) -> {
            engine.settings.merge(b);
            engine.saveSettings();
            return engine.settings.toJson();
        });
        postRoutes.put("/api/links/parse", (b, q) -> parseLinks(b.optString("text", "")));
        postRoutes.put("/api/download", (b, q) -> {
            int n = 0;
            JSONArray videos = b.optJSONArray("videos");
            if (videos != null) {
                for (int i = 0; i < videos.length(); i++) {
                    JSONObject v = videos.optJSONObject(i);
                    if (v == null) continue;
                    Engine.VideoSpec spec = new Engine.VideoSpec();
                    spec.ident = v.optString("ident");
                    spec.title = v.optString("title");
                    spec.dir = v.optString("dir");
                    spec.allPages = v.optBoolean("all_pages", engine.settings.defaultAllPages);
                    spec.seasonAll = v.optBoolean("season_all", engine.settings.defaultSeasonAll);
                    JSONArray pages = v.optJSONArray("pages");
                    if (pages != null) for (int j = 0; j < pages.length(); j++) spec.pages.add(pages.optInt(j));
                    JSONArray season = v.optJSONArray("season_bvids");
                    if (season != null) for (int j = 0; j < season.length(); j++) spec.seasonBvids.add(season.optString(j));
                    engine.addVideo(spec);
                    n++;
                }
            }
            JSONArray opus = b.optJSONArray("opus");
            if (opus != null) {
                for (int i = 0; i < opus.length(); i++) {
                    JSONObject o = opus.optJSONObject(i);
                    if (o == null) continue;
                    Engine.OpusSpec spec = new Engine.OpusSpec();
                    spec.ident = o.optString("ident", o.optString("oid"));
                    spec.subKind = o.optString("sub_kind", o.optString("kind", "opus"));
                    spec.title = o.optString("title");
                    spec.dir = o.optString("dir");
                    engine.addOpus(spec);
                    n++;
                }
            }
            JSONObject out = new JSONObject();
            out.put("created", n);
            out.put("tasks", engine.tasks().size());
            return out;
        });
        getRoutes.put("/api/tasks", (b, q) -> engine.status());
        postRoutes.put("/api/tasks/retry", (b, q) -> {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("retried", engine.retryFailed(b.optString("id", "")));
            return o;
        });
        postRoutes.put("/api/tasks/clear", (b, q) -> {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("cleared", engine.clearFinished());
            return o;
        });
        postRoutes.put("/api/tasks/cancel", (b, q) -> {
            JSONObject o = new JSONObject();
            if (b.optBoolean("all", false)) {
                // 取消全部 = 直接从任务列表里删除
                o.put("ok", true);
                o.put("canceled", "all");
                o.put("removed", engine.cancelAll());
            } else {
                o.put("ok", engine.cancel(b.optString("id")));
            }
            return o;
        });
        getRoutes.put("/api/login/status", (b, q) -> engine.api.nav());
        postRoutes.put("/api/login/cookie", (b, q) -> {
            engine.http.setCookie(b.optString("cookie", ""));
            JSONObject o = engine.api.nav();
            o.put("ok", o.optBoolean("is_login", false));
            return o;
        });
        postRoutes.put("/api/login/qr", (b, q) -> {
            Api.QrCode code = engine.api.qrGenerate();
            JSONObject o = new JSONObject();
            o.put("url", code.url);
            o.put("key", code.key);
            return o;
        });
        getRoutes.put("/api/login/qr/poll", (b, q) -> engine.api.qrPoll(q.getOrDefault("key", ""), engine.http));
        postRoutes.put("/api/logout", (b, q) -> {
            engine.http.clearCookie();
            JSONObject o = new JSONObject();
            o.put("ok", true);
            return o;
        });
        postRoutes.put("/api/space/scan", (b, q) -> {
            List<String> tabs = new ArrayList<>();
            JSONArray arr = b.optJSONArray("tabs");
            if (arr != null) for (int i = 0; i < arr.length(); i++) tabs.add(arr.optString(i));
            if (tabs.isEmpty()) { tabs.add("video"); tabs.add("opus"); }
            Scanner.Job job = scanner.start(b.optString("mid"), tabs);
            JSONObject o = new JSONObject();
            o.put("job", job.id);
            return o;
        });
        getRoutes.put("/api/space/scan", (b, q) -> {
            Scanner.Job job = scanner.get(q.getOrDefault("id", ""));
            if (job == null) throw new Errors.NotFound("任务不存在");
            return job.toJson();
        });
        postRoutes.put("/api/space/scan/cancel", (b, q) -> {
            scanner.cancel(b.optString("id"));
            JSONObject o = new JSONObject();
            o.put("ok", true);
            return o;
        });
        getRoutes.put("/api/subs", (b, q) -> subs.snapshot());
        postRoutes.put("/api/subs", (b, q) -> subs.upsert(b));
        postRoutes.put("/api/subs/delete", (b, q) -> {
            JSONObject o = new JSONObject();
            o.put("ok", subs.delete(b.optString("id")));
            return o;
        });
        postRoutes.put("/api/subs/config", (b, q) -> subs.setConfig(b));
        postRoutes.put("/api/subs/check", (b, q) -> {
            JSONObject o = subs.checkNow(b.optString("id"));
            o.put("state", subs.snapshot());
            return o;
        });
        getRoutes.put("/api/events", (b, q) -> {
            JSONObject o = new JSONObject();
            o.put("events", new JSONArray(engine.eventsSnapshot()));
            return o;
        });
    }

    private JSONObject parseLinks(String text) throws Exception {
        JSONArray out = new JSONArray();
        for (String raw : Links.extract(text)) {
            JSONObject item = new JSONObject();
            try {
                Links.Target t = Links.parse(engine.http, raw);
                item.put("ok", true);
                item.put("kind", t.kind);
                item.put("ident", t.ident);
                item.put("url", t.url);
                if ("video".equals(t.kind)) {
                    Api.VideoInfo v = engine.api.video(t.ident);
                    item.put("title", v.title);
                    item.put("cover", v.cover);
                    item.put("author", v.ownerName);
                    item.put("mid", v.ownerMid);
                    item.put("date", v.pubdate);
                    JSONArray pages = new JSONArray();
                    for (Api.Page p : v.pages) {
                        JSONObject po = new JSONObject();
                        po.put("index", p.index);
                        po.put("title", p.part);
                        po.put("duration", p.duration);
                        pages.put(po);
                    }
                    item.put("pages", pages);
                    JSONArray season = new JSONArray();
                    for (Api.SeasonEp ep : v.season) {
                        JSONObject so = new JSONObject();
                        so.put("bvid", ep.bvid);
                        so.put("title", ep.title);
                        season.put(so);
                    }
                    item.put("season", season);
                    item.put("season_title", v.seasonTitle);
                } else if ("opus".equals(t.kind) || "dynamic".equals(t.kind)) {
                    Api.OpusInfo info = "dynamic".equals(t.kind) ? engine.api.dynamic(t.ident) : engine.api.opus(t.ident);
                    item.put("title", info.title);
                    item.put("author", info.author);
                    item.put("count", info.images.size());
                } else if ("article".equals(t.kind)) {
                    Api.OpusInfo info = engine.api.article(t.ident);
                    item.put("title", info.title);
                    item.put("author", info.author);
                    item.put("count", info.images.size());
                } else if ("space".equals(t.kind)) {
                    item.put("mid", t.mid);
                    item.put("tab", t.tab);
                    item.put("title", "UP 主空间：" + t.mid);
                }
            } catch (Exception e) {
                item.put("ok", false);
                item.put("url", raw);
                item.put("error", String.valueOf(e.getMessage()));
            }
            out.put(item);
        }
        JSONObject o = new JSONObject();
        o.put("items", out);
        return o;
    }

    // ---------- HTTP ----------

    private void serve(Socket sock) {
        try {
            InputStream in = new BufferedInputStream(sock.getInputStream());
            String requestLine = readLine(in);
            if (requestLine == null) { sock.close(); return; }
            String[] parts = requestLine.split(" ");
            if (parts.length < 3) { sock.close(); return; }
            String method = parts[0], target = parts[1];
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(Locale.ROOT), line.substring(c + 1).trim());
            }
            int len = 0;
            try { len = Integer.parseInt(headers.getOrDefault("content-length", "0")); } catch (Exception ignored) { }
            byte[] bodyBytes = new byte[len];
            int read = 0;
            while (read < len) {
                int n = in.read(bodyBytes, read, len - read);
                if (n < 0) break;
                read += n;
            }
            String bodyText = new String(bodyBytes, StandardCharsets.UTF_8);

            String path = target, query = "";
            int qi = target.indexOf('?');
            if (qi >= 0) { path = target.substring(0, qi); query = target.substring(qi + 1); }
            Map<String, String> q = parseQuery(query);

            if (path.startsWith("/api/")) {
                JSONObject body = new JSONObject();
                if (!bodyText.isEmpty()) {
                    try { body = new JSONObject(bodyText); } catch (Exception ignored) { }
                }
                Route route = "GET".equals(method) ? getRoutes.get(path) : null;
                if (route == null && "POST".equals(method) && postRoutes.containsKey(path)) route = postRoutes.get(path);
                if ("GET".equals(method) && route == null && postRoutes.containsKey(path)) {
                    JSONObject out = new JSONObject();
                    out.put("error", "请用 POST");
                    send(sock, 405, out.toString(), "application/json");
                    return;
                }
                if (route == null && "POST".equals(method) && getRoutes.containsKey(path)) route = getRoutes.get(path);
                if (route == null) {
                    JSONObject out = new JSONObject();
                    out.put("error", "接口不存在：" + path);
                    send(sock, 404, out.toString(), "application/json");
                    return;
                }
                try {
                    JSONObject out = route.handle(body, q);
                    send(sock, 200, out.toString(), "application/json; charset=utf-8");
                } catch (Errors.RiskControl e) {
                    send(sock, 429, err(e.getMessage()), "application/json");
                } catch (Errors.AuthRequired e) {
                    send(sock, 401, err(e.getMessage()), "application/json");
                } catch (Errors.NotFound e) {
                    send(sock, 404, err(e.getMessage()), "application/json");
                } catch (Errors.BiliError e) {
                    send(sock, 400, err(e.getMessage()), "application/json");
                }
                return;
            }
            serveStatic(sock, path);
        } catch (Exception e) {
            try { send(sock, 500, err(e.getMessage()), "application/json"); } catch (Exception ignored) { }
        } finally {
            try { sock.close(); } catch (IOException ignored) { }
        }
    }

    private static String err(String msg) {
        JSONObject o = new JSONObject();
        o.put("error", msg == null ? "未知错误" : msg);
        return o.toString();
    }

    private void serveStatic(Socket sock, String path) throws IOException {
        if (path.equals("/")) path = "/index.html";
        File f = new File(webDir, path.replace("..", ""));
        if (!f.exists() || f.isDirectory()) {
            send(sock, 404, "not found", "text/plain; charset=utf-8");
            return;
        }
        String name = f.getName().toLowerCase(Locale.ROOT);
        String type = name.endsWith(".html") ? "text/html; charset=utf-8"
                : name.endsWith(".js") ? "application/javascript; charset=utf-8"
                : name.endsWith(".css") ? "text/css; charset=utf-8"
                : name.endsWith(".png") ? "image/png"
                : name.endsWith(".svg") ? "image/svg+xml"
                : name.endsWith(".json") ? "application/json; charset=utf-8"
                : "application/octet-stream";
        byte[] data = readFile(f);
        send(sock, 200, data, type);
    }

    private static byte[] readFile(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private void send(Socket sock, int code, String body, String type) throws IOException {
        send(sock, code, body.getBytes(StandardCharsets.UTF_8), type);
    }

    private void send(Socket sock, int code, byte[] body, String type) throws IOException {
        OutputStream out = sock.getOutputStream();
        String head = "HTTP/1.1 " + code + " " + statusText(code) + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 429: return "Too Many Requests";
            default: return "Internal Server Error";
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') bos.write(c);
        }
        if (c < 0 && bos.size() == 0) return null;
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> out = new HashMap<>();
        if (q == null || q.isEmpty()) return out;
        for (String kv : q.split("&")) {
            int eq = kv.indexOf('=');
            try {
                if (eq < 0) out.put(URLDecoder.decode(kv, "UTF-8"), "");
                else out.put(URLDecoder.decode(kv.substring(0, eq), "UTF-8"),
                        URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return out;
    }
}
