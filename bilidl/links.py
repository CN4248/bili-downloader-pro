"""链接识别。

支持：BV/av 视频、opus 图文、t.bilibili.com 动态、read/cv 专栏、
space.bilibili.com 空间（视频/图文批量）、b23.tv 与 bili2233.cn 短链，
以及 YouTube 视频 / 频道 / 播放列表（youtu.be 短链直接识别，不发请求）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse, parse_qs

from .errors import ParseError

URL_RE = re.compile(r"(?:https?://)?(?:[\w-]+\.)+[a-z]{2,}(?:/[^\s\u4e00-\u9fff\"'<>）)]*)?", re.I)
BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
AV_RE = re.compile(r"av(\d{1,12})", re.I)
SHORT_HOSTS = ("b23.tv", "bili2233.cn", "bili22.cn", "bili23.cn", "bili33.cn")
# YouTube：视频 / 频道 / 播放列表
YT_HOSTS = (
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "www.youtube-nocookie.com",
    "youtube-nocookie.com",
    "youtu.be",
    "www.youtu.be",
)
YT_VID_RE = re.compile(r"^[0-9A-Za-z_-]{11}$")
YT_LIST_RE = re.compile(r"^[0-9A-Za-z_-]{10,}$")
YT_PATH_VID = re.compile(r"/(?:shorts|live|embed|v|watch)/([0-9A-Za-z_-]{11})")


def is_youtube(host: str) -> bool:
    host = (host or "").lower()
    return host in YT_HOSTS or host.endswith(".youtube.com") or host.endswith(".youtu.be")


def youtube_ref(
    host: str, path: str, query: dict[str, list[str]], url: str
) -> LinkRef | None:
    """把 YouTube 链接拆成 yt_video / yt_channel / yt_playlist。"""
    path = path or "/"
    host = (host or "").lower()
    if host.endswith("youtu.be"):
        vid = path.strip("/").split("/")[0]
        if YT_VID_RE.match(vid):
            return LinkRef(raw=url, kind="yt_video", ident=vid, note="YouTube 视频")
        return LinkRef(raw=url, kind="unknown", note="无法识别的 youtu.be 链接")

    vid = (query.get("v") or [""])[0].strip()
    if YT_VID_RE.match(vid):
        return LinkRef(raw=url, kind="yt_video", ident=vid, note="YouTube 视频")
    m = YT_PATH_VID.search(path)
    if m:
        return LinkRef(raw=url, kind="yt_video", ident=m.group(1), note="YouTube 视频")

    playlist = (query.get("list") or [""])[0].strip()
    if playlist and YT_LIST_RE.match(playlist):
        return LinkRef(raw=url, kind="yt_playlist", ident=playlist, note="YouTube 播放列表")
    if "/playlist" in path:
        return LinkRef(raw=url, kind="unknown", note="播放列表链接里没有 list 参数，请复制完整链接")

    m = re.match(r"^/@([^/?#]+)", path)
    if m:
        return LinkRef(raw=url, kind="yt_channel", ident="@" + m.group(1), note="YouTube 频道")
    m = re.match(r"^/(channel|c|user)/([^/?#]+)", path)
    if m:
        ident = m.group(2) if m.group(1) == "channel" else f"{m.group(1)}/{m.group(2)}"
        return LinkRef(raw=url, kind="yt_channel", ident=ident, note="YouTube 频道")
    # 首页/结果页之类没有具体目标
    return LinkRef(
        raw=url,
        kind="unknown",
        note="这是 YouTube 首页/搜索结果，请复制具体视频、频道（/@名字）或播放列表链接",
    )


def youtube_channel_url(ident: str) -> str:
    ident = str(ident or "").strip()
    if ident.startswith("@"):
        return f"https://www.youtube.com/{ident}"
    if ident.startswith("UC") and len(ident) >= 20:
        return f"https://www.youtube.com/channel/{ident}"
    if ident.startswith(("c/", "user/")):
        return f"https://www.youtube.com/{ident}"
    return f"https://www.youtube.com/{ident}"


@dataclass
class LinkRef:
    """一条待解析的链接。"""

    raw: str
    kind: str = "unknown"  # video/opus/dynamic/article/space/bangumi/live/unknown
    ident: str = ""
    page: int | None = None
    mid: str = ""
    space_tab: str = ""  # video / opus / dynamic
    note: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def url(self) -> str:
        if self.kind == "video":
            return f"https://www.bilibili.com/video/{self.ident}"
        if self.kind == "opus":
            return f"https://www.bilibili.com/opus/{self.ident}"
        if self.kind == "dynamic":
            return f"https://t.bilibili.com/{self.ident}"
        if self.kind == "article":
            return f"https://www.bilibili.com/read/cv{self.ident}"
        if self.kind == "space":
            return f"https://space.bilibili.com/{self.mid}"
        if self.kind == "yt_video":
            return f"https://www.youtube.com/watch?v={self.ident}"
        if self.kind == "yt_channel":
            return youtube_channel_url(self.ident)
        if self.kind == "yt_playlist":
            return f"https://www.youtube.com/playlist?list={self.ident}"
        return self.raw


def extract_urls(text: str) -> list[str]:
    """从任意文本中提取所有链接（支持一次粘贴多条）。"""
    found: list[str] = []
    for match in URL_RE.finditer(text or ""):
        url = match.group(0)
        if not url.lower().startswith("http"):
            url = "https://" + url
        if url not in found:
            found.append(url)
    # 纯 BV 号 / av 号也允许直接粘贴
    if not found:
        for m in BV_RE.finditer(text or ""):
            found.append(f"https://www.bilibili.com/video/{m.group(1)}")
    return found


def classify(url: str) -> LinkRef:
    """把单条 URL 解析成 :class:`LinkRef`（不发起网络请求）。"""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    path = parsed.path or ""
    query = parse_qs(parsed.query)
    page = None
    if "p" in query:
        try:
            page = max(1, int(query["p"][0]))
        except (TypeError, ValueError):
            page = None

    if host in SHORT_HOSTS or host.endswith(".b23.tv"):
        return LinkRef(raw=url, kind="short", ident=url, note="短链")

    if is_youtube(host):
        ref = youtube_ref(host, path, query, url)
        if ref is not None:
            return ref

    bv = BV_RE.search(path) or BV_RE.search(parsed.query)
    if bv:
        return LinkRef(raw=url, kind="video", ident=bv.group(1), page=page)
    if "/video/" in path:
        av = AV_RE.search(path)
        if av:
            return LinkRef(raw=url, kind="video", ident="av" + av.group(1), page=page)

    m = re.search(r"/opus/(\d{6,})", path)
    if m:
        return LinkRef(raw=url, kind="opus", ident=m.group(1))
    m = re.search(r"/read/readlist/(rl\d+)", path, re.I)
    if m:
        return LinkRef(raw=url, kind="readlist", ident=m.group(1))
    m = re.search(r"/lists/(\d{3,})", path)
    if m:
        mid = re.search(r"space\.bilibili\.com/(\d+)", url)
        return LinkRef(raw=url, kind="videolist", ident=m.group(1), note=(mid.group(1) if mid else ""))
    m = re.search(r"/read/cv(\d{1,12})", path, re.I)
    if m:
        return LinkRef(raw=url, kind="article", ident=m.group(1))

    if host.startswith("t.") or host.startswith("m."):
        m = re.search(r"/(\d{15,})", path)
        if m and "dynamic" not in path:
            return LinkRef(raw=url, kind="dynamic", ident=m.group(1))
        if "video" in path:
            bv = BV_RE.search(path)
            if bv:
                return LinkRef(raw=url, kind="video", ident=bv.group(1), page=page)

    if "space.bilibili.com" in host:
        m = re.search(r"/(\d{1,12})", path)
        if m:
            tab = "dynamic"
            if "/upload/opus" in path or "/article" in path:
                tab = "opus"
            elif "/upload/video" in path or "/video" in path:
                tab = "video"
            return LinkRef(raw=url, kind="space", mid=m.group(1), space_tab=tab)

    if "/bangumi/" in path or "/cheese/" in path:
        return LinkRef(raw=url, kind="bangumi", ident=path, note="番剧/课程暂不支持")
    if "live.bilibili.com" in host:
        return LinkRef(raw=url, kind="live", ident=path, note="直播暂不支持")
    if "/medialist/" in path or "/list/" in path:
        return LinkRef(raw=url, kind="medialist", ident=path, note="合集列表链接暂不支持，请粘贴具体视频链接")
    return LinkRef(
        raw=url,
        kind="unknown",
        note=(
            "无法识别的链接（支持：B站视频/番剧、图文 opus、专栏 cv、文集 readlist、"
            "视频合集 lists、UP 空间；YouTube 视频/频道/@名字/播放列表）"
        ),
    )


async def resolve_short(url: str, client) -> str:
    """展开 b23.tv / bili2233.cn 短链。"""
    try:
        resp = await client.get(url, follow_redirects=True, timeout=15.0)
    except Exception as exc:  # noqa: BLE001
        raise ParseError(f"短链展开失败：{exc}") from exc
    final = str(resp.url)
    if final.rstrip("/") == url.rstrip("/"):
        text = resp.text or ""
        m = re.search(r'https?://(?:www\.)?bilibili\.com/[^\s"\'<>]+', text)
        if m:
            return m.group(0)
        raise ParseError("短链未跳转到B站页面，可能已失效")
    return final


async def parse_links(text: str, client) -> list[LinkRef]:
    """解析一段文本中的所有链接，短链会被展开。"""
    urls = extract_urls(text)
    if not urls:
        raise ParseError("没有识别到链接，请粘贴 B站 或 YouTube 的视频/频道链接")
    refs: list[LinkRef] = []
    for url in urls:
        ref = classify(url)
        if ref.kind == "short":
            try:
                final = await resolve_short(url, client)
                ref = classify(final)
                ref.raw = url
            except ParseError as exc:
                ref = LinkRef(raw=url, kind="unknown", note=str(exc))
        refs.append(ref)
    return refs
