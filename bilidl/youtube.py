"""YouTube 支持（基于 yt-dlp）：解析视频/频道/播放列表、下载音视频与字幕。

这里只负责「从 YouTube 拿数据」，链接识别在 links.py，命名/落盘/任务调度在
downloader.py —— 目标是把 B 站那套流程原样复用，命名变量也保持一致。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Callable

from .constants import QUALITY_CHOICES
from .errors import BiliError, DownloadError, ParseError

try:  # 缺依赖时 Web 服务照常启动，只是 YouTube 功能不可用
    import yt_dlp
    from yt_dlp.utils import DownloadCancelled
    from yt_dlp.utils import DownloadError as _YtError

    HAS_YTDLP = True
except Exception:  # pragma: no cover - 环境缺依赖
    yt_dlp = None  # type: ignore[assignment]

    class DownloadCancelled(Exception):  # type: ignore[no-redef]
        """占位：未安装 yt-dlp 时的取消异常。"""

    class _YtError(Exception):  # type: ignore[no-redef]
        """占位：未安装 yt-dlp 时的下载异常。"""

    HAS_YTDLP = False

try:  # JS challenge 求解脚本（登录态 / 需要 n-sig 的客户端必需）
    import yt_dlp_ejs as _yt_dlp_ejs  # noqa: F401

    HAS_EJS = True
except Exception:  # pragma: no cover - 没装时降级
    HAS_EJS = False


def _proxy(settings: Any) -> str:
    """YouTube 用的代理地址。

    - 设置里可以给 B站 和 YouTube 分别开关代理；
    - 还能给 YouTube 单独填一个地址（proxy_youtube），留空就共用 proxy。
    """
    fn = getattr(settings, "youtube_proxy", None)
    if callable(fn):
        try:
            return str(fn() or "").strip()
        except Exception:  # noqa: BLE001 - 配置对象异常时退回共用代理
            pass
    return str(getattr(settings, "proxy", "") or "").strip()


# B 站清晰度标签 → YouTube 的 height 上限，保证「选 4K 就尽量拿 4K」的语义一致
HEIGHT = {
    "8K": 4320,
    "杜比视界": 2160,
    "HDR": 2160,
    "4K": 2160,
    "1080P60": 1080,
    "1080P+": 1080,
    "1080P": 1080,
    "720P60": 720,
    "720P": 720,
    "480P": 480,
    "360P": 360,
}

# 字幕只取这几种语言：YouTube 的自动字幕动辄上百种，全下会刷出上百个文件
SUB_LANGS = ("zh-Hans", "zh-CN", "zh", "en", "ja")

_VIDEO_URL = "https://www.youtube.com/watch?v={vid}"


def available() -> bool:
    return HAS_YTDLP


def version() -> str:
    try:
        return str(yt_dlp.version.__version__)  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        return ""


def _runtime_path() -> str:
    """返回可用的 deno 路径（没有则空串）。

    yt-dlp 需要 JS runtime 才能解出完整格式（尤其 1080P 以上）；deno 是 PyPI
    包里自带的可执行文件，通常和当前 Python 在同一个 bin 目录。
    """
    # 注意：不能用 resolve()——venv 里的 python 是符号链接，resolve 之后会跳到系统
    # 的 /usr/bin，反而找不到 venv 自带的 deno。
    here = Path(sys.executable).parent
    prefix = Path(sys.prefix) / "bin"
    candidates = []
    for folder in (here, prefix, Path(getattr(sys, "_MEIPASS", here))):
        candidates += [folder / "deno", folder / "deno.exe"]
    frozen = getattr(sys, "frozen", False)
    if frozen:
        candidates += [
            Path(sys.executable).parent / "deno",
            Path(sys.executable).parent / "deno.exe",
        ]
    exe = "deno.exe" if os.name == "nt" else "deno"
    for base in (Path.home() / ".deno" / "bin", Path.home() / "bin"):
        candidates.append(base / exe)
    for path in candidates:
        if path.is_file():
            return str(path)
    found = None
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        cand = Path(folder) / exe
        if cand.is_file():
            found = str(cand)
            break
    return found or ""


def _node_path() -> str:
    """System node/nodejs（Docker 镜像里装的是 nodejs，方便复用）。"""
    for name in ("node", "nodejs"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def status() -> dict[str, Any]:
    deno = _runtime_path()
    node = _node_path()
    return {
        "available": HAS_YTDLP,
        "version": version(),
        "js_runtime": deno or node or "",
        "deno": bool(deno),
        "node": bool(node),
        "ejs": HAS_EJS,
    }


def _js_runtimes() -> dict[str, Any]:
    runtimes: dict[str, Any] = {}
    deno = _runtime_path()
    node = _node_path()
    # 优先 deno（yt-dlp 官方推荐）；没有就退回 node（Docker 镜像里就有）
    if deno:
        runtimes["deno"] = {"path": deno}
    elif node:
        runtimes["node"] = {"path": node}
    else:
        # 没有运行时也开着：yt-dlp 会退回到受限客户端，至少能下到 720P/1080P
        runtimes["deno"] = {}
    return runtimes


def cookie_path(data_dir: Path | str) -> Path:
    return Path(data_dir) / "youtube-cookies.txt"


def _to_netscape(text: str) -> str:
    """把浏览器里复制的 Cookie 转成 yt-dlp 能吃的 Netscape 格式。

    支持三种输入：已经是 Netscape 文件的内容、`name=value; name2=value2` 串、
    浏览器插件导出的 JSON（[{domain,name,value,...}] 或 {"cookies":[...]}）。
    """
    text = (text or "").strip()
    if not text:
        return ""
    if text.lstrip().startswith("# Netscape") or "\t" in text.splitlines()[0]:
        return text
    pairs: list[tuple[str, str, str]] = []
    if text.startswith("[") or text.startswith("{"):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, dict):
            data = data.get("cookies") or []
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name") or "").strip()
                value = str(item.get("value") or "")
                domain = str(item.get("domain") or ".youtube.com").strip() or ".youtube.com"
                if name:
                    pairs.append((domain, name, value))
    if not pairs:
        for part in re.split(r"[;\n]+", text):
            part = part.strip()
            if not part or "=" not in part:
                continue
            name, _, value = part.partition("=")
            name = name.strip()
            if name:
                pairs.append((".youtube.com", name, value.strip()))
    if not pairs:
        return ""
    expires = int(time.time()) + 400 * 24 * 3600
    lines = ["# Netscape HTTP Cookie File", "# 由 BiliDL 自动生成，请勿手工编辑"]
    for domain, name, value in pairs:
        domain = domain if domain.startswith(".") else "." + domain.lstrip(".")
        lines.append(
            "\t".join([domain, "TRUE", "/", "TRUE", str(expires), name, value])
        )
    return "\n".join(lines) + "\n"


def write_cookies(data_dir: Path | str, text: str) -> None:
    """把设置里的 Cookie 文本落到 data 目录（自动转成 Netscape 格式）。"""
    path = cookie_path(data_dir)
    text = _to_netscape(text)
    if not text:
        try:
            path.unlink()
        except OSError:
            pass
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _opts(settings: Any, data_dir: Path | str, **extra: Any) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "no_color": True,
        "noplaylist": True,
        "ignoreerrors": False,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 2,
        "concurrent_fragment_downloads": 1,
        "js_runtimes": _js_runtimes(),
        # 直播流不停机，避免一个直播间把磁盘写满；有 Vod 时正常下
        "live_from_start": False,
    }
    proxy = _proxy(settings)
    if proxy:
        opts["proxy"] = proxy
    # yt-dlp 自己找 ffmpeg 时不认 BILIDL_FFMPEG，这里用程序找到的路径显式告诉它，
    # 否则「DASH 视频轨 + 音频轨」会因为 "ffmpeg is not installed" 直接失败。
    try:
        from . import ffmpeg as ffmpeg_mod

        if ffmpeg_mod.FFMPEG:
            opts["ffmpeg_location"] = str(ffmpeg_mod.FFMPEG)
    except Exception:  # noqa: BLE001 - ffmpeg 缺失时交给 yt-dlp 自己报错
        pass
    cookies = cookie_path(data_dir)
    if cookies.is_file() and cookies.stat().st_size > 0:
        opts["cookiefile"] = str(cookies)
    opts.update(extra)
    return opts


def _thumb(info: dict[str, Any]) -> str:
    """优先取 jpg 封面（YouTube 的 webp 变体换成同尺寸 jpg，播放器/媒体库认得更广）。"""
    url = str(info.get("thumbnail") or "")
    if not url:
        best = 0
        for thumb in info.get("thumbnails") or []:
            width = int(thumb.get("width") or 0)
            if thumb.get("url") and width >= best:
                best = width
                url = str(thumb["url"])
    if "/vi_webp/" in url and url.endswith(".webp"):
        url = url.replace("/vi_webp/", "/vi/").replace(".webp", ".jpg")
    return url


def thumb_for(vid: str, quality: str = "maxresdefault") -> str:
    return f"https://i.ytimg.com/vi/{vid}/{quality}.jpg"


def norm_video(info: dict[str, Any]) -> dict[str, Any]:
    """把 yt-dlp 的 info 归一成项目内部用的精简结构。"""
    vid = str(info.get("id") or "")
    formats = []
    for item in info.get("formats") or []:
        if not isinstance(item, dict):
            continue
        formats.append(
            {
                "id": str(item.get("format_id") or ""),
                "height": int(item.get("height") or 0),
                "ext": str(item.get("ext") or ""),
                "vcodec": str(item.get("vcodec") or ""),
                "acodec": str(item.get("acodec") or ""),
                "filesize": int(item.get("filesize") or item.get("filesize_approx") or 0),
                "fps": float(item.get("fps") or 0),
            }
        )
    return {
        "id": vid,
        "title": str(info.get("title") or ""),
        "uploader": str(info.get("uploader") or info.get("channel") or ""),
        "channel_id": str(info.get("channel_id") or ""),
        "channel_url": str(info.get("channel_url") or ""),
        "duration": int(info.get("duration") or 0),
        "timestamp": int(info.get("timestamp") or 0),
        "upload_date": str(info.get("upload_date") or ""),
        "thumb": _thumb(info) or thumb_for(vid),
        "description": str(info.get("description") or ""),
        "webpage_url": str(info.get("webpage_url") or _VIDEO_URL.format(vid=vid)),
        "live_status": str(info.get("live_status") or ""),
        "subtitles": sorted((info.get("subtitles") or {}).keys()),
        "automatic_captions": sorted((info.get("automatic_captions") or {}).keys()),
        "formats": formats,
    }


def _flat_entry(entry: dict[str, Any]) -> dict[str, Any]:
    vid = str(entry.get("id") or "")
    return {
        "id": vid,
        "title": str(entry.get("title") or ""),
        "duration": int(entry.get("duration") or 0),
        "url": str(entry.get("url") or _VIDEO_URL.format(vid=vid)),
        "thumb": _thumb(entry) or thumb_for(vid, "mqdefault"),
        "uploader": str(entry.get("uploader") or entry.get("channel") or ""),
        "channel_id": str(entry.get("channel_id") or ""),
    }


def norm_list(info: dict[str, Any], limit: int = 0) -> dict[str, Any]:
    entries = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        item = _flat_entry(entry)
        if not item["id"]:
            continue
        entries.append(item)
        if limit and len(entries) >= limit:
            break
    kind = "playlist" if info.get("_type") in ("playlist", "multi_video") else "channel"
    if str(info.get("_type") or "") == "channel":
        kind = "channel"
    return {
        "kind": kind,
        "id": str(info.get("id") or ""),
        "title": str(info.get("title") or info.get("channel") or info.get("uploader") or ""),
        "channel_id": str(info.get("channel_id") or ""),
        "uploader": str(info.get("uploader") or info.get("channel") or ""),
        "thumb": _thumb(info),
        "webpage_url": str(info.get("webpage_url") or ""),
        "entries": entries,
        "total": int(info.get("playlist_count") or info.get("n_entries") or len(entries)),
    }


def format_selector(quality: str, *, audio_only: bool = False, video_only: bool = False) -> str:
    """把项目的清晰度标签翻成 yt-dlp 的 format 表达式。

    优先 H.264 + AAC（电视/车机/媒体库兼容性最好），拿不到再退回任意编码。
    """
    height = HEIGHT.get(quality) or HEIGHT["1080P60"]
    if audio_only:
        return "bestaudio[ext=m4a]/bestaudio/best"
    if video_only:
        return f"bv[height<={height}]/b[height<={height}]/b"
    return (
        f"bv[height<={height}][vcodec^=avc1]+ba[ext=m4a]/"
        f"bv[height<={height}]+ba/"
        f"b[height<={height}]/b"
    )


def format_chain(quality: str) -> list[str]:
    """格式选择器 + 逐级放宽的备选。

    YouTube 对部分账号/视频只给「有限格式」（例如只有 m3u8 或只有低清），
    主选择器可能一个都匹配不上，这时按顺序退让，至少把能下的下下来。
    """
    height = HEIGHT.get(str(quality or ""), 1080)
    return [
        format_selector(quality),
        f"bv*[height<={height}]+ba/b[height<={height}]/b",
        f"bv*+ba/b[height<={height}]/b",
        "b",
    ]


def ext_candidates(*, audio_only: bool = False, audio_format: str = "m4a") -> tuple[str, ...]:
    """可能落盘的扩展名（跳过已存在的判断要用）。"""
    if audio_only:
        return ("mp3", "m4a", "opus", "webm") if audio_format == "mp3" else ("m4a", "mp3", "opus", "webm")
    return ("mp4", "mkv", "webm")


def _download_sync(opts: dict[str, Any], url: str) -> None:
    with yt_dlp.YoutubeDL(opts) as ydl:  # type: ignore[union-attr]
        ydl.download([url])


def _extract_sync(opts: dict[str, Any], url: str) -> dict[str, Any]:
    from yt_dlp.utils import DownloadError as YtError  # 局部导入，避免依赖缺失时报错

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:  # type: ignore[union-attr]
            info = ydl.extract_info(url, download=False)
    except YtError as exc:
        raise ParseError(_clean_error(str(exc))) from exc
    if not isinstance(info, dict):
        raise ParseError("YouTube 没有返回可用信息（可能是私有/会员/地区限制视频）")
    return info


def _clean_error(text: str) -> str:
    text = str(text or "").strip()
    text = re.sub(r"^ERROR:\s*", "", text)
    text = re.sub(r"\s*;\s*please report this issue.*$", "", text, flags=re.S | re.I)
    low = text.lower()
    if "ffmpeg is not installed" in low or "ffmpeg not found" in low:
        return (
            "这台机器上找不到 ffmpeg，无法把视频轨和音频轨合并：Docker 镜像自带 ffmpeg；"
            "Windows 便携包把 ffmpeg.exe 放在 BiliDL-Pro.exe 同目录即可；也可以改用 720P 以内的单文件格式。"
        )
    if "requested format is not available" in low or "format is not available" in low:
        return (
            "YouTube 没有给出可下载的格式：常见原因是需要登录（请在「设置」里填 YouTube Cookie）、"
            "代理节点被风控，或缺少 yt-dlp 的 JS 运行时（Docker 镜像自带 nodejs，"
            "Windows 便携包需要在 exe 同目录放 deno.exe）。原始信息：" + text[:200]
        )
    if "Sign in to confirm" in text or "confirm you're not a bot" in text:
        return "YouTube 要求登录验证（反爬）：请在设置里填写 YouTube Cookie，或更换代理节点"
    if "Private video" in text:
        return "这是私有视频，无法下载"
    if "Video unavailable" in text:
        return "视频不可用（可能已删除或地区限制）"
    if "members-only" in text.lower():
        return "会员专属视频：需要填写有会员的 Cookie"
    return text[:400]


async def _probe_direct(timeout: float = 6.0) -> bool:
    """直连 youtube.com:443 探活（DNS 也计入超时）。"""
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("www.youtube.com", 443), timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


async def _thread(fn, *args, timeout: float = 90.0, what: str = "访问 YouTube"):
    """在线程里跑阻塞调用，并给一个整体超时。

    yt-dlp 自己的 socket_timeout 只管已建立的连接；国内直连 youtube.com 时
    TCP 握手会一直挂着，这里兜一层，避免 /api/parse 卡几分钟。
    """
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn, *args), timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise BiliError(f"{what}超时（{int(timeout)} 秒）：国内网络通常需要先在「设置 → 代理」里填 HTTP 代理") from exc


async def video_info(settings: Any, data_dir: Path | str, url: str) -> dict[str, Any]:
    """单个视频的元数据（不下载）。"""
    if not HAS_YTDLP:
        raise ParseError("服务端没有安装 yt-dlp，无法解析 YouTube 链接")
    if not _proxy(settings):
        if not await _probe_direct():
            raise BiliError(
                "连不上 YouTube（直连超时）：国内网络请在「设置 → 代理」里填 HTTP 代理，"
                "例如 http://192.168.1.2:7890；填好保存后重试"
            )
    # 带 Cookie 的登录态下，YouTube 有时一个可播放格式都不给（只给封面/故事板），
    # 这时元数据其实已经拿到了，不该因为「没有格式」就让整条解析失败。
    opts = _opts(settings, data_dir, noplaylist=True, skip_download=True, ignore_no_formats_error=True)
    info = await _thread(_extract_sync, opts, url, timeout=75.0, what="解析 YouTube 视频")
    return norm_video(info)


async def list_entries(
    settings: Any, data_dir: Path | str, url: str, limit: int = 60
) -> dict[str, Any]:
    """频道 / 播放列表的扁平列表（快，不逐个解析视频详情）。"""
    if not HAS_YTDLP:
        raise ParseError("服务端没有安装 yt-dlp，无法解析 YouTube 链接")
    opts = _opts(
        settings,
        data_dir,
        noplaylist=False,
        extract_flat="in_playlist",
        playlistend=max(1, int(limit)),
        skip_download=True,
    )
    if not _proxy(settings):
        if not await _probe_direct():
            raise BiliError(
                "连不上 YouTube（直连超时）：国内网络请在「设置 → 代理」里填 HTTP 代理，例如 http://192.168.1.2:7890"
            )
    info = await _thread(_extract_sync, opts, url, timeout=75.0, what="读取 YouTube 频道列表")
    return norm_list(info, limit=limit)


def _collect(tmp: Path) -> dict[str, Any]:
    """把临时目录里 yt-dlp 产出的文件分类：主媒体 / 字幕。"""
    media: Path | None = None
    subs: list[dict[str, str]] = []
    for path in sorted(tmp.glob("media.*")):
        suffix = path.suffix.lower()
        if suffix in (".vtt", ".srt", ".ass", ".json", ".part", ".ytdl", ".temp", ".jpg", ".webp", ".png"):
            if suffix in (".vtt", ".srt"):
                lang = path.name[len("media.") : -len(path.suffix)]
                subs.append({"lang": lang, "path": str(path), "ext": suffix.lstrip(".")})
            continue
        if not path.is_file():
            continue
        if media is None or path.stat().st_size > media.stat().st_size:
            media = path
    return {"media": str(media) if media else "", "subs": subs}


def diag(settings: Any, data_dir: Path | str) -> str:
    """一句话说明当前 YouTube 通道的关键状态，失败时拼进报错，方便判断原因。"""
    try:
        st = status()
    except Exception:
        st = {}
    parts = []
    try:
        parts.append("Cookie=" + ("有" if cookie_path(data_dir).exists() else "无"))
    except Exception:
        parts.append("Cookie=未知")
    js = "deno" if st.get("deno") else ("node" if st.get("node") else "无")
    parts.append("JS运行时=" + js)
    parts.append("ejs=" + ("有" if st.get("ejs") else "无"))
    try:
        parts.append("代理=" + ("已启用" if _proxy(settings) else "未启用"))
    except Exception:
        parts.append("代理=未知")
    return "；".join(parts)


def _dynamic_selector(settings: Any, data_dir: Path | str, url: str) -> str:
    """从视频实际可用的流里挑「最高画质视频轨 + 最好音频轨」的 format_id 组合。

    只在字符串选择器全部失效时兜底调用（多一次请求，但能救回 SABR / 只给 format_id 的视频）。
    """
    if not HAS_YTDLP:
        return ""
    try:
        opts = _opts(settings, data_dir, skip_download=True, quiet=True, ignore_no_formats_error=True)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False) or {}
    except Exception:
        return ""
    formats = [f for f in (info.get("formats") or []) if isinstance(f, dict)]
    videos = [f for f in formats if str(f.get("vcodec") or "none") != "none"]
    audios = [f for f in formats if str(f.get("acodec") or "none") != "none"]
    if not videos:
        return ""
    def vkey(item: dict[str, Any]) -> tuple[float, float]:
        return (float(item.get("height") or 0), float(item.get("tbr") or 0))
    best_v = max(videos, key=vkey)
    # 优先能直接合的（已经带音频），否则配一条音轨
    if str(best_v.get("acodec") or "none") != "none":
        return str(best_v.get("format_id") or "")
    if not audios:
        return str(best_v.get("format_id") or "")
    def akey(item: dict[str, Any]) -> tuple[float, float]:
        return (float(item.get("abr") or 0), float(item.get("tbr") or 0))
    best_a = max(audios, key=akey)
    vid_id = str(best_v.get("format_id") or "")
    aud_id = str(best_a.get("format_id") or "")
    if not vid_id:
        return ""
    return f"{vid_id}+{aud_id}" if aud_id else vid_id


async def download(
    settings: Any,
    data_dir: Path | str,
    url: str,
    *,
    fmt: str,
    tmp_dir: Path,
    progress: Callable[[int, int, float], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    subtitles: bool = False,
    fallbacks: list[str] | None = None,
) -> dict[str, Any]:
    """跑一次 yt-dlp 下载，返回临时目录里的产出（主媒体 + 字幕）。"""
    if not HAS_YTDLP:
        raise DownloadError("服务端没有安装 yt-dlp，无法下载 YouTube 视频")
    tmp = Path(tmp_dir)
    tmp.mkdir(parents=True, exist_ok=True)

    def hook(data: dict[str, Any]) -> None:
        if should_stop and should_stop():
            raise DownloadCancelled("已取消")
        if not progress or data.get("status") != "downloading":
            return
        total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
        done = int(data.get("downloaded_bytes") or 0)
        speed = float(data.get("speed") or 0)
        progress(done, total, speed)

    opts = _opts(
        settings,
        data_dir,
        format=fmt,
        outtmpl=str(tmp / "media.%(ext)s"),
        paths={"home": str(tmp), "temp": str(tmp)},
        noplaylist=True,
        progress_hooks=[hook],
        merge_output_format="mp4/mkv",
        # 合并需要的 ffmpeg 由 ffmpeg.py 找到后写进 PATH，yt-dlp 直接复用
        postprocessors=[],
    )
    if subtitles:
        opts.update(
            {
                "writesubtitles": True,
                "writeautomaticsub": True,
                "subtitleslangs": list(SUB_LANGS),
                "subtitlesformat": "vtt/srt/best",
            }
        )
    selectors = [fmt] + [x for x in (fallbacks or []) if x and x != fmt]
    last_exc: Exception | None = None
    for idx, selector in enumerate(selectors):
        opts["format"] = selector
        try:
            await asyncio.to_thread(_download_sync, opts, url)
            result = _collect(tmp)
            result["fallback"] = idx
            result["selector"] = selector
            return result
        except DownloadCancelled as exc:
            raise DownloadError("已取消") from exc
        except _YtError as exc:  # 包括合并失败、格式不可用等
            last_exc = exc
            text = str(exc)
            # 有些账号（尤其是带 Cookie 的登录态）在某些视频上拿不到 avc1+m4a 组合，
            # 这里逐级放宽：先要 H.264+AAC，再要任意视频+音频，最后要任意可下流。
            retryable = "Requested format is not available" in text or "format is not available" in text
            if retryable and idx + 1 < len(selectors):
                continue
            if retryable:
                # 选择器全部落空时，直接问 yt-dlp 这个视频到底给了哪些流，用真实 format_id 再试一次。
                # （YouTube 越来越多的流只认 format_id，字符串选择器匹配不上）
                dynamic = await asyncio.to_thread(_dynamic_selector, settings, data_dir, url)
                if dynamic and dynamic not in selectors:
                    selectors.append(dynamic)
                    opts["format"] = dynamic
                    try:
                        await asyncio.to_thread(_download_sync, opts, url)
                        result = _collect(tmp)
                        result["fallback"] = len(selectors) - 1
                        result["selector"] = dynamic
                        return result
                    except DownloadCancelled as exc2:
                        raise DownloadError("已取消") from exc2
                    except _YtError as exc2:
                        text = str(exc2)
            raise DownloadError(_clean_error(text) + "（当前状态：" + diag(settings, data_dir) + "）") from exc
    raise DownloadError(
        _clean_error(str(last_exc or "YouTube 下载失败")) + "（当前状态：" + diag(settings, data_dir) + "）"
    )


def vtt_to_srt(text: str) -> str:
    """VTT → SRT（不依赖 ffmpeg；YouTube 只给 webvtt，媒体库多数要 srt）。"""
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    index = 0
    buffer: list[str] = []
    block: list[str] = []

    def flush() -> None:
        nonlocal index
        if not block:
            return
        body = []
        timing = ""
        for line in block:
            if "-->" in line:
                timing = line
            elif line and not line.isdigit():
                body.append(line)
        if timing and body:
            timing = re.sub(r"\s+(align|position|line|size|region):\S+", "", timing)
            timing = timing.replace(".", ",")
            index += 1
            out.append(str(index))
            out.append(timing.strip())
            out.extend(body)
            out.append("")
        block.clear()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if stripped.upper().startswith("WEBVTT") or stripped.startswith("NOTE") or stripped.startswith("Kind:") or stripped.startswith("Language:"):
            continue
        block.append(stripped)
    flush()
    result = "\n".join(out).strip()
    return (result + "\n") if result else ""


def build_nfo(info: dict[str, Any], *, channel_url: str = "") -> str:
    """Kodi/Plex 能识别的 movie.nfo（YouTube 版）。"""
    vid = str(info.get("id") or "")
    title = str(info.get("title") or "")
    desc = str(info.get("description") or "")
    uploader = str(info.get("uploader") or info.get("channel") or "")
    channel_id = str(info.get("channel_id") or "")
    thumb = _thumb(info) or thumb_for(vid)
    stamp = int(info.get("timestamp") or 0)
    date = ""
    if stamp:
        from datetime import datetime

        date = datetime.fromtimestamp(stamp).strftime("%Y-%m-%d")
    elif info.get("upload_date"):
        raw = str(info["upload_date"])
        if len(raw) == 8:
            date = f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"

    def esc(value: Any) -> str:
        return (
            str(value or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )

    dur = int(info.get("duration") or 0)
    seconds = f"{dur // 60}" if dur else ""
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        "<movie>\n"
        f"  <title>{esc(title)}</title>\n"
        f'  <uniqueid type="youtube" default="true">{esc(vid)}</uniqueid>\n'
        f"  <plot>{esc(desc)}</plot>\n"
        f"  <premiered>{esc(date)}</premiered>\n"
        f"  <studio>{esc(uploader)}</studio>\n"
        f"  <director>{esc(uploader)}</director>\n"
        f"  <thumb>{esc(thumb)}</thumb>\n"
        f"  <runtime>{seconds}</runtime>\n"
        f"  <website>{esc(info.get('webpage_url') or _VIDEO_URL.format(vid=vid))}</website>\n"
        f'  <tag>YouTube</tag>\n'
        f"  <id>{esc(channel_id or channel_url)}</id>\n"
        "</movie>\n"
    )


def quality_label(quality: str) -> str:
    """清晰度标签兜底（名字不在白名单时按 1080P60 显示）。"""
    if quality in QUALITY_CHOICES:
        return quality
    return "1080P60"
