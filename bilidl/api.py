"""B站接口封装：视频、图文、专栏、UP 主作品列表。"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

from .constants import (
    CODEC_PRIORITY,
    DESKTOP_UA,
    FNVAL_DASH,
    FNVAL_PROGRESSIVE,
    QUALITY_CHOICES,
    QUALITY_LABELS,
    UNSUPPORTED_VIDEO_IDS,
    VIDEO_HOST_SUFFIXES,
)
from .errors import BiliError, NotFound, ParseError, RiskControl
from .http import API, PASSPORT, BiliSession
from .models import AuthorWork, OpusInfo, Page, SeasonEpisode, VideoInfo

SITE = "https://www.bilibili.com"
IMG_TRANSFORM = re.compile(r"@(?:\d+w(?:_[^/]*)?|!web-[^/]+)(?:\.[^/]*)?$")


def https(url: str) -> str:
    if not url:
        return ""
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("http://"):
        return "https://" + url[len("http://"):]
    return url


def original_image_url(url: str) -> str:
    """去掉 B站图片 CDN 的缩放后缀，获取原图。"""
    url = https(url)
    if not url:
        return ""
    try:
        parts = urlsplit(url)
        _ = parts.port
    except ValueError:
        return url
    host = parts.hostname or ""
    if host == "hdslb.com" or host.endswith(".hdslb.com"):
        path = IMG_TRANSFORM.sub("", parts.path, count=1)
        return urlunsplit(parts._replace(path=path))
    return url


def _https(url: str) -> str:
    """B站 有些封面/首帧给的是 http://，页面是 https，必须升级否则被拦。"""
    u = str(url or "").strip()
    return "https://" + u[7:] if u.startswith("http://") else u


