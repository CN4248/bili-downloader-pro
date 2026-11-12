"""全局常量：请求头、清晰度、WBI 混淆表与风控相关默认值。"""

from __future__ import annotations

APP_NAME = "BiliDL-PRO"
APP_VERSION = "2.4.2"

DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 清晰度：设置页展示名 -> qn。116 即 1080P60（需要 DASH 音视频合并）。
QUALITY_CHOICES: dict[str, int] = {
    "8K": 127,
    "杜比视界": 126,
    "HDR": 125,
    "4K": 120,
    "1080P60": 116,
    "1080P+": 112,
    "1080P": 80,
    "720P60": 74,
    "720P": 64,
    "480P": 32,
    "360P": 16,
}
QUALITY_LABELS: dict[int, str] = {v: k for k, v in QUALITY_CHOICES.items()}
DEFAULT_QUALITY = "1080P60"

# fnval=0 只返回 mp4 直链（最高 1080P），fnval=4048 返回 DASH 分离流。
FNVAL_PROGRESSIVE = 0
FNVAL_DASH = 4048
PROGRESSIVE_MAX_QN = 80

# HDR / 杜比视界流无法直接作为普通 mp4 使用
UNSUPPORTED_VIDEO_IDS = frozenset({125, 126})
# DASH 视频编码优先级：AVC 兼容性最好，其次 HEVC，最后 AV1
CODEC_PRIORITY = ("avc1", "hev1", "hvc1", "av01")

VIDEO_HOST_SUFFIXES = ("bilivideo.com", "bilivideo.cn")
IMAGE_HOST_SUFFIXES = ("hdslb.com", "bilibili.com")

# B站 Web 端 WBI 签名混淆表
MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

# App 端签名（用于获取 UP 主投稿列表，Web 接口在部分网络下会被风控）
APP_KEY = "1d8b6e7d45233436"
APP_SEC = "560c52ccd288fed045859ed18bffd973"
APP_MOBI_APP = "android"
APP_BUILD = 7980300

# 风控错误码：-101 未登录、-111 csrf 校验失败、-352 风控校验失败、-412 请求被拦截
COOKIE_FAILURE_CODES = frozenset({-101, -111, -352, -412, -403, -509})
RISK_CODES = frozenset({-352, -412, -403, -509, -799})

# 默认节流参数（单位秒）。宁可慢，也不要撞风控。
DEFAULT_API_INTERVAL = 1.2
DEFAULT_SCAN_INTERVAL = 1.6
DEFAULT_FILE_INTERVAL = 0.8
DEFAULT_CONCURRENCY = 2
MAX_API_RETRY = 3
RISK_BACKOFF = (20, 45, 90)

CHUNK_SIZE = 1024 * 256
