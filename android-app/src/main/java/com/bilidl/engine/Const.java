package com.bilidl.engine;

import java.util.LinkedHashMap;
import java.util.Map;

/** 全局常量（与桌面版 bilidl/constants.py 保持一致）。 */
public final class Const {
    private Const() {}

    public static final String SITE = "https://www.bilibili.com";
    public static final String API = "https://api.bilibili.com";
    public static final String APP_API = "https://app.bilibili.com";
    public static final String PASSPORT = "https://passport.bilibili.com";

    public static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Safari/537.36";

    public static final String APP_KEY = "1d8b6e7d45233436";
    public static final String APP_SEC = "560c52ccd288fed045859ed18bffd973";
    public static final String APP_MOBI_APP = "android";
    public static final String APP_BUILD = "7980300";

    public static final int FNVAL_PROGRESSIVE = 0;
    public static final int[] UNSUPPORTED_VIDEO_IDS = {125, 126};
    public static final String[] CODEC_PRIORITY = {"avc1", "hev1", "hvc1", "av01"};

    public static final int[] RISK_CODES = {-352, -412, -403, -509, -799};
    public static final int[] COOKIE_FAILURE_CODES = {-101, -111};
    public static final int[] RISK_BACKOFF = {20, 45, 90};
    public static final int MAX_API_RETRY = 3;

    public static final int CHUNK_SIZE = 256 * 1024;

    public static final String[] COOKIE_KEYS = {
        "SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "buvid3", "buvid4", "b_nut"
    };

    public static final int[] MIXIN_KEY_ENC_TAB = {
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
        33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
        61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
        36, 20, 34, 44, 52
    };

    /** 清晰度 → qn，顺序即界面显示顺序。 */
    public static final Map<String, Integer> QUALITY = new LinkedHashMap<>();
    static {
        QUALITY.put("8K", 127);
        QUALITY.put("杜比视界", 126);
        QUALITY.put("HDR", 125);
        QUALITY.put("4K", 120);
        QUALITY.put("1080P60", 116);
        QUALITY.put("1080P+", 112);
        QUALITY.put("1080P", 80);
        QUALITY.put("720P60", 74);
        QUALITY.put("720P", 64);
        QUALITY.put("480P", 32);
        QUALITY.put("360P", 16);
    }

    public static final String[] SHORT_HOSTS = {
        "b23.tv", "bili2233.cn", "bili22.cn", "bili23.cn", "bili33.cn"
    };

    public static final String DEFAULT_VIDEO_TEMPLATE = "<video_title>-<video_id>-<video_episode>.<ext>";
    public static final String DEFAULT_OPUS_TEMPLATE = "<opus_title>-<opus_id>-<opus_order>.<ext>";

    public static int qnOf(String quality) {
        Integer q = QUALITY.get(quality);
        return q == null ? 116 : q;
    }
}
