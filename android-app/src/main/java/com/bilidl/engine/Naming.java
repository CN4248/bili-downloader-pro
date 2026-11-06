package com.bilidl.engine;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;

/** 文件名模板渲染（与桌面版 naming.py 一致）。 */
public final class Naming {
    private Naming() {}

    public static final Map<String, String> CN_ALIAS = new LinkedHashMap<>();
    static {
        CN_ALIAS.put("视频标题", "video_title");
        CN_ALIAS.put("视频BV号", "video_id");
        CN_ALIAS.put("视频分集序号", "video_episode");
        CN_ALIAS.put("分集标题", "video_page_title");
        CN_ALIAS.put("UP主昵称", "video_author");
        CN_ALIAS.put("实际清晰度", "video_quality");
        CN_ALIAS.put("发布时间", "video_date");
        CN_ALIAS.put("专栏或动态标题", "opus_title");
        CN_ALIAS.put("专栏或动态id", "opus_id");
        CN_ALIAS.put("专栏或动态图片序号", "opus_order");
        CN_ALIAS.put("专栏或动态作者", "opus_author");
        CN_ALIAS.put("专栏或动态日期", "opus_date");
        CN_ALIAS.put("拓展名", "ext");
    }

    public static String render(String template, Map<String, String> vars, String fallback) {
        String tpl = template == null ? "" : template.trim();
        if (tpl.isEmpty()) tpl = fallback;
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < tpl.length()) {
            char c = tpl.charAt(i);
            String open = null, close = null;
            if (c == '<') { open = "<"; close = ">"; }
            else if (c == '$' && i + 1 < tpl.length() && tpl.charAt(i + 1) == '{') { open = "${"; close = "}"; }
            if (open != null) {
                int end = tpl.indexOf(close, i + open.length());
                if (end > 0) {
                    String name = tpl.substring(i + open.length(), end).trim();
                    if (CN_ALIAS.containsKey(name)) name = CN_ALIAS.get(name);
                    String val = vars.get(name);
                    out.append(val == null ? "" : val);
                    i = end + close.length();
                    continue;
                }
            }
            out.append(c);
            i++;
        }
        String s = sanitize(out.toString());
        return s.isEmpty() ? sanitize(fallback) : s;
    }

    /** 渲染成相对路径：模板里的 / 或反斜杠会变成子文件夹（每段单独清理，禁止 ..）。 */
    public static String renderPath(String template, Map<String, String> vars, String fallback) {
        String tpl = template == null ? "" : template.trim();
        if (tpl.isEmpty()) tpl = fallback;
        String rendered = renderRaw(tpl, vars);
        String[] raw = rendered.split("[\\\\/]+");
        StringBuilder sb = new StringBuilder();
        for (String part : raw) {
            String seg = sanitize(part);
            if (seg.isEmpty() || ".".equals(seg) || "..".equals(seg)) continue;
            if (sb.length() > 0) sb.append('/');
            sb.append(seg);
        }
        String out = sb.length() == 0 ? sanitize(fallback) : sb.toString();
        return out;
    }

    /** 只做变量替换，不做非法字符处理（供 renderPath 分段清理用）。 */
    public static String renderRaw(String tpl, Map<String, String> vars) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < tpl.length()) {
            char c = tpl.charAt(i);
            String open = null, close = null;
            if (c == '<') { open = "<"; close = ">"; }
            else if (c == '$' && i + 1 < tpl.length() && tpl.charAt(i + 1) == '{') { open = "${"; close = "}"; }
            if (open != null) {
                int end = tpl.indexOf(close, i + open.length());
                if (end > 0) {
                    String name = tpl.substring(i + open.length(), end).trim();
                    if (CN_ALIAS.containsKey(name)) name = CN_ALIAS.get(name);
                    String val = vars.get(name);
                    out.append(val == null ? "" : val);
                    i = end + close.length();
                    continue;
                }
            }
            out.append(c);
            i++;
        }
        return out.toString();
    }

    /** 确保相对路径最后一段带扩展名。 */
    public static String ensureExtPath(String rel, String ext) {
        int slash = rel.lastIndexOf('/');
        String head = slash >= 0 ? rel.substring(0, slash + 1) : "";
        String name = slash >= 0 ? rel.substring(slash + 1) : rel;
        return head + ensureExt(name, ext);
    }

    public static String sanitize(String name) {
        String s = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").replaceAll("\\s+", " ").trim();
        s = s.replaceAll("^[. ]+", "").replaceAll("[. ]+$", "");
        if (s.length() > 170) {
            int dot = s.lastIndexOf('.');
            if (dot > 20 && s.length() - dot <= 8) s = s.substring(0, 170 - (s.length() - dot)) + s.substring(dot);
            else s = s.substring(0, 170);
        }
        return s;
    }

    /** 确保扩展名。 */
    public static String ensureExt(String name, String ext) {
        String lower = name.toLowerCase();
        if (lower.endsWith("." + ext.toLowerCase())) return name;
        if (name.matches(".*\\.[A-Za-z0-9]{1,5}$")) return name;
        return name + "." + ext;
    }

    /** 同名文件自动追加 -1/-2。 */
    public static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        String base = name, ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) { base = name.substring(0, dot); ext = name.substring(dot); }
        for (int i = 1; i < 9999; i++) {
            File c = new File(dir, base + "-" + i + ext);
            if (!c.exists()) return c;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }
}