def _ts(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


async def video_info(session: BiliSession, ident: str) -> VideoInfo:
    """获取视频元数据、分P与合集信息。"""
    ident = ident.strip()
    if ident.lower().startswith("av"):
        params = {"aid": ident[2:]}
    elif ident.upper().startswith("BV"):
        params = {"bvid": ident}
    else:
        raise BiliError(f"无法识别的视频 ID：{ident}")
    payload = await session.get(
        f"{API}/x/web-interface/view",
        params,
        referer=f"{SITE}/video/{ident}",
    )
    data = payload.get("data") or {}
    if not data.get("bvid"):
        raise NotFound("视频不存在或已被删除")

    raw_pages = data.get("pages") or []
    multi = len(raw_pages) > 1
    pages = [
        Page(
            index=int(item.get("page") or idx + 1),
            cid=_ts(item.get("cid")),
            title=str(item.get("part") or data.get("title") or ""),
            duration=_ts(item.get("duration")),
            # 单分集视频不给分集缩略图（首帧常是黑帧，卡片本身已有封面）
            cover=_https(str(item.get("first_frame") or "")) if multi else "",
            bvid=str(data.get("bvid")),
        )
        for idx, item in enumerate(raw_pages)
    ]
    if not pages:
        pages = [Page(index=1, cid=_ts(data.get("cid")), title=str(data.get("title") or ""), bvid=str(data.get("bvid")))]

    info = VideoInfo(
        bvid=str(data.get("bvid") or ident),
        aid=_ts(data.get("aid")),
        title=str(data.get("title") or "无标题"),
        author=str((data.get("owner") or {}).get("name") or ""),
        mid=str((data.get("owner") or {}).get("mid") or ""),
        cover=https(str(data.get("pic") or "")),
        desc=str(data.get("desc") or ""),
        pubdate=_ts(data.get("pubdate")),
        duration=_ts(data.get("duration")),
        pages=pages,
    )

    season = data.get("ugc_season") or {}
    if season.get("id"):
        episodes: list[SeasonEpisode] = []
        order = 0
        for section in season.get("sections") or []:
            for ep in section.get("episodes") or []:
                order += 1
                arc = ep.get("arc") or {}
                page = ep.get("page") or {}
                episodes.append(
                    SeasonEpisode(
                        index=order,
                        bvid=str(ep.get("bvid") or arc.get("bvid") or ""),
                        cid=_ts(ep.get("cid") or page.get("cid")),
                        title=str(ep.get("title") or arc.get("title") or f"第{order}集"),
                        cover=_https(str(arc.get("pic") or ep.get("pic") or "")),
                        duration=_ts(page.get("duration") or arc.get("duration")),
                    )
                )
        if episodes:
            info.season_id = str(season["id"])
            info.season_title = str(season.get("title") or "")
            info.season_episodes = episodes
    return info


def _stream_candidates(stream: dict) -> list[str]:
    urls: list[str] = []
    for key in ("baseUrl", "base_url", "backupUrl", "backup_url"):
        value = stream.get(key)
        items = value if isinstance(value, list) else [value]
        for item in items:
            url = https(str(item or ""))
            if url and url not in urls:
                urls.append(url)
    # 优先 bilivideo 域，避免 PCDN 域名
    trusted = [u for u in urls if any(s in (urlsplit(u).hostname or "") for s in VIDEO_HOST_SUFFIXES)]
    return trusted or urls


def _codec_rank(codec: str) -> int:
    codec = (codec or "").lower()
    for idx, prefix in enumerate(CODEC_PRIORITY):
        if codec.startswith(prefix):
            return idx
    return len(CODEC_PRIORITY)


def _audio_rank(track: dict) -> tuple[int, int]:
    """音频轨排序：AAC(mp4a) 优先，其次才是杜比(ec-3)等。

    B站 会员视频会同时给 AVC/AAC 与杜比全景声两套音轨，按码率选会选到
    `ec-3`——文件名还是 `.m4a`，但不少播放器/电视/媒体库解不了，表现为
    「有文件、有进度条，就是没有声音」。所以先按编码排，再按码率排。
    """
    codec = str(track.get("codecs") or "").lower()
    mime = str(track.get("mimeType") or track.get("mime_type") or "").lower()
    aac = codec.startswith("mp4a") or "mp4a" in codec or "aac" in mime
    return (0 if aac else 1, -_ts(track.get("bandwidth")))


async def _playurl(session: BiliSession, bvid: str, cid: int, qn: int, fnval: int, referer: str) -> dict:
    params: dict[str, Any] = {
        "bvid": bvid,
        "cid": cid,
        "qn": qn,
        "fnval": fnval,
        "fnver": 0,
        "fourk": 1,
        "platform": "pc",
    }
    if fnval == 0:
        params["type"] = "mp4"
    # 已登录才走 wbi 接口：未登录时 wbi 版 playurl 必然 -101，多发一次请求只是徒增风控风险
    if session.user.get("logged_in"):
        try:
            payload = await session.get(
                f"{API}/x/player/wbi/playurl", params, use_wbi=True, referer=referer
            )
            if (payload.get("data") or {}).get("dash") or (payload.get("data") or {}).get("durl"):
                return payload.get("data") or {}
        except BiliError:
            pass
    payload = await session.get(f"{API}/x/player/playurl", params, use_wbi=False, referer=referer)
    return payload.get("data") or {}


async def play_streams(
    session: BiliSession,
    bvid: str,
    cid: int,
    quality: str = "1080P60",
    *,
    ffmpeg_ok: bool = True,
) -> dict[str, Any]:
    """挑选最合适的播放流。

    DASH 能拿到 1080P60 等高清流，但音视频分离需要用 ffmpeg 合并；
    匿名访问时 DASH 往往只有 480P，而 mp4 直链可到 720P，此时优先直链。
    """
    qn = QUALITY_CHOICES.get(quality, 1080)
    referer = f"{SITE}/video/{bvid}"
    dash = await _playurl(session, bvid, cid, qn, FNVAL_DASH, referer)
    dash_videos = [v for v in (dash.get("dash") or {}).get("video") or [] if isinstance(v, dict)]
    dash_audios = [a for a in (dash.get("dash") or {}).get("audio") or [] if isinstance(a, dict)]
    dash_audios += [
        a
        for a in (((dash.get("dash") or {}).get("dolby") or {}).get("audio") or [])
        if isinstance(a, dict)
    ]

    chosen: dict[str, Any] | None = None
    if dash_videos:
        usable = [
            v
            for v in dash_videos
            if 0 < _ts(v.get("id")) <= qn and _ts(v.get("id")) not in UNSUPPORTED_VIDEO_IDS
        ]
        if usable:
            best_id = max(_ts(v.get("id")) for v in usable)
            same = [v for v in usable if _ts(v.get("id")) == best_id]
            same.sort(key=lambda v: (_codec_rank(str(v.get("codecs") or "")), -_ts(v.get("bandwidth"))))
            chosen = same[0]

    progressive = await _playurl(session, bvid, cid, qn, FNVAL_PROGRESSIVE, referer)
    durl = progressive.get("durl") or []
    prog_url = ""
    prog_quality = _ts(progressive.get("quality"))
    if durl and isinstance(durl[0], dict):
        candidates = [durl[0].get("url"), *(durl[0].get("backup_url") or [])]
        for cand in candidates:
            cand = https(str(cand or ""))
            if cand:
                prog_url = cand
                break

    use_dash = False
    if chosen and dash_audios and ffmpeg_ok:
        dash_quality = _ts(chosen.get("id"))
        if not prog_url or dash_quality >= prog_quality:
            use_dash = True

    # AAC 优先（见 _audio_rank）：能播比码率高更重要
    audio = min(dash_audios, key=_audio_rank) if dash_audios else None
    audio_codec = str((audio or {}).get("codecs") or "")

    if use_dash and chosen and audio:
        video_urls = _stream_candidates(chosen)
        audio_urls = _stream_candidates(audio)
        if video_urls and audio_urls:
            q = _ts(chosen.get("id"))
            return {
                "mode": "dash",
                "quality": q,
                "quality_label": QUALITY_LABELS.get(q, str(q)),
                "video_urls": video_urls,
                "audio_urls": audio_urls,
                "dash_video_urls": video_urls,
                "dash_audio_urls": audio_urls,
                "audio_codec": audio_codec,
                "note": "",
            }

    if prog_url:
        return {
            "mode": "progressive",
            "quality": prog_quality,
            "quality_label": QUALITY_LABELS.get(prog_quality, str(prog_quality)),
            "video_urls": [prog_url],
            "audio_urls": [],
            "dash_video_urls": _stream_candidates(chosen) if chosen else [],
            "dash_audio_urls": _stream_candidates(audio) if audio else [],
            "audio_codec": audio_codec,
            "note": "",
        }

    if chosen and audio:
        q = _ts(chosen.get("id"))
        return {
            "mode": "dash",
            "quality": q,
            "quality_label": QUALITY_LABELS.get(q, str(q)),
            "video_urls": _stream_candidates(chosen),
            "audio_urls": _stream_candidates(audio),
            "dash_video_urls": _stream_candidates(chosen),
            "dash_audio_urls": _stream_candidates(audio),
            "audio_codec": audio_codec,
            "note": "未找到 mp4 直链，将下载 DASH 流并用 ffmpeg 合并",
        }
    raise BiliError("没有获取到可用的视频流（可能需要登录或该视频有地区/会员限制）")


# --------------------------------------------------------------------- 图文


def _opus_from_modules(item: dict) -> OpusInfo:
    """把 opus/dynamic 的 modules 结构转换为统一模型。"""
    oid = str(item.get("id_str") or item.get("id") or "")
    modules = item.get("modules")
    module_list = modules if isinstance(modules, list) else []
    module_map = {m.get("module_type"): m for m in module_list if isinstance(m, dict)}

    title = ""
    mtitle = module_map.get("MODULE_TYPE_TITLE") or {}
    if mtitle.get("module_title"):
        title = str(mtitle["module_title"].get("text") or "")

    author = ""
    pub_ts = 0
    mid = ""
    mauthor = (module_map.get("MODULE_TYPE_AUTHOR") or {}).get("module_author") or {}
    if mauthor:
        author = str(mauthor.get("name") or "")
        pub_ts = _ts(mauthor.get("pub_ts") or mauthor.get("pub_time"))
        mid = str(mauthor.get("mid") or "")

    images: list[dict[str, Any]] = []
    texts: list[str] = []
    mcontent = (module_map.get("MODULE_TYPE_CONTENT") or {}).get("module_content") or {}
    for para in mcontent.get("paragraphs") or []:
        if not isinstance(para, dict):
            continue
        para_type = para.get("para_type")
        if para_type == 1:
            node_text = (para.get("text") or {}).get("nodes") or []
            words = "".join(str((n.get("word") or {}).get("words") or "") for n in node_text if isinstance(n, dict))
            if words.strip():
                texts.append(words.strip())
        elif para_type == 2:
            for pic in ((para.get("pic") or {}).get("pics") or []):
                url = original_image_url(str(pic.get("url") or ""))
                if url:
                    images.append({"url": url, "width": _ts(pic.get("width")), "height": _ts(pic.get("height"))})
        elif para_type == 3:
            for card in [para.get("link_card") or {}]:
                if card.get("card") and card["card"].get("title"):
                    texts.append(str(card["card"]["title"]))

    if not title and texts:
        title = texts[0][:80]
    return OpusInfo(
        oid=oid,
        kind="opus",
        title=title or "无标题图文",
        author=author,
        mid=mid,
        pubdate=pub_ts,
        cover=images[0]["url"] if images else "",
        text="\n".join(texts),
        images=images,
        url=f"{SITE}/opus/{oid}",
    )


def _walk_dynamic_pics(node: Any, images: list[dict[str, Any]], seen: set[str]) -> None:
    """从动态 SSR 结构里递归收集图片（兼容新版 opus / 旧版 draw / 置顶 album）。"""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("pics", "covers", "items") and isinstance(value, list):
                for pic in value:
                    if isinstance(pic, dict):
                        url = str(pic.get("url") or pic.get("src") or "")
                        width, height = _ts(pic.get("width")), _ts(pic.get("height"))
                    elif isinstance(pic, str):
                        url, width, height = pic, 0, 0
                    else:
                        continue
                    url = original_image_url(url)
                    if url and url not in seen:
                        seen.add(url)
                        images.append({"url": url, "width": width, "height": height})
            _walk_dynamic_pics(value, images, seen)
    elif isinstance(node, list):
        for item in node:
            _walk_dynamic_pics(item, images, seen)


def _dynamic_text(node: Any, out: list[str]) -> None:
    if isinstance(node, dict):
        if "words" in node and isinstance(node["words"], str):
            out.append(node["words"])
        if "text" in node and isinstance(node["text"], str) and len(node["text"]) < 400:
            out.append(node["text"])
        for value in node.values():
            _dynamic_text(value, out)
    elif isinstance(node, list):
        for item in node:
            _dynamic_text(item, out)


def _module_author(modules: Any) -> tuple[str, str, int]:
    """从 SSR / 详情 modules（list 或旧版 dict）提取作者昵称、UID、发布时间。"""
    if isinstance(modules, dict):
        ma = modules.get("module_author") or {}
        if isinstance(ma, dict):
            return (str(ma.get("name") or ""), str(ma.get("mid") or ""),
                    _ts(ma.get("pub_ts") or ma.get("pub_time")))
        return "", "", 0
    if isinstance(modules, list):
        for m in modules:
            if isinstance(m, dict) and m.get("module_type") == "MODULE_TYPE_AUTHOR":
                ma = m.get("module_author") or {}
                if isinstance(ma, dict):
                    return (str(ma.get("name") or ""), str(ma.get("mid") or ""),
                            _ts(ma.get("pub_ts") or ma.get("pub_time")))
    return "", "", 0


async def opus_from_html(session: BiliSession, oid: str) -> OpusInfo:
    """页面兜底解析：部分旧动态 / 置顶图文在接口里没有 CONTENT 模块，只有页面 SSR 里有图。"""
    resp = await session.client.get(
        f"{SITE}/opus/{oid}",
        headers={"Referer": SITE + "/", "User-Agent": DESKTOP_UA},
    )
    state = _extract_initial_state(resp.text)
    detail = state.get("detail") or {}
    if not detail:
        raise NotFound("图文不存在或已被删除")
    modules = detail.get("modules") or []

    images: list[dict[str, Any]] = []
    seen: set[str] = set()
    _walk_dynamic_pics(modules, images, seen)

    words: list[str] = []
    _dynamic_text(modules, words)
    text = ""
    for w in words:
        w = w.strip()
        if w and w not in text:
            text = f"{text} {w}".strip()
        if len(text) > 300:
            break

    basic = detail.get("basic") or {}
    title = str(basic.get("title") or "").replace(" - 哔哩哔哩", "").strip()
    if title.endswith("的动态") or title.endswith("的专栏") or title.endswith("的相簿"):
        title = ""
    author, author_mid, pubdate = _module_author(modules)
    mid = author_mid or str(basic.get("uid") or "")
    if not title:
        title = (text[:40] or f"图文{oid}").strip()
    title = re.sub(r"^(年度大会员|充电专属|置顶)\s*", "", title).strip() or f"图文{oid}"
    return OpusInfo(
        oid=str(detail.get("id_str") or oid),
        kind="opus",
        title=title,
        author=author,
        mid=mid,
        pubdate=pubdate,
        cover=images[0]["url"] if images else "",
        text=text,
        images=images,
        url=f"{SITE}/opus/{oid}",
    )


async def opus_detail(session: BiliSession, oid: str) -> OpusInfo:
    """图文（opus）详情。"""
    payload = await session.get(
        f"{API}/x/polymer/web-dynamic/v1/opus/detail",
        {"id": oid},
        referer=f"{SITE}/opus/{oid}",
    )
    data = payload.get("data") or {}
    item = data.get("item") or {}
    if not item:
        # 旧专栏/动态转成 opus 后，opus/detail 会返回 item=null + fallback（例如
        # /opus/1066072524289212420 → fallback {type:2,id:41645323}）。
        # 这类页面的 SSR __INITIAL_STATE__.detail 里仍有完整 modules，直接走页面兜底，
        # 否则会被误判成「图文不存在或已被删除」。
        try:
            info = await opus_from_html(session, oid)
            info.oid = str(info.oid or oid)
            return info
        except BiliError:
            pass
        raise NotFound("图文不存在或已被删除")
    info = _opus_from_modules(item)
    info.oid = str(item.get("id_str") or oid)
    basic = item.get("basic") or {}
    if not info.title or info.title == "无标题图文":
        info.title = str(basic.get("title") or info.title)
    if info.images:
        return info

    # 接口没给图（旧动态 / 置顶图文）：解析页面 SSR
    try:
        fallback = await opus_from_html(session, oid)
    except BiliError:
        return info
    fallback.oid = info.oid or fallback.oid
    if not fallback.title or fallback.title.startswith("图文"):
        fallback.title = info.title or fallback.title
    fallback.author = fallback.author or info.author
    fallback.mid = fallback.mid or info.mid
    fallback.pubdate = fallback.pubdate or info.pubdate
    if not fallback.text:
        fallback.text = info.text
    return fallback


async def dynamic_detail(session: BiliSession, dyn_id: str) -> OpusInfo:
    """旧版动态（t.bilibili.com/数字）。"""
    payload = await session.get(
        f"{API}/x/polymer/web-dynamic/v1/detail",
        {"id": dyn_id},
        referer=f"https://t.bilibili.com/{dyn_id}",
    )
    item = (payload.get("data") or {}).get("item") or {}
    if not item:
        raise NotFound("动态不存在或已被删除")
    modules = item.get("modules") or {}
    author = str((modules.get("module_author") or {}).get("name") or "")
    mid = str((modules.get("module_author") or {}).get("mid") or "")
    pub_ts = _ts((modules.get("module_author") or {}).get("pub_ts"))
    dynamic = modules.get("module_dynamic") or {}
    desc = str((dynamic.get("desc") or {}).get("text") or "")
    major = dynamic.get("major") or {}

    images: list[dict[str, Any]] = []
    title = desc[:80] or "无标题动态"
    opus = major.get("opus") or {}
    if opus:
        if opus.get("title"):
            title = str(opus["title"])
        for pic in opus.get("pics") or []:
            url = original_image_url(str(pic.get("url") or ""))
            if url:
                images.append({"url": url, "width": _ts(pic.get("width")), "height": _ts(pic.get("height"))})
    draw = major.get("draw") or {}
    for pic in draw.get("items") or []:
        url = original_image_url(str(pic.get("src") or ""))
        if url and not any(i["url"] == url for i in images):
            images.append({"url": url, "width": _ts(pic.get("width")), "height": _ts(pic.get("height"))})
    article = major.get("article") or {}
    if article:
        title = str(article.get("title") or title)
        for url in article.get("covers") or []:
            url = original_image_url(str(url))
            if url:
                images.append({"url": url, "width": 0, "height": 0})

    return OpusInfo(
        oid=str(item.get("id_str") or dyn_id),
        kind="dynamic",
        title=title,
        author=author,
        mid=mid,
        pubdate=pub_ts,
        cover=images[0]["url"] if images else "",
        text=desc,
        images=images,
        url=f"https://t.bilibili.com/{dyn_id}",
    )


def _extract_initial_state(html: str) -> dict[str, Any]:
    marker = "__INITIAL_STATE__="
    idx = html.find(marker)
    if idx < 0:
        return {}
    start = idx + len(marker)
    try:
        obj, _ = json.JSONDecoder().raw_decode(html[start:])
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        return {}


async def article_detail(session: BiliSession, cvid: str) -> OpusInfo:
    """专栏（read/cv）详情：优先接口，失败再解析页面。"""
    title = ""
    author = ""
    images: list[dict[str, Any]] = []
    text = ""
    pubdate = 0
    mid = ""
    try:
        # 新版专栏：正文其实是一条动态图文，`dyn_id_str` 里存着 opus/dyn id，
        # 用它调 opus/detail 才能拿到全部图片（`image_urls` 只给封面）。
        if not images:
            try:
                view = await session.get(
                    f"{API}/x/article/view",
                    {"id": cvid},
                    referer=f"{SITE}/read/cv{cvid}",
                )
                vd = view.get("data") or {}
                opus = vd.get("opus") or {}
                opus_id = str(opus.get("opus_id") or "").strip()
                if opus_id.isdigit() and not images:
                    imgs: list[dict[str, Any]] = []
                    for para in ((opus.get("content") or {}).get("paragraphs") or []):
                        if para.get("para_type") != 2:
                            continue
                        for pic in ((para.get("pic") or {}).get("pics") or []):
                            url = original_image_url(_https(str(pic.get("url") or "")))
                            if url:
                                imgs.append({"url": url, "width": int(pic.get("width") or 0), "height": int(pic.get("height") or 0)})
                    if imgs:
                        au = vd.get("author") or {}
                        return OpusInfo(
                            kind="article",
                            oid=opus_id,
                            title=str(vd.get("title") or opus.get("title") or ""),
                            author=str(au.get("name") or "") if isinstance(au, dict) else "",
                            mid=str(au.get("mid") or "") if isinstance(au, dict) else "",
                            pubdate=_ts(vd.get("publish_time") or vd.get("ctime")),
                            images=imgs,
                        )
                dyn = str(vd.get("dyn_id_str") or "").strip()
                if dyn.isdigit():
                    meta = await opus_detail(session, dyn)
                    meta.title = str(vd.get("title") or meta.title or "")
                    au = vd.get("author") or {}
                    if isinstance(au, dict):
                        meta.author = str(au.get("name") or meta.author or "")
                        meta.mid = str(au.get("mid") or meta.mid or "")
                    meta.oid = str(cvid)
                    meta.kind = "article"
                    if meta.images:
                        return meta
            except BiliError:
                pass
        info = await session.get(
            f"{API}/x/article/viewinfo",
            {"aid": cvid},
            referer=f"{SITE}/read/cv{cvid}",
        )
        data = info.get("data") or {}
        title = str(data.get("title") or "")
        author = str((data.get("author") or {}).get("name") or "")
        mid = str((data.get("author") or {}).get("mid") or "")
        pubdate = _ts(data.get("publish_time") or data.get("ctime"))
        for url in data.get("origin_image_urls") or data.get("image_urls") or []:
            url = original_image_url(str(url))
            if url:
                images.append({"url": url, "width": _ts(data.get("banner_width")), "height": 0})
    except BiliError:
        pass

    if not title or not images:
        resp = await session.client.get(
            f"{SITE}/read/cv{cvid}", headers={"Referer": SITE + "/"}
        )
        html = resp.text
        state = _extract_initial_state(html)
        read = (state.get("readInfo") or {}) if state else {}
        title = title or str(read.get("title") or "")
        author = author or str((read.get("author") or {}).get("name") or "")
        content = str(read.get("content") or "")
        if content:
            found = re.findall(r"<img[^>]+src=\"([^\"]+)\"", content)
            for url in found:
                url = original_image_url(url)
                if url and not any(i["url"] == url for i in images):
                    images.append({"url": url, "width": 0, "height": 0})
            text = re.sub(r"<[^>]+>", "", content).strip()

    if not title and not images:
        raise NotFound("专栏不存在或无法解析")
    return OpusInfo(
        oid=cvid,
        kind="article",
        title=title or f"专栏{cvid}",
        author=author,
        mid=mid,
        pubdate=pubdate,
        cover=images[0]["url"] if images else "",
        text=text,
        images=images,
        url=f"{SITE}/read/cv{cvid}",
    )


# --------------------------------------------------------------------- UP 主


def _video_work(item: dict) -> AuthorWork:
    return AuthorWork(
        kind="video",
        ident=str(item.get("bvid") or ""),
        title=str(item.get("title") or ""),
        cover=https(str(item.get("pic") or item.get("cover") or "")),
        duration=_ts(item.get("duration") or item.get("length")),
        pubdate=_ts(item.get("created") or item.get("pubdate") or item.get("ctime")),
    )


async def _space_videos_app(
    session: BiliSession,
    mid: str,
    *,
    delay: float = 1.6,
    max_pages: int = 60,
    progress: Callable[[str], None] | None = None,
    stop: Callable[[list[AuthorWork]], bool] | None = None,
) -> tuple[list[AuthorWork], int]:
    """App 端投稿列表：x/v2/space/archive 支持 pn 翻页，返回全部视频。

    故意不请求网页版 x/space/wbi/arc/search —— 该接口在机房 IP 上会返回
    412 并被 B 站风控标记，App 接口则无需 WBI 指纹、稳定且风控风险最低。
    """
    works: list[AuthorWork] = []
    seen: set[str] = set()
    total = 0
    for pn in range(1, max_pages + 1):
        payload = await session.get_app(
            "https://app.bilibili.com/x/v2/space/archive",
            {"vmid": mid, "ps": 30, "pn": pn, "order": "pubdate"},
        )
        data = payload.get("data") or {}
        total = _ts(data.get("count")) or total
        items = data.get("item") or []
        if not items:
            break
        for item in items:
            bvid = str(item.get("bvid") or "")
            if not bvid:
                continue
            if bvid in seen:
                continue
            seen.add(bvid)
            works.append(
                AuthorWork(
                    kind="video",
                    ident=bvid,
                    title=str(item.get("title") or ""),
                    cover=https(str(item.get("cover") or "")),
                    duration=_ts(item.get("duration")),
                    pubdate=_ts(item.get("ctime")),
                    extra={
                        "aid": str(item.get("param") or ""),
                        "page_count": _ts(item.get("videos")),
                        "views": _ts(item.get("play")),
                    },
                )
            )
        if progress:
            progress(f"已获取 {len(works)} 个视频（共 {total or '?'}）")
        if stop is not None and stop(works):
            break
        if total and len(works) >= total:
            break
        if len(items) < 20:
            break
        await asyncio.sleep(delay)
    return works, total


async def space_videos(
    session: BiliSession,
    mid: str,
    *,
    delay: float = 1.6,
    max_pages: int = 60,
    progress: Callable[[str], None] | None = None,
    stop: Callable[[list[AuthorWork]], bool] | None = None,
) -> tuple[list[AuthorWork], str]:
    """获取 UP 主全部投稿视频，返回 (作品列表, 提示信息)。

    统一走 App 端接口：网页版投稿列表接口带 WBI 校验，机房 IP 会 412/风控，
    为了「绝不触发风控」这里直接放弃网页接口。
    """
    note = ""
    try:
        works, total = await _space_videos_app(
            session, mid, delay=delay, max_pages=max_pages, progress=progress, stop=stop
        )
    except RiskControl:
        raise
    except BiliError as exc:
        works, total = [], 0
        note = f"视频列表接口失败：{exc}"
    if works:
        if total and len(works) < total:
            note = f"已获取 {len(works)}/{total} 个视频（其余可能被 B 站限制），可稍后重试。"
        return works, note
    return [], note or "没有获取到任何视频，请确认 UP 主 ID 或稍后重试"


async def space_opus(
    session: BiliSession,
    mid: str,
    *,
    delay: float = 1.6,
    max_pages: int = 100,
    progress: Callable[[str], None] | None = None,
    stop: Callable[[list[AuthorWork]], bool] | None = None,
) -> tuple[list[AuthorWork], str]:
    """获取 UP 主全部图文作品（opus 列表接口，支持翻页）。"""
    works: list[AuthorWork] = []
    seen: set[str] = set()
    offset: str | None = None
    note = ""
    for page in range(1, max_pages + 1):
        params: dict[str, Any] = {"host_mid": mid}
        if offset:
            params["offset"] = offset
            params["page"] = page
        try:
            payload = await session.get(
                f"{API}/x/polymer/web-dynamic/v1/opus/feed/space",
                params,
                referer=f"https://space.bilibili.com/{mid}/upload/opus",
                retries=2,
            )
        except BiliError as exc:
            note = f"翻页中断：{exc}"
            break
        data = payload.get("data") or {}
        items = data.get("items") or []
        for item in items:
            oid = str(item.get("opus_id") or "")
            if not oid or oid in seen:
                continue
            seen.add(oid)
            cover = original_image_url(str((item.get("cover") or {}).get("url") or ""))
            works.append(
                AuthorWork(
                    kind="opus",
                    ident=oid,
                    title=str(item.get("content") or "图文作品")[:80],
                    cover=cover,
                    pubdate=0,
                )
            )
        if progress:
            progress(f"已获取 {len(works)} 个图文作品（第 {page} 页）")
        if stop is not None and stop(works):
            break
        if not data.get("has_more") or not items:
            break
        offset = str(data.get("offset") or "")
        if not offset:
            break
        await asyncio.sleep(delay)
    return works, note


async def user_card(session: BiliSession, mid: str) -> dict[str, Any]:
    """UP 主基础信息（昵称/头像/粉丝数）。"""
    try:
        payload = await session.get_app(
            "https://app.bilibili.com/x/v2/space",
            {"vmid": mid},
        )
    except BiliError:
        return {"mid": mid, "name": "", "face": "", "fans": 0}
    data = payload.get("data") or {}
    card = data.get("card") or {}
    relation = data.get("relation")
    fans = relation.get("follower") if isinstance(relation, dict) else relation
    return {
        "mid": str(card.get("mid") or mid),
        "name": str(card.get("name") or ""),
        "face": https(str(card.get("face") or "")),
        "fans": max(0, _ts(fans if fans is not None else card.get("fans") or 0)),
        "sign": str(card.get("sign") or ""),
    }


async def qrcode_generate(session: BiliSession) -> dict[str, Any]:
    """申请扫码登录二维码（注意：passport 域名，api 域名会 404）。"""
    headers = {"Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com"}
    if session.cookies:
        headers["Cookie"] = session.cookie_header()
    resp = await session.client.get(
        f"{PASSPORT}/x/passport-login/web/qrcode/generate", headers=headers
    )
    payload = resp.json() if resp.content else {}
    data = payload.get("data") or {}
    return {"url": data.get("url", ""), "qrcode_key": data.get("qrcode_key", "")}


async def qrcode_poll(session: BiliSession, key: str) -> dict[str, Any]:
    """轮询扫码状态：86101 未扫码 / 86090 已扫码待确认 / 86038 已过期 / 0 成功。"""
    headers = {"Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com"}
    if session.cookies:
        headers["Cookie"] = session.cookie_header()
    resp = await session.client.get(
        f"{PASSPORT}/x/passport-login/web/qrcode/poll",
        params={"qrcode_key": key},
        headers=headers,
    )
    payload = resp.json() if resp.content else {}
    data = payload.get("data") or {}
    code = int(data.get("code", -1))
    if code == 0:
        cookies: dict[str, str] = {}
        for cookie in session.client.cookies.jar:
            if cookie.name and cookie.value:
                cookies[cookie.name] = cookie.value
        cookie_info = data.get("cookie_info") or {}
        for entry in cookie_info.get("cookies") or []:
            if isinstance(entry, dict) and entry.get("name"):
                cookies[str(entry["name"])] = str(entry.get("value") or "")
        session.cookies.update({k: v for k, v in cookies.items() if v})
        session._buvid_ready = False  # noqa: SLF001
        await session.refresh_user()
    return {"code": code, "message": data.get("message", "")}

async def fav_folders(session: BiliSession, mid: str) -> list[dict[str, Any]]:
    """某 UP 主公开的收藏夹列表（收藏夹 id / 标题 / 内容数）。"""
    payload = await session.get(
        f"{API}/x/v3/fav/folder/created/list-all",
        {"up_mid": mid, "jsonp": "jsonp"},
        referer=f"https://space.bilibili.com/{mid}/favlist",
        retries=1,
    )
    data = payload.get("data") or {}
    out: list[dict[str, Any]] = []
    for item in data.get("list") or []:
        out.append(
            {
                "id": str(item.get("id") or ""),
                "title": str(item.get("title") or ""),
                "count": _ts(item.get("media_count")),
            }
        )
    return out


async def fav_items(
    session: BiliSession,
    media_id: str,
    *,
    delay: float = 1.6,
    max_pages: int = 40,
    stop: Callable[[list[AuthorWork]], bool] | None = None,
) -> tuple[list[AuthorWork], str]:
    """收藏夹内容（按收藏时间倒序，即最新在前）。需要登录 Cookie。"""
    if "SESSDATA" not in session.cookie_header():
        raise BiliError("收藏夹需要登录：请到「账号登录」页扫码或用 Cookie 登录后再订阅")
    works: list[AuthorWork] = []
    seen: set[str] = set()
    note = ""
    for pn in range(1, max_pages + 1):
        payload = await session.get(
            f"{API}/x/v3/fav/resource/list",
            {"media_id": media_id, "pn": pn, "ps": 20, "order": "mtime", "type": 0, "platform": "web"},
            referer=f"https://www.bilibili.com/medialist/detail/ml{media_id}",
            retries=1,
        )
        data = payload.get("data") or {}
        medias = data.get("medias") or []
        for item in medias:
            bvid = str(item.get("bvid") or "")
            if not bvid or bvid in seen:
                continue
            seen.add(bvid)
            works.append(
                AuthorWork(
                    kind="video",
                    ident=bvid,
                    title=str(item.get("title") or ""),
                    cover=str(item.get("cover") or ""),
                    duration=_ts(item.get("duration")),
                    pubdate=_ts(item.get("pubtime")) or _ts(item.get("ctime")),
                )
            )
        if stop is not None and stop(works):
            break
        if not data.get("has_more") or not medias:
            break
        await asyncio.sleep(delay)
    if not works:
        note = "收藏夹是空的，或者没有权限读取（可能需要登录）"
    return works, note


async def toview_items(session: BiliSession) -> tuple[list[AuthorWork], str]:
    """稍后再看列表（最新加入的在前）。需要登录 Cookie。"""
    if "SESSDATA" not in session.cookie_header():
        raise BiliError("稍后再看需要登录：请到「账号登录」页扫码或用 Cookie 登录后再订阅")
    payload = await session.get(
        f"{API}/x/v2/history/toview",
        {},
        referer="https://www.bilibili.com/",
        retries=1,
    )
    data = payload.get("data") or {}
    works: list[AuthorWork] = []
    for item in data.get("list") or []:
        bvid = str(item.get("bvid") or "")
        if not bvid:
            continue
        works.append(
            AuthorWork(
                kind="video",
                ident=bvid,
                title=str(item.get("title") or ""),
                cover=str(item.get("cover") or ""),
                duration=_ts(item.get("duration")),
                pubdate=_ts(item.get("add_at")),
            )
        )
    return works, ("" if works else "稍后再看是空的")


async def season_episodes(session: BiliSession, season_id: str) -> tuple[list[AuthorWork], str]:
    """番剧/影视的剧集列表（按最新集在前返回，方便增量判断）。"""
    season_id = str(season_id).strip()
    low = season_id.lower()
    if low.startswith("ep"):
        params = {"ep_id": season_id[2:]}
    elif low.startswith("ss"):
        params = {"season_id": season_id[2:]}
    elif season_id.isdigit():
        params = {"season_id": season_id}
    else:
        params = {"ep_id": season_id}
    payload = await session.get(
        "https://api.bilibili.com/pgc/view/web/season",
        params,
        referer=f"https://www.bilibili.com/bangumi/play/ss{season_id}",
        retries=1,
    )
    result = payload.get("result") or {}
    episodes = result.get("episodes") or []
    works: list[AuthorWork] = []
    for ep in episodes:
        bvid = str(ep.get("bvid") or "")
        if not bvid:
            continue
        works.append(
            AuthorWork(
                kind="video",
                ident=bvid,
                title=str(ep.get("share_copy") or ep.get("long_title") or f"第 {ep.get('title')} 话"),
                cover=str(ep.get("cover") or ""),
                duration=int((ep.get("duration") or 0) // 1000),
                pubdate=_ts(ep.get("pub_time")),
            )
        )
    works.reverse()  # 最新一集在前
    note = "" if works else "没有取到剧集列表（检查 season_id / 是否需要大会员）"
    return works, note

# ----------------------------------------------------------------- 附加内容
async def subtitles(session: BiliSession, bvid: str, cid: int) -> list[dict[str, Any]]:
    """视频字幕列表（含各语言 json 地址）。未登录通常返回空列表。"""
    referer = f"{SITE}/video/{bvid}"
    payload = await session.get(
        f"{API}/x/player/v2", {"bvid": bvid, "cid": cid}, use_wbi=False, referer=referer
    )
    data = payload.get("data") or {}
    items = ((data.get("subtitle") or {}).get("subtitles")) or []
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        url = https(str(item.get("subtitle_url") or ""))
        if not url:
            continue
        out.append({"lan": str(item.get("lan") or "zh"), "doc": str(item.get("lan_doc") or ""), "url": url})
    return out


async def video_pic(session: BiliSession, bvid: str) -> str:
    info = await video_info(session, bvid)
    picture = getattr(info, "cover", "") or ""
    return https(picture)


async def danmaku_xml(session: BiliSession, cid: int) -> bytes:
    """弹幕 XML 原始字节。"""
    url = f"https://api.bilibili.com/x/v1/dm/list.so"
    return await session.get_bytes(url, params={"oid": cid}, referer=f"{SITE}/video/")


async def subtitle_json(session: BiliSession, url: str, referer: str = f"{SITE}/") -> dict[str, Any]:
    raw = await session.get_bytes(url, referer=referer)
    try:
        data = json.loads(raw.decode("utf-8", "ignore"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------- 文集 / 视频合集
def _pick_article_list(node: Any, depth: int = 0) -> list[dict[str, Any]]:
    """在任意嵌套结构里找「像文章列表」的数组（元素含 id + title）。"""
    if depth > 5:
        return []
    if isinstance(node, list):
        if node and all(isinstance(it, dict) for it in node[:3]):
            keys = set(node[0].keys())
            if "id" in keys and ("title" in keys or "content" in keys):
                return [it for it in node if isinstance(it, dict)]
        for item in node[:5]:
            found = _pick_article_list(item, depth + 1)
            if found:
                return found
        return []
    if isinstance(node, dict):
        for key in ("list", "articles", "items", "readlist", "data", "result"):
            if key in node:
                found = _pick_article_list(node[key], depth + 1)
                if found:
                    return found
        for value in node.values():
            found = _pick_article_list(value, depth + 1)
            if found:
                return found
    return []


async def readlist_detail(session: BiliSession, list_id: str) -> dict[str, Any]:
    """文集（readlist）详情。

    B站 的 `/x/readlist/detail/*` 接口已经下线（返回 404），网页实际用的是
    `GET /x/article/list/web/articles?id=<纯数字>`，匿名也能取到文集合集与文章列表。
    """
    raw_id = str(list_id).strip()
    rid = raw_id[2:] if raw_id.lower().startswith("rl") else raw_id
    if not rid.isdigit():
        raise ParseError(f"文集 ID 不正确：{raw_id}")
    referer = f"https://www.bilibili.com/read/readlist/rl{rid}"
    payload = await session.get(
        f"{API}/x/article/list/web/articles",
        params={"id": rid, "web_location": "333.1400"},
        referer=referer,
    )
    data = payload.get("data") or {}
    meta = data.get("list") or {}
    title = str(meta.get("name") or meta.get("title") or f"文集 rl{rid}")
    author = ""
    au = data.get("author")
    if isinstance(au, dict):
        author = str(au.get("name") or au.get("uname") or "")
    elif isinstance(meta.get("author"), dict):
        author = str((meta["author"] or {}).get("name") or "")
    raw = data.get("articles") or []
    articles: list[dict[str, Any]] = []
    for idx, item in enumerate(raw, start=1):
        cvid = str(item.get("id") or item.get("cvid") or "").strip()
        if not cvid.isdigit():
            continue
        cover = ""
        imgs = item.get("image_urls") or item.get("images") or []
        if isinstance(imgs, list) and imgs:
            cover = _https(str(imgs[0]))
        if not cover:
            cover = _https(str(item.get("banner_url") or item.get("image_url") or ""))
        oid = str(item.get("dyn_id_str") or "").strip()
        if not oid.isdigit():
            oid = cvid
        articles.append({
            "cvid": cvid,
            "oid": oid,
            "title": str(item.get("title") or f"文章 {idx}"),
            "order": idx,
            "cover": cover,
            "pubdate": int(item.get("publish_time") or item.get("ctime") or 0),
        })
    # 接口返回顺序不一定是文集的展示顺序（实测会出现 ②①③）；按发布时间升序排，
    # 让 <readlist_order> 与页面上看到的一致：最早的一篇是 1
    articles.sort(key=lambda a: (int(a.get("pubdate") or 0), str(a.get("cvid") or "")))
    for idx, item in enumerate(articles, start=1):
        item["order"] = idx
    return {
        "kind": "readlist",
        "id": f"rl{rid}",
        "title": title,
        "author": author,
        "articles": articles,
        "count": len(articles),
    }


async def videolist_detail(
    session: BiliSession, mid: str, season_id: str, *, max_pages: int = 20
) -> dict[str, Any]:
    """UP 主「合集」详情（space.bilibili.com/<mid>/lists/<id>），匿名可用。

    `max_pages` 只影响元数据场景（例如加订阅时只取首页拿标题）。
    """
    season_id = str(season_id).strip()
    mid = str(mid or "").strip()
    referer = f"https://space.bilibili.com/{mid}/lists/{season_id}" if mid else "https://space.bilibili.com/"
    works: list[AuthorWork] = []
    title = ""
    page = 1
    total = 0
    while page <= max(1, max_pages):
        payload = await session.get(
            f"{API}/x/polymer/web-space/seasons_archives_list",
            params={
                "mid": mid or None,
                "season_id": season_id,
                "page_num": page,
                "page_size": 100,
                "sort_reverse": "false",
            },
            referer=referer,
        )
        data = payload.get("data") or {}
        meta = data.get("meta") or {}
        title = title or str(meta.get("name") or "")
        total = int((data.get("page") or {}).get("total") or total or 0)
        archives = data.get("archives") or []
        for item in archives:
            bvid = str(item.get("bvid") or "").strip()
            if not bvid:
                continue
            works.append(AuthorWork(
                kind="video",
                ident=bvid,
                title=str(item.get("title") or bvid),
                cover=str(item.get("pic") or ""),
                duration=int(item.get("duration") or 0),
                pubdate=int(item.get("ctime") or 0),
            ))
        if not archives or (total and len(works) >= total):
            break
        page += 1
        await asyncio.sleep(0.4)
    return {
        "kind": "videolist",
        "id": season_id,
        "mid": mid,
        "title": title or season_id,
        "total": total or len(works),
        "count": len(works),
        "works": [
            {
                "kind": "video",
                "ident": w.ident,
                "title": w.title,
                "cover": w.cover,
                "duration": w.duration,
                "pubdate": w.pubdate,
            }
            for w in works
        ],
    }
