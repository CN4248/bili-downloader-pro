"""抖音 / 小红书：链接识别、作品解析与下载地址提取。

这两个站点的页面都靠登录态 + 签名参数，直接抓 HTML 拿不到数据：

* 抖音：先向 ttwid 注册拿 cookie，再请求 ``iesdouyin.com/share/<type>/<id>/``
  的 SSR 页面，页面里的 ``window._ROUTER_DATA`` 带作品完整信息；slides（图文）
  类型改走 slidesinfo 接口。视频直链用 ``play/?video_id=<uri>`` 去掉水印。
* 小红书：HTML 里的 ``window.__INITIAL_STATE__`` 才有笔记详情，但**必须**带
  分享链接里的 ``xsec_token``，否则 noteDetailMap 是空的；另外服务端 TLS
  指纹要求 HTTP/2，http1.1 会被降级成空页面。

签名地址会过期，所以任务里只存作品 ID（以及小红书的 token/分享链接），
真正下载前再解析一次。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from .constants import DEFAULT_API_INTERVAL
from .errors import NotFound, ParseError

SOURCE_LABELS = {"douyin": "抖音", "xhs": "小红书"}
SOCIAL_SOURCES = tuple(SOURCE_LABELS)

DOUYIN_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
XHS_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

# 抖音播放清晰度：设置里的 B站清晰度名 → play 接口的 ratio
DOUYIN_RATIOS: dict[str, str] = {
    "8K": "1080p",
    "杜比视界": "1080p",
    "HDR": "1080p",
    "4K": "1080p",
    "1080P60": "1080p",
    "1080P+": "1080p",
    "1080P": "1080p",
    "720P60": "720p",
    "720P": "720p",
    "480P": "540p",
    "360P": "360p",
}
def user_agent(source: str) -> str:
    return DOUYIN_UA if source == "douyin" else XHS_UA


RATIO_LABELS = {"1080p": "1080P", "720p": "720P", "540p": "480P", "360p": "360P"}

_DOUYIN_HOSTS = (
    "douyin.com",
    "iesdouyin.com",
    "douyinpic.com",
    "douyinvod.com",
)
_DOUYIN_SHORT_HOSTS = ("v.douyin.com", "jx.douyin.com")
_XHS_HOSTS = ("xiaohongshu.com", "xiaohongshu.cn", "rednote.com", "rednote.cn")
_XHS_SHORT_HOSTS = ("xhslink.com", "xhslink.cn")

_DOUYIN_ID_RE = re.compile(r"/(?:share/)?(video|note|slides)/(\d{8,})")
_DOUYIN_QUERY_KEYS = ("modal_id", "aweme_id", "vid", "item_ids")
_XHS_NOTE_RE = re.compile(r"/(?:explore|discovery/item|user/profile/[^/]+)/([0-9a-fA-F]{20,32})")


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _host_in(host: str, suffixes: tuple[str, ...]) -> bool:
    return any(host == s or host.endswith("." + s) for s in suffixes)


def is_douyin_url(url: str) -> bool:
    host = host_of(url)
    return _host_in(host, _DOUYIN_HOSTS) or _host_in(host, _DOUYIN_SHORT_HOSTS)


def is_xhs_url(url: str) -> bool:
    host = host_of(url)
    return _host_in(host, _XHS_HOSTS) or _host_in(host, _XHS_SHORT_HOSTS)


def is_douyin_short(url: str) -> bool:
    return _host_in(host_of(url), _DOUYIN_SHORT_HOSTS)


def is_xhs_short(url: str) -> bool:
    return _host_in(host_of(url), _XHS_SHORT_HOSTS)


def douyin_url_info(url: str) -> tuple[str, str] | None:
    """从抖音链接里取 (类型, 作品 ID)。类型是 video / note / slides，未知时为 ""。"""
    parts = urlsplit(url)
    match = _DOUYIN_ID_RE.search(parts.path)
    if match:
        return match.group(1), match.group(2)
    query = parts.query
    for key in _DOUYIN_QUERY_KEYS:
        found = re.search(rf"(?:^|&){key}=(\d{{8,}})", query)
        if found:
            return "", found.group(1)
    return None


def xhs_url_info(url: str) -> tuple[str, str] | None:
    """从小红书链接里取 (笔记 ID, xsec_token)。token 可能为空。"""
    parts = urlsplit(url)
    match = _XHS_NOTE_RE.search(parts.path)
    if not match:
        # 有些分享链接把 id 放在 query 里
        found = re.search(r"(?:^|&)(?:note_id|noteId)=([0-9a-fA-F]{20,32})", parts.query)
        if not found:
            return None
        note_id = found.group(1)
    else:
        note_id = match.group(1)
    token = ""
    found = re.search(r"(?:^|&)xsec_token=([^&]+)", parts.query)
    if found:
        token = found.group(1)
    return note_id, token


def ratio_for_quality(quality: str) -> str:
    return DOUYIN_RATIOS.get(str(quality or "").strip(), "1080p")


def quality_label_for_ratio(ratio: str) -> str:
    return RATIO_LABELS.get(ratio, "1080P")


def _strip_image_transform(url: str) -> str:
    """去掉小红书图片 URL 的 ``!`` 处理参数（拿到原图而不是缩略图）。"""
    cut = url.find("!")
    return url[:cut] if cut > 0 else url


def _initial_state(html: str) -> dict[str, Any]:
    marker = html.find("window.__INITIAL_STATE__")
    if marker < 0:
        raise ParseError("小红书页面结构变化，未找到 __INITIAL_STATE__")
    start = html.find("{", marker)
    end = html.find("</script>", start)
    if start < 0 or end < 0:
        raise ParseError("小红书页面结构变化，无法提取笔记数据")
    raw = html[start:end].strip().rstrip(";")
    # 页面里的 state 是 JS 字面量，含 undefined；直接换成 null 再解析
    raw = raw.replace("undefined", "null")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ParseError(f"小红书数据解析失败：{exc}") from exc


def _router_data(html: str) -> dict[str, Any]:
    marker = html.find("window._ROUTER_DATA")
    if marker < 0:
        return {}
    start = html.find("{", marker)
    end = html.find("</script>", start)
    if start < 0 or end < 0:
        return {}
    raw = html[start:end].strip().rstrip(";")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _router_item(data: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    candidates: list[Any] = []
    loader = data.get("loaderData")
    if isinstance(loader, dict):
        candidates.extend(loader.values())
    candidates.append(data)
    for node in candidates:
        if not isinstance(node, dict):
            continue
        result = node.get("videoInfoRes")
        if isinstance(result, dict):
            items = result.get("item_list") or []
            if items and isinstance(items[0], dict):
                return items[0]
    return None


def _douyin_image_url(image: dict[str, Any]) -> str:
    for key in ("url_list", "download_url_list"):
        for url in image.get(key) or []:
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            # "-water:" 是带水印的备份地址，优先用干净的
            if "-water:" in url:
                continue
            return url
    for key in ("url_list", "download_url_list"):
        for url in image.get(key) or []:
            if isinstance(url, str) and url.startswith("http"):
                return url
    return ""


def _douyin_video_url(video: dict[str, Any], ratio: str) -> tuple[str, str]:
    play = video.get("play_addr") or {}
    uri = str(play.get("uri") or "").strip()
    if uri and not uri.startswith("http") and ".mp3" not in uri:
        # play 接口不带水印；playwm 是带水印的
        return (
            f"https://aweme.snssdk.com/aweme/v1/play/?video_id={uri}&ratio={ratio}&line=0",
            quality_label_for_ratio(ratio),
        )
    urls = [u for u in (play.get("url_list") or []) if isinstance(u, str)]
    for url in urls:
        if url.startswith("http"):
            return url.replace("playwm", "play"), quality_label_for_ratio(ratio)
    return "", ""


def _douyin_detail(item: dict[str, Any], ratio: str, share_url: str = "") -> dict[str, Any]:
    ident = str(item.get("aweme_id") or "")
    author = item.get("author") or {}
    desc = str(item.get("desc") or "").strip()
    title = desc or "无标题"
    images = [im for im in (item.get("images") or []) if isinstance(im, dict)]
    image_urls = []
    for image in images:
        url = _douyin_image_url(image)
        if url and url not in image_urls:
            image_urls.append(url)
    video = item.get("video") or {}
    # 图集的 video 字段可能只是「实况照片的音频/占位」，别当成作品视频
    video_url, quality = ("", "") if image_urls else _douyin_video_url(video, ratio)
    cover = ""
    for key in ("cover", "origin_cover", "dynamic_cover"):
        node = video.get(key) or {}
        for url in node.get("url_list") or []:
            if isinstance(url, str) and url.startswith("http"):
                cover = url
                break
        if cover:
            break
    if not cover and image_urls:
        cover = image_urls[0]
    duration = int(video.get("duration") or 0) // 1000
    if not image_urls and not video_url:
        raise NotFound("抖音作品里没有找到可下载的视频或图片")
    return {
        "source": "douyin",
        "ident": ident,
        "kind": "opus" if image_urls else "video",
        "title": title,
        "desc": desc,
        "author": str(author.get("nickname") or "未知作者"),
        "author_uid": str(author.get("uid") or author.get("sec_uid") or ""),
        "pubdate": int(item.get("create_time") or 0),
        "cover": cover,
        "duration": duration,
        "url": share_url or f"https://www.douyin.com/video/{ident}",
        "images": [{"url": url} for url in image_urls],
        "video_url": video_url,
        "quality_label": quality,
    }


def _xhs_image_url(image: dict[str, Any]) -> str:
    file_id = str(image.get("fileId") or image.get("traceId") or "").strip()
    if file_id:
        if file_id.startswith("http"):
            return _strip_image_transform(file_id)
        return f"https://sns-img-qc.xhscdn.com/{quote(file_id, safe='/')}"
    for key in ("urlDefault", "url", "urlPre"):
        url = image.get(key)
        if isinstance(url, str) and url.startswith("http"):
            return _strip_image_transform(url)
    return ""


def _xhs_stream_url(video: dict[str, Any]) -> tuple[str, str]:
    media = (video.get("media") or {})
    stream = media.get("stream") or {}
    for codec in ("h264", "h265", "av1", "h266"):
        variants = stream.get(codec) or []
        if not isinstance(variants, list):
            continue
        for variant in variants:
            url = variant.get("masterUrl") or variant.get("url") or ""
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            height = int(variant.get("height") or 0)
            if height >= 2160:
                label = "4K"
            elif height >= 1440:
                label = "2K"
            elif height >= 1080:
                label = "1080P"
            elif height >= 720:
                label = "720P"
            else:
                label = "540P"
            if url.startswith("http://"):
                url = "https://" + url[len("http://") :]
            return url, label
    return "", ""


def _xhs_detail(note: dict[str, Any], ident: str, share_url: str = "") -> dict[str, Any]:
    user = note.get("user") or {}
    desc = str(note.get("desc") or "").strip()
    title = str(note.get("title") or "").strip() or desc.splitlines()[0][:80] or "无标题"
    images = [im for im in (note.get("imageList") or []) if isinstance(im, dict)]
    image_urls = []
    for image in images:
        url = _xhs_image_url(image)
        if url and url not in image_urls:
            image_urls.append(url)
    note_type = str(note.get("type") or "").lower()
    video_url, quality = "", ""
    if note_type == "video":
        video_url, quality = _xhs_stream_url(note.get("video") or {})
    kind = "video" if note_type == "video" else "opus"
    if kind == "video" and not video_url:
        raise NotFound("小红书视频没有找到可下载的播放地址")
    if kind == "opus" and not image_urls:
        raise NotFound("小红书笔记里没有找到可下载的图片")
    created = int(note.get("time") or 0)
    if created > 10_000_000_000:  # 毫秒
        created //= 1000
    return {
        "source": "xhs",
        "ident": str(note.get("noteId") or ident),
        "kind": kind,
        "title": title,
        "desc": desc,
        "author": str(user.get("nickname") or user.get("nickName") or "未知作者"),
        "author_uid": str(user.get("userId") or user.get("user_id") or ""),
        "pubdate": created,
        "cover": image_urls[0] if image_urls else "",
        "duration": 0,
        "url": share_url or f"https://www.xiaohongshu.com/explore/{ident}",
        "images": [{"url": url} for url in image_urls] if kind == "opus" else [],
        "video_url": video_url,
        "quality_label": quality,
    }


class SocialClient:
    """抖音 / 小红书共用的轻量客户端（各自独立连接池与 Cookie）。"""

    def __init__(self, proxy: str = "") -> None:
        self.proxy = proxy or ""
        self.api_interval = DEFAULT_API_INTERVAL
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._last: dict[str, float] = {}
        self._ttwid_ready = False
        self._ttwid_lock = asyncio.Lock()

    # ------------------------------------------------------------------ 基础
    def configure(self, proxy: str = "", api_interval: float | None = None) -> None:
        self.proxy = proxy or ""
        if api_interval:
            self.api_interval = max(float(api_interval), 0.4)

    def _headers(self, site: str) -> dict[str, str]:
        if site == "douyin":
            return {
                "User-Agent": DOUYIN_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9",
            }
        return {
            "User-Agent": XHS_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": "https://www.xiaohongshu.com/",
        }

    async def client_for(self, site: str) -> httpx.AsyncClient:
        """给下载器复用同一连接池（带上站点的 Cookie / UA）。"""
        return await self._client(site)

    async def _client(self, site: str) -> httpx.AsyncClient:
        client = self._clients.get(site)
        if client is not None and not client.is_closed:
            return client
        kwargs: dict[str, Any] = {
            "http2": True,  # 小红书对 http1.1 直接返回空数据
            "headers": self._headers(site),
            "timeout": httpx.Timeout(30.0, connect=15.0),
            "follow_redirects": True,
        }
        if self.proxy:
            kwargs["proxy"] = self.proxy
        client = httpx.AsyncClient(**kwargs)
        self._clients[site] = client
        return client

    async def aclose(self) -> None:
        for client in self._clients.values():
            try:
                await client.aclose()
            except Exception:  # pragma: no cover - 关闭失败不影响退出
                pass
        self._clients.clear()

    async def _throttle(self, site: str) -> None:
        lock = self._locks.setdefault(site, asyncio.Lock())
        async with lock:
            last = self._last.get(site, 0.0)
            wait = self.api_interval - (time.monotonic() - last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last[site] = time.monotonic()

    async def get(self, site: str, url: str, method: str = "GET", **kwargs: Any) -> httpx.Response:
        """带节流与重试的请求（iesdouyin 偶发 DNS 失败，重试几次就好）。"""
        client = await self._client(site)
        last_error: Exception | None = None
        for attempt in range(3):
            await self._throttle(site)
            try:
                response = await client.request(method, url, **kwargs)
                if response.status_code >= 500:
                    last_error = ParseError(f"{SOURCE_LABELS.get(site, site)} 服务暂时不可用（HTTP {response.status_code}）")
                else:
                    return response
            except httpx.HTTPError as exc:
                last_error = exc
            if attempt < 2:
                await asyncio.sleep(0.8 * (attempt + 1))
        raise ParseError(f"访问{SOURCE_LABELS.get(site, site)}失败：{last_error}")

    # -------------------------------------------------------------- 短链展开
    async def resolve_short(self, site: str, url: str) -> str:
        response = await self.get(site, url)
        final = str(response.url)
        if site == "douyin" and douyin_url_info(final):
            return final
        if site == "xhs" and _XHS_NOTE_RE.search(urlsplit(final).path):
            return final
        # 少数情况服务端不 302，只能从 HTML 里找分享地址
        if site == "douyin":
            found = re.search(r"https?://www\.iesdouyin\.com/share/[a-z]+/\d+", response.text)
            if found:
                return found.group(0)
        raise ParseError(f"{SOURCE_LABELS.get(site, site)}短链解析失败：{url}")

    # ------------------------------------------------------------------ 抖音
    async def _ensure_ttwid(self) -> None:
        if self._ttwid_ready:
            return
        async with self._ttwid_lock:
            if self._ttwid_ready:
                return
            try:
                response = await self.get(
                    "douyin",
                    "https://ttwid.bytedance.com/ttwid/union/register/",
                    method="POST",
                    json={
                        "region": "cn",
                        "aid": 1768,
                        "needFid": False,
                        "service": "www.iesdouyin.com",
                        "union": True,
                        "fid": "",
                    },
                )
                if response.status_code == 200:
                    # 注册只会在 .bytedance.com 上写 ttwid，必须再访问它返回的回调地址，
                    # 才会给 .iesdouyin.com 也种下同一枚 ttwid（少了这步分享页只有空壳）。
                    payload: dict[str, Any] = {}
                    try:
                        payload = response.json() or {}
                    except ValueError:
                        payload = {}
                    callback = str(payload.get("redirect_url") or "")
                    if callback.startswith("https://"):
                        await self.get(
                            "douyin",
                            callback,
                            headers={"Referer": "https://www.iesdouyin.com/"},
                        )
                    self._ttwid_ready = True
            except ParseError:
                # 注册失败也继续试：分享页对部分网络不校验 ttwid
                pass

    async def _slidesinfo(self, ident: str) -> dict[str, Any] | None:
        url = (
            "https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/"
            f"?aweme_ids=%5B{ident}%5D&request_source=200"
        )
        try:
            response = await self.get("douyin", url, headers={"Referer": "https://www.iesdouyin.com/"})
            data = response.json()
        except (ParseError, ValueError):
            return None
        if not isinstance(data, dict) or data.get("status_code") not in (0, None):
            return None
        details = data.get("aweme_details") or []
        return details[0] if details and isinstance(details[0], dict) else None

    async def douyin_detail(self, ident: str, share_url: str = "", quality: str = "1080P60") -> dict[str, Any]:
        ident = str(ident or "").strip()
        if not ident.isdigit():
            raise ParseError("不是有效的抖音作品 ID")
        await self._ensure_ttwid()
        ratio = ratio_for_quality(quality)
        candidates: list[str] = []
        if share_url:
            candidates.append(share_url)
        candidates.append(f"https://www.iesdouyin.com/share/note/{ident}/")
        candidates.append(f"https://www.iesdouyin.com/share/video/{ident}/")
        seen: set[str] = set()
        item: dict[str, Any] | None = None
        for url in candidates:
            if url in seen:
                continue
            seen.add(url)
            try:
                response = await self.get("douyin", url, headers={"Referer": url})
            except ParseError:
                continue
            item = _router_item(_router_data(response.text))
            if item:
                break
        if item is None:
            item = await self._slidesinfo(ident)
        if item is None:
            raise NotFound("抖音作品不存在、已删除，或需要登录后查看")
        share = share_url or f"https://www.iesdouyin.com/share/video/{ident}/"
        return _douyin_detail(item, ratio, share)

    # ---------------------------------------------------------------- 小红书
    async def xhs_detail(self, ident: str, xsec_token: str = "", share_url: str = "") -> dict[str, Any]:
        ident = str(ident or "").strip()
        if not ident:
            raise ParseError("不是有效的小红书笔记 ID")
        url = share_url or f"https://www.xiaohongshu.com/explore/{ident}"
        if xsec_token and "xsec_token=" not in url:
            joiner = "&" if "?" in url else "?"
            url = f"{url}{joiner}xsec_token={quote(xsec_token, safe='')}&xsec_source=pc_share"
        response = await self.get("xhs", url)
        state = _initial_state(response.text)
        detail_map = ((state.get("note") or {}).get("noteDetailMap") or {})
        entry = detail_map.get(ident)
        if not isinstance(entry, dict):
            # 笔记 id 与 URL 里的可能大小写/前后缀不同，退回取第一条
            entries = [v for v in detail_map.values() if isinstance(v, dict)]
            entry = entries[0] if entries else None
        note = None
        if isinstance(entry, dict):
            note = entry.get("note") if isinstance(entry.get("note"), dict) else entry
            if note is not None and not note.get("noteId") and not note.get("imageList"):
                note = None
        if not note:
            if not xsec_token:
                raise ParseError(
                    "小红书笔记需要分享链接里的 xsec_token：请在笔记页用「分享 → 复制链接」，"
                    "或直接点油猴面板的推送按钮"
                )
            raise NotFound("小红书笔记不存在、已删除或仅登录可见")
        return _xhs_detail(note, ident, share_url or url)
