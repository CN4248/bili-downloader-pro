"""下载引擎：链接解析、任务队列、防风控调度与文件落盘。"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import random
import re
import shutil
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from . import api, extras as extras_mod, ffmpeg, youtube as yt
from .config import SettingsStore
from .constants import DEFAULT_QUALITY, QUALITY_CHOICES, RISK_BACKOFF
from .errors import AuthRequired, BiliError, DownloadError, NotFound, ParseError, RiskControl
from .http import BiliSession, parse_cookie_text
from .links import LinkRef, parse_links, youtube_channel_url
from .naming import build_relative, unique_path
from .models import OpusInfo, VideoInfo

IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "heic"}
MAX_IMAGE_RETRY = 2


def _now() -> float:
    return time.time()


def _date(ts: int) -> str:
    if not ts:
        return datetime.now().strftime("%Y%m%d")
    return datetime.fromtimestamp(ts).strftime("%Y%m%d")


def image_ext(url: str) -> str:
    path = urlsplit(url).path
    suffix = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return suffix if suffix in IMAGE_EXTS else "jpg"


@dataclass
class Task:
    id: str
    kind: str  # video / opus
    title: str
    subtitle: str
    ident: str
    status: str = "pending"  # pending/running/paused/done/skipped/error/canceled
    progress: float = 0.0
    done_bytes: int = 0
    total_bytes: int = 0
    total_items: int = 1
    done_items: int = 0
    path: str = ""
    error: str = ""
    quality: str = ""
    speed: float = 0.0
    created: float = field(default_factory=_now)
    started: float = 0.0
    finished: float = 0.0
    # 落盘清单：订阅任务记下每个文件用的是哪套变量，改重命名规则时可回算新名字
    files: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "subtitle": self.subtitle,
            "ident": self.ident,
            "status": self.status,
            "progress": round(self.progress, 3),
            "done_bytes": self.done_bytes,
            "total_bytes": self.total_bytes,
            "total_items": self.total_items,
            "done_items": self.done_items,
            "path": self.path,
            "error": self.error,
            "quality": self.quality,
            "speed": round(self.speed, 1),
        }


@dataclass
class ScanJob:
    id: str
    mid: str
    status: str = "running"  # running/done/error/canceled
    message: str = ""
    note: str = ""
    video: list[dict[str, Any]] = field(default_factory=list)
    opus: list[dict[str, Any]] = field(default_factory=list)
    user: dict[str, Any] = field(default_factory=dict)
    created: float = field(default_factory=_now)
    canceled: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "mid": self.mid,
            "status": self.status,
            "message": self.message,
            "note": self.note,
            "video": self.video,
            "videos": self.video,
            "opus": self.opus,
            "user": self.user,
            "video_count": len(self.video),
            "opus_count": len(self.opus),
        }


class Engine:
    """全局单例式的下载引擎：一个账号会话 + 一个任务队列。"""

    def __init__(self, store: SettingsStore) -> None:
        self.store = store
        settings = store.get()
        self.session = BiliSession(api_interval=settings.api_interval, proxy=settings.bili_proxy())
        self.tasks: dict[str, Task] = {}
        self.order: list[str] = []
        self.specs: dict[str, dict[str, Any]] = {}
        self.cancel_flags: set[str] = set()
        self.pause_flags: set[str] = set()  # 正在下载的任务被暂停，worker 在分片检查点中断
        self._active: set[str] = set()  # 正在 worker 手里处理的任务（含排队/等冷却）
        self._queued: set[str] = set()  # 还在 asyncio.Queue 里等 worker 取的任务 id（恢复时去重）
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.workers: list[asyncio.Task] = []
        self.scans: dict[str, ScanJob] = {}
        self._gate = asyncio.Lock()
        self._last_start = 0.0
        self._cooldown_until = 0.0
        self._risk_streak = 0
        self._paused_note = ""
        self.events: list[dict[str, Any]] = []
        self._closed = False
        self.ffmpeg_ok = ffmpeg.available()
        self._queue_path = Path(self.store.dir) / "queue.json"
        # 订阅任务落盘后的回调（subs.Subscriber 注入），用来记录文件→变量映射
        self.on_files_saved: Callable[[dict[str, Any], list[dict[str, Any]]], None] | None = None

    # ------------------------------------------------------------------ 生命周期
    async def start(self) -> None:
        cookie = self.store.load_cookie()
        if cookie:
            self.session.cookies.update(parse_cookie_text(cookie))
        self._load_queue()
        await self._ensure_workers()

    # -------------------------------------------------------------- 持久化
    def _persist(self) -> None:
        """把任务队列原子写到 data/queue.json。

        容器重启/重建时 data/ 是 bind mount，下次启动由 `_load_queue()` 恢复：
        - pending 任务重新入队并继续跑；
        - running 任务标记为 error（进程已随容器退出，不能假装还在跑）；
        - done/skipped/error/canceled 原样保留，UI 仍能看到。
        """
        try:
            payload = {
                "version": 1,
                "saved_at": _now(),
                "order": list(self.order),
                "tasks": [
                    {k: v for k, v in asdict(self.tasks[tid]).items() if k != "files"}
                    for tid in self.order
                    if tid in self.tasks
                ],
                "specs": {
                    tid: self.specs[tid]
                    for tid in self.order
                    if tid in self.specs
                },
            }
            self._queue_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._queue_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, default=str), encoding="utf-8")
            os.replace(tmp, self._queue_path)
        except OSError as exc:
            self.log(f"任务队列持久化失败：{exc}", "error")

    def _load_queue(self) -> None:
        try:
            raw = json.loads(self._queue_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError) as exc:
            self.log(f"读取任务队列失败，忽略旧记录：{exc}", "warn")
            return
        if not isinstance(raw, dict):
            return
        fields = set(Task.__dataclass_fields__)
        loaded: dict[str, Task] = {}
        for item in raw.get("tasks") or []:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            try:
                task = Task(**{k: v for k, v in item.items() if k in fields})
            except (TypeError, ValueError):
                continue
            if task.status == "running":
                task.status = "error"
                task.error = "服务重启导致任务中断，可重新添加"
                task.finished = task.finished or _now()
                task.progress = 0.0
                task.speed = 0.0
            loaded[task.id] = task
        if not loaded:
            return
        self.tasks = loaded
        self.order = [tid for tid in (raw.get("order") or []) if tid in loaded]
        if not self.order:
            self.order = list(loaded)
        self.specs = {
            tid: spec for tid, spec in (raw.get("specs") or {}).items()
            if tid in loaded and isinstance(spec, dict)
        }
        resumed = 0
        paused = 0
        for tid in self.order:
            task = self.tasks[tid]
            if task.status == "pending" and tid in self.specs:
                self.queue.put_nowait(tid)
                self._queued.add(tid)
                resumed += 1
            elif task.status == "paused":
                paused += 1
        if resumed:
            self.log(f"已恢复 {resumed} 个排队任务", "info")
        if paused:
            self.log(f"有 {paused} 个任务处于暂停状态，可在任务队列里点「全部开始」继续", "info")

    async def _ensure_workers(self) -> None:
        wanted = max(1, self.store.get().concurrency)
        alive = [w for w in self.workers if not w.done()]
        while len(alive) < wanted:
            alive.append(asyncio.create_task(self._worker(len(alive))))
        for extra in alive[wanted:]:
            extra.cancel()
        self.workers = alive[:wanted]

    async def apply_settings(self) -> None:
        """把最新配置应用到运行中的会话（代理变化时重建连接池）。"""
        settings = self.store.get()
        try:
            yt.write_cookies(self.store.dir, settings.youtube_cookies)
        except OSError as exc:
            self.log(f"YouTube Cookie 保存失败：{exc}", "warn")
        self.session.api_interval = settings.api_interval
        bili_proxy = settings.bili_proxy()
        if self.session.proxy != bili_proxy:
            cookies = dict(self.session.cookies)
            user = dict(self.session.user)
            await self.session.aclose()
            self.session = BiliSession(
                cookies, api_interval=settings.api_interval, proxy=bili_proxy
            )
            self.session.user = user
            self.log("代理设置已更新", "info")
        await self._ensure_workers()

    async def close(self) -> None:
        self._closed = True
        self._persist()
        for task in self.workers:
            task.cancel()
        for task in self.workers:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self.session.aclose()

    def log(self, message: str, kind: str = "info") -> None:
        self.events.append({"time": _now(), "kind": kind, "message": message})
        del self.events[:-200]

    # ------------------------------------------------------------------ 登录
    def status(self) -> dict[str, Any]:
        settings = self.store.get()
        user = dict(self.session.user)
        return {
            "logged_in": self.session.has_login() and bool(user.get("logged_in", True)),
            "has_cookie": self.session.has_login(),
            "user": user,
            "ffmpeg": self.ffmpeg_ok,
            "version": __import__("bilidl").__version__,
            "settings": settings.to_dict(),
            "quality_choices": list(QUALITY_CHOICES.keys()),
            "default_quality": DEFAULT_QUALITY,
            "concurrency": max(1, settings.concurrency),
            "tasks": self.snapshot(),
            "cooldown": max(0.0, self._cooldown_until - _now()),
            "paused_note": self._paused_note,
            "youtube": yt.status(),
        }

    async def login_cookie(self, text: str) -> dict[str, Any]:
        cookies = parse_cookie_text(text)
        if not cookies:
            raise ParseError("Cookie 为空或格式不正确，请粘贴形如 SESSDATA=xxx; bili_jct=yyy 的内容")
        if "SESSDATA" not in cookies:
            raise ParseError("Cookie 中缺少 SESSDATA，无法登录")
        # 先用临时会话验证，避免把无效 Cookie 写进内存与磁盘
        probe = BiliSession(
            cookies=cookies,
            api_interval=self.session.api_interval,
            proxy=self.session.proxy,
        )
        try:
            user = await probe.refresh_user()
        finally:
            await probe.aclose()
        if not user.get("logged_in"):
            raise AuthRequired("Cookie 无效或已过期，请重新获取")
        self.session.cookies.update(cookies)
        self.session.user = user
        self.session._buvid_ready = False  # noqa: SLF001
        self.store.save_cookie(self.session.export_cookie())
        self.log(f"已登录：{user.get('name') or user.get('mid')}", "ok")
        return user

    async def login_qr_start(self) -> dict[str, Any]:
        data = await api.qrcode_generate(self.session)
        if not data.get("url"):
            raise BiliError("二维码生成失败，请稍后重试")
        return {"url": data["url"], "key": data["qrcode_key"]}

    async def login_qr_poll(self, key: str) -> dict[str, Any]:
        result = await api.qrcode_poll(self.session, key)
        code = result.get("code")
        # 0=成功 86101=未扫码 86090=已扫码待确认 86038=已失效
        mapping = {
            0: "登录成功",
            86101: "等待扫码",
            86090: "已扫码，请在手机上确认",
            86038: "二维码已失效，请刷新",
        }
        result["status_text"] = mapping.get(code, result.get("message") or "")
        if code == 0:
            self.store.save_cookie(self.session.export_cookie())
            user = self.session.user or await self.session.refresh_user()
            self.log(f"扫码登录成功：{user.get('name') or user.get('mid')}", "ok")
            result["user"] = user
        return result

    async def logout(self) -> None:
        self.session.cookies.clear()
        self.session.user = {}
        self.store.save_cookie("")
        self.log("已退出登录", "info")

    # ------------------------------------------------------------------ 解析
    async def parse(self, text: str) -> list[dict[str, Any]]:
        """把一段文本里的链接展开成可选择的下载项。"""
        refs = await parse_links(text, self.session.client)
        items: list[dict[str, Any]] = []
        for ref in refs:
            try:
                item = await self._parse_ref(ref)
            except BiliError as exc:
                item = {
                    "ok": False,
                    "link": ref.url or ref.raw,
                    "kind": ref.kind,
                    "error": str(exc),
                    "note": ref.note,
                }
            items.append(item)
        return items

    async def _parse_ref(self, ref: LinkRef) -> dict[str, Any]:
        if ref.kind == "yt_video":
            return await self._parse_youtube_video(ref)
        if ref.kind in ("yt_channel", "yt_playlist"):
            return await self._parse_youtube_list(ref)
        if ref.kind == "video":
            info = await api.video_info(self.session, ref.ident)
            data = info.to_dict()
            # 合集信息：当前视频在合集里的序号（1 起），以及合集 id / 标题 / UP 主 UID
            order = 0
            for idx, ep in enumerate(info.season_episodes, start=1):
                if ep.bvid == info.bvid:
                    order = idx
                    break
            for page in data.get("pages") or []:
                page["season_id"] = info.season_id
                page["season_title"] = info.season_title
                page["season_order"] = order
                page["author_uid"] = info.mid
            data.update({"ok": True, "link": ref.url, "raw": ref.raw, "page_hint": ref.page})
            return data
        if ref.kind == "readlist":
            info = await api.readlist_detail(self.session, ref.ident)
            info.update({"ok": True, "kind": "readlist", "link": ref.url, "raw": ref.raw})
            return info
        if ref.kind == "videolist":
            info = await api.videolist_detail(self.session, ref.note or "", ref.ident)
            info.update({"ok": True, "kind": "videolist", "link": ref.url, "raw": ref.raw})
            return info
        if ref.kind in {"opus", "dynamic", "article"}:
            if ref.kind == "opus":
                info = await api.opus_detail(self.session, ref.ident)
            elif ref.kind == "dynamic":
                info = await api.dynamic_detail(self.session, ref.ident)
            else:
                info = await api.article_detail(self.session, ref.ident)
            data = info.to_dict()
            data.update({"ok": True, "link": ref.url, "raw": ref.raw})
            return data
        if ref.kind == "space":
            card = await api.user_card(self.session, ref.mid)
            return {
                "ok": True,
                "kind": "space",
                "link": ref.url,
                "raw": ref.raw,
                "mid": ref.mid,
                "tab": ref.space_tab,
                "user": card,
            }
        return {
            "ok": False,
            "kind": ref.kind,
            "link": ref.url,
            "raw": ref.raw,
            "error": ref.note or "暂不支持该类型的链接",
        }


    # ------------------------------------------------------------ YouTube 解析
    async def _parse_youtube_video(self, ref: LinkRef) -> dict[str, Any]:
        settings = self.store.get()
        info = await yt.video_info(settings, self.store.dir, ref.url)
        vid = str(info.get("id") or "")
        if not vid:
            raise ParseError("没有解析到 YouTube 视频 ID")
        page = {
            "index": 1,
            "cid": 0,
            "title": info["title"],
            "duration": info["duration"],
            "cover": info["thumb"],
            "bvid": vid,
        }
        langs = list(info.get("subtitles") or []) or list(info.get("automatic_captions") or [])
        note = "YouTube 视频，清晰度由设置里的清晰度决定"
        if info.get("live_status") == "is_live":
            note = "这场直播正在进行，下载会在你手动停止前一直持续"
        return {
            "ok": True,
            "kind": "video",
            "source": "youtube",
            "link": ref.url,
            "raw": ref.raw,
            "bvid": vid,
            "aid": 0,
            "title": info["title"],
            "author": info["uploader"],
            "mid": info["channel_id"],
            "cover": info["thumb"],
            "desc": info["description"],
            "pubdate": info["timestamp"],
            "duration": info["duration"],
            "pages": [page],
            "page_hint": 1,
            "web_url": info["webpage_url"],
            "subtitles": langs[:8],
            "note": note,
        }

    async def _parse_youtube_list(self, ref: LinkRef) -> dict[str, Any]:
        settings = self.store.get()
        url = youtube_channel_url(ref.ident) if ref.kind == "yt_channel" else ref.url
        data = await yt.list_entries(settings, self.store.dir, url, limit=60)
        works = [
            {
                "ident": entry["id"],
                "title": entry["title"],
                "cover": entry["thumb"],
                "duration": entry["duration"],
                "pubdate": 0,
                "source": "youtube",
            }
            for entry in data.get("entries") or []
            if entry.get("id")
        ]
        if not works:
            raise ParseError("这个频道/播放列表没有取到视频（可能是空的，或需要登录）")
        return {
            "ok": True,
            "kind": "videolist",
            "source": "youtube",
            "id": data.get("id") or ref.ident,
            "title": data.get("title") or ref.ident,
            # channel / playlist：频道页不当作播放列表（否则整批下载会落进「频道名字文件夹」）
            "list_kind": "playlist" if ref.kind == "yt_playlist" else "channel",
            "mid": data.get("channel_id") or "",
            "uploader": data.get("uploader") or "",
            "works": works,
            "link": ref.url,
            "raw": ref.raw,
            "note": (
                f"只列出最新 {len(works)} 个视频（共 {data.get('total') or len(works)} 个）；"
                "想整频道自动追更，请到「订阅追更」里添加这个链接"
            ),
        }

    # ------------------------------------------------------------------ 任务
    def _new_task(self, task: Task) -> Task:
        self.tasks[task.id] = task
        self.order.append(task.id)
        self._persist()
        return task

    @staticmethod
    def _is_youtube_target(target: dict[str, Any]) -> bool:
        source = str(target.get("source") or "").strip().lower()
        bvid = str(target.get("bvid") or target.get("vid") or "").strip()
        return source == "youtube" or bvid.startswith("yt:")

    async def add_video_targets(self, targets: list[dict[str, Any]]) -> list[str]:
        """按明确的分P/分集目标创建下载任务。"""
        ids: list[str] = []
        yt_targets = [t for t in targets if self._is_youtube_target(t)]
        if yt_targets:
            ids.extend(await self.add_youtube_targets(yt_targets))
            targets = [t for t in targets if not self._is_youtube_target(t)]
        seen = {self.specs[tid].get("key") for tid in self.order if self.tasks[tid].status in ("pending", "running", "paused")}
        for target in targets:
            bvid = str(target.get("bvid") or "").strip()
            cid = int(target.get("cid") or 0)
            if bvid and not cid:
                # 只给了 BV 号（例如从视频合集整段选中的）：补一次详情拿 cid / 合集信息
                info = await api.video_info(self.session, bvid)
                first = info.pages[0] if info.pages else None
                cid = int(first.cid) if first else 0
                target = {
                    **target,
                    "video_title": target.get("video_title") or info.title,
                    "author": target.get("author") or info.author,
                    "pubdate": target.get("pubdate") or info.pubdate,
                    "author_uid": target.get("author_uid") or info.mid,
                    "season_id": target.get("season_id") or info.season_id,
                    "season_title": target.get("season_title") or info.season_title,
                    "season_order": target.get("season_order") or next(
                        (i for i, ep in enumerate(info.season_episodes, start=1) if ep.bvid == info.bvid), 0
                    ),
                }
            page_index = int(target.get("page_index") or 1)
            if not bvid or not cid:
                continue
            key = f"{bvid}:{cid}"
            if key in seen:
                continue
            seen.add(key)
            title = str(target.get("video_title") or bvid)
            page_title = str(target.get("page_title") or "")
            subtitle = f"P{page_index}" + (f" {page_title}" if page_title else "")
            task = self._new_task(
                Task(
                    id=uuid.uuid4().hex[:12],
                    kind="video",
                    title=title,
                    subtitle=subtitle,
                    ident=bvid,
                )
            )
            self.specs[task.id] = {
                "key": key,
                "kind": "video",
                "bvid": bvid,
                "cid": cid,
                "page_index": page_index,
                "page_title": page_title,
                "video_title": title,
                "author": str(target.get("author") or ""),
                "pubdate": int(target.get("pubdate") or 0),
                "dir": str(target.get("dir") or ""),
                "season_id": str(target.get("season_id") or ""),
                "season_title": str(target.get("season_title") or ""),
                "season_order": int(target.get("season_order") or 0),
                "author_uid": str(target.get("author_uid") or ""),
                "template": str(target.get("template") or "").strip(),
                "sub_id": str(target.get("sub_id") or ""),
            }
            await self.queue.put(task.id)
            self._queued.add(task.id)
            ids.append(task.id)
        return ids

    async def add_video_idents(
        self,
        idents: list[str],
        *,
        all_pages: bool = True,
        directory: str = "",
        template: str = "",
        sub_id: str = "",
    ) -> dict[str, Any]:
        """按 BV/av 号批量建任务（用于 UP 主批量下载，自动补齐 cid）。"""
        task_ids: list[str] = []
        failed: list[dict[str, str]] = []
        for ident in idents:
            ident = str(ident or "").strip()
            if not ident:
                continue
            # YouTube 的 ident 用 "yt:" 前缀区分（B 站 BV 号不会这么开头）
            if ident.lower().startswith("yt:"):
                task_ids.extend(
                    await self.add_youtube_targets(
                        [
                            {
                                "vid": ident[3:],
                                "dir": directory,
                                "template": template,
                                "sub_id": sub_id,
                            }
                        ]
                    )
                )
                continue
            try:
                info = await api.video_info(self.session, ident)
            except BiliError as exc:
                failed.append({"ident": ident, "error": str(exc)})
                continue
            pages = info.pages if all_pages else info.pages[:1]
            targets = [
                {
                    "bvid": info.bvid,
                    "cid": page.cid,
                    "page_index": page.index,
                    "page_title": page.title,
                    "video_title": info.title,
                    "author": info.author,
                    "pubdate": info.pubdate,
                    "dir": directory,
                    "template": template,
                    "sub_id": sub_id,
                }
                for page in pages
            ]
            task_ids.extend(await self.add_video_targets(targets))
        return {"tasks": task_ids, "failed": failed, "count": len(task_ids)}

    async def add_opus_targets(self, targets: list[dict[str, Any]]) -> list[str]:
        ids: list[str] = []
        seen = {self.specs[tid].get("key") for tid in self.order if self.tasks[tid].status in ("pending", "running", "paused")}
        for target in targets:
            oid = str(target.get("oid") or target.get("opus_id") or "").strip()
            kind = str(target.get("sub_kind") or "opus")
            # 只接受纯数字 id，避免脏数据生成必然失败的任务
            if not oid or not oid.isdigit():
                continue
            key = f"{kind}:{oid}"
            if key in seen:
                continue
            seen.add(key)
            task = self._new_task(
                Task(
                    id=uuid.uuid4().hex[:12],
                    kind="opus",
                    title=str(target.get("title") or oid),
                    subtitle="图文作品",
                    ident=oid,
                )
            )
            self.specs[task.id] = {
                "key": key,
                "kind": "opus",
                "oid": oid,
                "sub_kind": kind,
                "dir": str(target.get("dir") or ""),
                "title": str(target.get("title") or ""),
                "template": str(target.get("template") or "").strip(),
                "readlist": target.get("readlist") or {},
                "sub_id": str(target.get("sub_id") or ""),
            }
            await self.queue.put(task.id)
            self._queued.add(task.id)
            ids.append(task.id)
        return ids

    # -------------------------------------------------- 队列控制（单个/多选/全部）

    async def add_youtube_targets(self, targets: list[dict[str, Any]]) -> list[str]:
        """按视频 ID 建 YouTube 下载任务（前端/订阅/油猴都走这里）。"""
        ids: list[str] = []
        seen = {
            self.specs[tid].get("key")
            for tid in self.order
            if self.tasks[tid].status in ("pending", "running", "paused")
        }
        for target in targets:
            vid = str(target.get("vid") or target.get("bvid") or "").strip()
            if vid.startswith("yt:"):
                vid = vid[3:]
            if not re.fullmatch(r"[0-9A-Za-z_-]{11}", vid):
                continue
            key = f"youtube:{vid}"
            if key in seen:
                continue
            seen.add(key)
            title = str(target.get("video_title") or target.get("title") or vid).strip() or vid
            author = str(target.get("author") or target.get("uploader") or "").strip()
            web_url = str(target.get("web_url") or target.get("url") or "").strip() or (
                f"https://www.youtube.com/watch?v={vid}"
            )
            _season_id = str(target.get("season_id") or "").strip()
            task = self._new_task(
                Task(
                    id=uuid.uuid4().hex[:12],
                    kind="youtube",
                    title=title,
                    subtitle=f"YouTube · {author}" if author else "YouTube",
                    ident=vid,
                )
            )
            self.specs[task.id] = {
                "key": key,
                "kind": "youtube",
                "vid": vid,
                "url": web_url,
                "web_url": web_url,
                "video_title": title,
                "author": author,
                "author_uid": str(target.get("author_uid") or target.get("channel_id") or ""),
                "pubdate": int(target.get("pubdate") or 0),
                "duration": int(target.get("duration") or 0),
                "page_index": 1,
                "page_title": str(target.get("video_title") or target.get("page_title") or title),
                "cover": str(target.get("cover") or ""),
                "desc": str(target.get("desc") or ""),
                "season_id": _season_id,
                # 只有真的属于某个合集/播放列表时才有名称，否则保持空：
                # 客户端（尤其旧版油猴）会把「当前页面标题」当 season_title 传上来，
                # 那会让 <videolist_title>/ 把多选的其它视频全塞进一个以页面标题命名的文件夹。
                "season_title": (_season_id and str(target.get("season_title") or "")) or "",
                "season_order": int(target.get("season_order") or 0) if _season_id else 0,
                "dir": str(target.get("dir") or ""),
                "template": str(target.get("template") or "").strip(),
                "sub_id": str(target.get("sub_id") or ""),
            }
            await self.queue.put(task.id)
            self._queued.add(task.id)
            ids.append(task.id)
        return ids

    def _pick(self, ids: Any = None, all_: bool = False) -> list[str]:
        """把「单个 id / id 列表 / 全部」统一成队列里真实存在的任务 id。"""
        if all_:
            return [tid for tid in self.order if tid in self.tasks]
        if isinstance(ids, str):
            ids = [ids]
        picked: list[str] = []
        for tid in ids or []:
            tid = str(tid)
            if tid in self.tasks and tid not in picked:
                picked.append(tid)
        return picked

    def pause(self, ids: Any = None, all_: bool = False) -> int:
        """暂停任务（支持单个 / 多选 / 全部）。

        * 排队中的：状态直接改成 paused，worker 取到后会跳过；
        * 下载中的：只打暂停标记，worker 在下一个分片检查点停下再置为 paused。
          已经写入的 .part 会被丢弃，恢复后从头发起（B站 CDN 分段不保证稳定）。
        """
        targets = [
            tid for tid in self._pick(ids, all_) if self.tasks[tid].status in ("pending", "running")
        ]
        for tid in targets:
            task = self.tasks[tid]
            if task.status == "running":
                self.pause_flags.add(tid)  # 状态等 worker 真正停下后再改，避免「假装已暂停」
            else:
                task.status = "paused"
                task.error = "已暂停"
                self.cancel_flags.discard(tid)
            task.speed = 0.0
        if targets:
            self._persist()
            self.log(f"已暂停 {len(targets)} 个任务", "warn")
        return len(targets)

    def resume(self, ids: Any = None, all_: bool = False) -> int:
        """继续已暂停的任务（支持单个 / 多选 / 全部）：重新排队并从 0 开始。"""
        targets = [tid for tid in self._pick(ids, all_) if self.tasks[tid].status == "paused"]
        for tid in targets:
            task = self.tasks[tid]
            task.status = "pending"
            task.error = ""
            task.progress = 0.0
            task.speed = 0.0
            task.done_bytes = 0
            task.done_items = 0
            self.pause_flags.discard(tid)
            self.cancel_flags.discard(tid)
            # 暂停时没有清 asyncio.Queue，原来那条 id 可能还在；_queued 去重避免同一任务跑两遍
            if tid in self.specs and tid not in self._queued and tid not in self._active:
                self.queue.put_nowait(tid)
                self._queued.add(tid)
        if targets:
            self._persist()
            self.log(f"已继续 {len(targets)} 个任务", "info")
        return len(targets)

    def cancel(self, task_id: str) -> None:
        self.cancel_many([task_id])

    def cancel_many(self, ids: Any = None) -> int:
        """取消任务（支持单个 / 多选）：排队与暂停的直接标成 canceled，
        正在下载的打 cancel 标记，worker 在下一个检查点退出。"""
        targets = [
            tid for tid in self._pick(ids)
            if self.tasks[tid].status in ("pending", "running", "paused")
        ]
        for tid in targets:
            task = self.tasks[tid]
            self.pause_flags.discard(tid)
            if task.status == "running":
                self.cancel_flags.add(tid)
            else:
                task.status = "canceled"
                task.error = "已取消"
                task.speed = 0.0
                self.cancel_flags.discard(tid)
        if targets:
            self._persist()
            self.log(f"已取消 {len(targets)} 个任务", "warn")
        return len(targets)

    def cancel_all(self) -> int:
        """取消所有任务并把它们**从队列里删掉**（不是留一堆 canceled 占位）。

        * 排队中的：直接从 self.queue 丢弃；
        * 正在下载的：先打 cancel 标记让 worker 在下一个检查点退出，再把任务条目删掉
          （worker 手里还拿着 Task 对象，退出后只会写那个孤立对象，不影响列表）。
        """
        removed = list(self.order)
        if not removed:
            self._paused_note = ""
            return 0
        for tid in removed:
            task = self.tasks.get(tid)
            if task and task.status in ("pending", "running"):
                self.cancel_flags.add(tid)
        # 丢掉还没被 worker 取走的排队项
        while True:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            else:
                self.queue.task_done()
        self._queued.clear()
        for tid in removed:
            self.specs.pop(tid, None)
            self.tasks.pop(tid, None)
        self.order.clear()
        # 只保留仍在 worker 手里的任务的取消标记，避免 cancel_flags 越积越多
        self.cancel_flags.intersection_update(self._active)
        self.pause_flags.clear()
        self._paused_note = ""
        self._persist()
        self.log(f"已取消并移除 {len(removed)} 个任务", "warn")
        return len(removed)

    def clear_finished(self) -> None:
        # 注意：失败（error）的任务不清理，留着给「重试失败」用；暂停的任务也不清理
        before = len(self.order)
        for tid in list(self.order):
            if self.tasks[tid].status in ("done", "skipped", "canceled"):
                self.specs.pop(tid, None)
                self.tasks.pop(tid, None)
                self.order.remove(tid)
                self.cancel_flags.discard(tid)
                self.pause_flags.discard(tid)
                self._queued.discard(tid)
        if len(self.order) != before:
            self._persist()

    def retry_failed(self, task_id: str = "") -> int:
        """把失败的任务重新排队（保留原 spec，进度归零）。传 task_id 只重试那一个。"""
        n = 0
        targets = [task_id] if task_id else list(self.order)
        for tid in targets:
            task = self.tasks.get(tid)
            if not task or task.status != "error":
                continue
            if tid not in self.specs:
                continue
            task.status = "pending"
            task.progress = 0.0
            task.done_items = 0
            task.done_bytes = 0
            task.error = ""
            task.speed = 0.0
            self.cancel_flags.discard(tid)
            self.pause_flags.discard(tid)
            if tid not in self._queued:
                self.queue.put_nowait(tid)
                self._queued.add(tid)
            n += 1
        if n:
            self._persist()
            self.log(f"重新排队 {n} 个失败任务", "info")
        return n

    def snapshot(self) -> dict[str, Any]:
        tasks = [self.tasks[tid].to_dict() for tid in self.order if tid in self.tasks]
        stats = {"pending": 0, "running": 0, "paused": 0, "done": 0, "skipped": 0, "error": 0, "canceled": 0}
        for task in tasks:
            stats[task["status"]] = stats.get(task["status"], 0) + 1
        return {
            "tasks": tasks,
            "stats": stats,
            "cooldown": max(0.0, self._cooldown_until - _now()),
            "paused_note": self._paused_note,
            "youtube": yt.status(),
            "events": self.events[-40:],
        }

    # ------------------------------------------------------------------ 工作线程
    def _take(self, task_id: str) -> bool:
        """worker 从队列拿到 id 后判断要不要真的执行。

        暂停 / 取消的任务可能还挂在 asyncio.Queue 里（暂停时不清队列），
        恢复动作也可能让同一个 id 出现两次，所以只执行真正的 pending 任务。
        """
        task = self.tasks.get(task_id)
        return bool(task and task.status == "pending" and task_id not in self._active)

    async def _worker(self, index: int) -> None:
        while not self._closed:
            task_id = await self.queue.get()
            self._queued.discard(task_id)
            try:
                if not self._take(task_id):
                    continue
                await self._handle(task_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 兜底，避免线程退出
                task = self.tasks.get(task_id)
                if task:
                    task.status = "error"
                    task.error = f"内部错误：{exc}"
            finally:
                self.queue.task_done()

    async def _wait_cooldown(self) -> None:
        delay = self._cooldown_until - _now()
        if delay > 0:
            await asyncio.sleep(min(delay, 120))

    async def _handle(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        spec = self.specs.get(task_id)
        if not task or not spec:
            return
        self._active.add(task_id)
        try:
            await self._run_task(task_id, task, spec)
        finally:
            self._active.discard(task_id)

    def _should_stop(self, task: Task) -> bool:
        """下载分片循环里的检查点：取消或暂停都要立刻停下。"""
        return task.id in self.cancel_flags or task.id in self.pause_flags

    def _stop_reason(self, task_id: str) -> str:
        """任务该不该停：cancel / pause / ""（继续）。"""
        task = self.tasks.get(task_id)
        if not task or task_id in self.cancel_flags:
            return "cancel"
        if task_id in self.pause_flags or task.status == "paused":
            return "pause"
        return ""

    def _mark_stopped(self, task: Task, reason: str) -> None:
        if reason == "pause":
            task.status = "paused"
            task.error = "已暂停"
        elif reason == "cancel":
            task.status = "canceled"
            task.error = "已取消"
        task.speed = 0.0

    async def _run_task(self, task_id: str, task: Task, spec: dict[str, Any]) -> None:
        reason = self._stop_reason(task_id)
        if reason:
            self._mark_stopped(task, reason)
            return

        # 任务之间保持间隔，避免短时间大量请求。
        # 图文任务要拉详情接口 + 逐张下载，比视频更容易触发风控，所以单独加长间隔并做批间歇。
        async with self._gate:
            settings = self.store.get()
            base = settings.file_interval
            if spec["kind"] not in ("video", "youtube"):
                base = max(base, 2.6)
            gap = base - (_now() - self._last_start)
            if gap > 0:
                await asyncio.sleep(gap + random.uniform(0.4, 1.8))
            self._last_start = _now()
            if spec["kind"] not in ("video", "youtube"):
                self._opus_streak = getattr(self, "_opus_streak", 0) + 1
                if self._opus_streak >= 8:
                    self._opus_streak = 0
                    rest = random.uniform(25, 45)
                    self.log(f"图文已连下 8 个，休息 {rest:.0f} 秒避免触发风控", "info")
                    await asyncio.sleep(rest)

        await self._wait_cooldown()
        # 排队 / 等冷却期间可能被「取消 / 暂停」：那就不要再开始下载
        reason = self._stop_reason(task_id)
        if reason:
            self._mark_stopped(task, reason)
            return
        task.status = "running"
        task.started = _now()
        self._persist()
        try:
            if spec["kind"] == "video":
                await self._download_video(task, spec)
                if task.status != "skipped":
                    task.done_items = max(task.done_items, 1)
            elif spec["kind"] == "youtube":
                await self._download_youtube(task, spec)
                if task.status != "skipped":
                    task.done_items = max(task.done_items, 1)
            else:
                await self._download_opus(task, spec)
            reason = self._stop_reason(task_id)
            if reason:
                self._mark_stopped(task, reason)
            elif task.status != "skipped":
                task.status = "done"
                task.progress = 1.0
            self._risk_streak = 0
        except RiskControl as exc:
            task.status = "error"
            task.error = str(exc)
            self._risk_streak += 1
            self._cooldown_until = _now() + RISK_BACKOFF[min(self._risk_streak - 1, len(RISK_BACKOFF) - 1)]
            self.log(f"命中风控，暂停 {int(self._cooldown_until - _now())} 秒后再继续：{exc}", "warn")
            if self._risk_streak >= 3:
                self._paused_note = "连续触发风控，已自动暂停队列。请稍后再试或更换网络/登录账号。"
                for other in self.tasks.values():
                    if other.status == "pending":
                        other.status = "canceled"
                        other.error = self._paused_note
                self.log(self._paused_note, "error")
        except asyncio.CancelledError:
            task.status = "canceled"
            raise
        except (AuthRequired, DownloadError, NotFound, BiliError) as exc:
            # 「取消全部」把任务删掉后、或「暂停」打断了下载，都会让 worker 以异常退出：
            # 这属于预期，不该记成失败、也不该在日志里报红。
            reason = self._stop_reason(task_id)
            if reason:
                self._mark_stopped(task, reason)
                return
            task.status = "error"
            task.error = str(exc)
            self.log(f"{task.title} 下载失败：{exc}", "error")
        except Exception as exc:  # noqa: BLE001
            task.status = "error"
            import os as _os
            import traceback as _tb
            if _os.environ.get("BILIDL_TRACEBACK"):
                task.error = f"未知错误：{exc}\n" + _tb.format_exc()
            else:
                task.error = f"未知错误：{exc}"
            self.log(f"{task.title} 下载异常：{exc}", "error")
        finally:
            task.finished = _now()
            self.cancel_flags.discard(task_id)
            self.pause_flags.discard(task_id)
            if task.files and self.on_files_saved and spec.get("sub_id"):
                try:
                    self.on_files_saved(spec, task.files)
                except Exception as exc:  # noqa: BLE001
                    self.log(f"记录下载文件清单失败：{exc}", "warn")
            self._persist()

    def _note_file(
        self, task: Task, path: Path, mapping: dict[str, str], root: Path, tpl: str = ""
    ) -> None:
        """记住文件对应的命名变量与落盘时用的规则，订阅改规则后据此回算新文件名。"""
        task.files.append(
            {
                "path": str(path),
                "root": str(root),
                "tpl": str(tpl or ""),
                "vars": {str(k): str(v) for k, v in mapping.items()},
            }
        )


    # ------------------------------------------------------------------ 视频
    def _video_dir(self, spec: dict[str, Any] | None = None) -> Path:
        custom = str((spec or {}).get("dir") or "").strip()
        path = Path(custom) if custom else Path(self.store.get().video_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _opus_dir(self, spec: dict[str, Any] | None = None) -> Path:
        custom = str((spec or {}).get("dir") or "").strip()
        path = Path(custom) if custom else Path(self.store.get().opus_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def _download_video(self, task: Task, spec: dict[str, Any]) -> None:
        settings = self.store.get()
        bvid = spec["bvid"]
        cid = spec["cid"]
        streams = await api.play_streams(
            self.session, bvid, cid, settings.quality, ffmpeg_ok=self.ffmpeg_ok
        )
        task.quality = streams["quality_label"]
        mapping = {
            "video_title": spec["video_title"],
            "video_id": bvid,
            "video_episode": str(spec["page_index"]),
            "video_page_title": spec["page_title"] or spec["video_title"],
            "video_author": spec.get("author", ""),
            "video_quality": streams["quality_label"],
            "video_date": _date(int(spec.get("pubdate") or 0)),
            "video_author_uid": str(spec.get("author_uid") or ""),
            # 不在合集里时这三个是空串，naming 会把整段连同分隔符一起忽略
            "videolist_title": str(spec.get("season_title") or ""),
            "videolist_order": str(spec.get("season_order") or ""),
            "videolist_id": str(spec.get("season_id") or ""),
        }
        directory = self._video_dir(spec)
        video_template = str(spec.get("template") or settings.video_template)
        extras = settings.extras or {}
        audio_only = bool(extras.get("audio_only"))
        video_only = bool(extras.get("video_only"))
        audio_format = str(getattr(settings, "audio_format", "m4a") or "m4a").lower()
        if audio_format not in ("m4a", "mp3"):
            audio_format = "m4a"
        referer = f"https://www.bilibili.com/video/{bvid}"
        # 「纯音频」「无声视频」可以同时勾选 —— 每个勾选项各下一份文件；
        # 附加文件（字幕/弹幕/封面/NFO）不管勾了哪几个主文件类型都会一起产出。
        if audio_only or video_only:
            targets = []
            if audio_only:
                # m4a：原 AAC 音轨重封装；mp3：转码 192k，给不认 AAC 的播放器/车机/电视用
                targets.append(("audio", "mp3" if audio_format == "mp3" else "m4a",
                                streams.get("dash_audio_urls") or [], ""))
            if video_only:
                targets.append(("mute", "mp4", streams.get("dash_video_urls") or streams["video_urls"], "-mute"))
            saved = []
            for tag, ext, urls, suffix in targets:
                label = "纯音频" if tag == "audio" else "无声视频"
                m = dict(mapping)
                m["video_quality"] = f"{label} {streams['quality_label']}"
                rel = build_relative(video_template, m, ext)
                if suffix:
                    rel = rel.with_name(f"{rel.stem}{suffix}{rel.suffix}")
                if not urls:
                    self.log(f"该视频没有可用的{label}流（可能需要登录或会员），跳过", "warn")
                    continue
                if tag == "audio":
                    codec = str(streams.get("audio_codec") or "")
                    if codec and not codec.lower().startswith("mp4a"):
                        self.log(f"音轨编码是 {codec}（不是 AAC），部分播放器可能没有声音", "warn")
                if settings.skip_existing and (directory / rel).exists():
                    self.log(f"已存在，跳过：{rel.name}", "info")
                    saved.append(directory / rel)
                    self._note_file(task, directory / rel, m, directory, video_template)
                    continue
                dest = unique_path(directory / rel.parent, rel.name)
                dest.parent.mkdir(parents=True, exist_ok=True)
                # 转 MP3 时先把 B站 原始音轨下到临时名，转完再改名，避免留下「假 mp3」
                raw = dest.with_name(f"{dest.stem}.raw.m4a") if (tag == "audio" and ext == "mp3") else dest
                await self._fetch_stream(task, urls, raw, referer, 0.0, 0.92)
                if tag == "audio":
                    dest = await self._finalize_audio(raw, dest, ext, spec)
                task.path = str(dest)
                self.log(f"已保存：{dest.name}（{label}）", "ok")
                self._note_file(task, dest, m, directory, video_template)
                saved.append(dest)
            if not saved:
                raise BiliError("该视频没有可用的纯音频/无声视频流（可能需要登录或会员）")
            task.path = str(saved[-1])
            # 附加文件只按视频写一份，别每个主文件类型都写一次（否则封面会出现 xx-1.jpg）
            await self._write_extra_files(task, spec, settings, streams, saved[0], referer, video_template)
            return

        # 正常有声视频：先算出目标文件名（带重命名规则 / 子目录）
        rel = build_relative(video_template, mapping, "mp4")
        base = directory / rel
        if settings.skip_existing and base.exists():
            # 按规则算出来的名字已存在就算「下过」，不要再生成 -1 副本
            task.status = "skipped"
            task.path = str(base)
            task.subtitle = f"{task.subtitle} · 已存在，跳过"
            self.log(f"已存在，跳过：{rel.name}", "info")
            self._note_file(task, base, mapping, directory, video_template)
            return
        dest = unique_path(directory / rel.parent, rel.name)
        dest.parent.mkdir(parents=True, exist_ok=True)

        if streams["mode"] == "progressive":
            await self._fetch_stream(task, streams["video_urls"], dest, referer, 0.0, 0.92)
            task.path = str(dest)
            self.log(f"已保存：{dest.name}（{streams['quality_label']}）", "ok")
            self._note_file(task, dest, mapping, directory, video_template)
            await self._write_extra_files(task, spec, settings, streams, dest, referer, video_template)
            return

        tmp_dir = self.store.dir / "tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        video_tmp = tmp_dir / f"{task.id}.m4v"
        audio_tmp = tmp_dir / f"{task.id}.m4a"
        try:
            await self._fetch_stream(task, streams["video_urls"], video_tmp, referer, 0.0, 0.78)
            if self._should_stop(task):
                raise DownloadError("已取消")
            await self._fetch_stream(task, streams["audio_urls"], audio_tmp, referer, 0.78, 0.9)
            if self._should_stop(task):
                raise DownloadError("已取消")
            task.subtitle = f"{task.subtitle} · 合并中"
            partial = dest.with_suffix(".part.mp4")
            await ffmpeg.merge(video_tmp, audio_tmp, partial)
            if dest.exists():
                dest.unlink()
            partial.rename(dest)
            task.path = str(dest)
            self.log(f"已保存：{dest.name}（{streams['quality_label']}）", "ok")
            self._note_file(task, dest, mapping, directory, video_template)
        finally:
            for path in (video_tmp, audio_tmp):
                with contextlib.suppress(OSError):
                    if path.exists():
                        path.unlink()
        await self._write_extra_files(task, spec, settings, streams, dest, referer, video_template)

    async def _normalize_audio(self, dest: Path) -> None:
        """把 DASH 分片音轨重封装成标准 m4a（不转码）。

        纯音频是原样落盘的 fragmented MP4，部分播放器 / 电视 / 媒体库认不出
        这种音轨，表现就是「文件在、时长也对，但没有声音」。重封装失败时
        保留原文件，不把整个任务判失败。
        """
        if not self.ffmpeg_ok:
            return
        tmp = dest.with_name(f"{dest.stem}.remux{dest.suffix}")
        try:
            await ffmpeg.remux(dest, tmp)
            tmp.replace(dest)
        except (DownloadError, OSError) as exc:
            self.log(f"音轨重封装失败，保留原始文件：{exc}", "warn")
        finally:
            with contextlib.suppress(OSError):
                if tmp.exists():
                    tmp.unlink()

    async def _finalize_audio(self, raw: Path, dest: Path, ext: str, spec: dict[str, Any]) -> Path:
        """纯音频收尾：m4a 重封装；mp3 转码（失败则自动退回 m4a）。"""
        if ext == "mp3":
            meta = {
                "title": str(spec.get("video_title") or dest.stem),
                "artist": str(spec.get("author") or ""),
                "album": str(spec.get("season_title") or ""),
                "comment": str(
                    spec.get("web_url") or f"https://www.bilibili.com/video/{spec.get('bvid') or ''}"
                ),
            }
            try:
                await ffmpeg.transcode_audio(raw, dest, meta=meta)
                return dest
            except (DownloadError, OSError) as exc:
                with contextlib.suppress(OSError):
                    if dest.exists():  # ffmpeg 失败时可能留下半个 mp3
                        dest.unlink()
                fallback = unique_path(dest.parent, f"{dest.stem}.m4a")
                self.log(f"MP3 转码失败，改存 m4a：{exc}", "warn")
                with contextlib.suppress(OSError):
                    raw.replace(fallback)
                    await self._normalize_audio(fallback)
                    return fallback
                raise
            finally:
                with contextlib.suppress(OSError):
                    if raw != dest and raw.exists():
                        raw.unlink()
        if raw != dest:
            raw.replace(dest)
        await self._normalize_audio(dest)
        return dest


    # ------------------------------------------------------------ YouTube
    async def _download_youtube(self, task: Task, spec: dict[str, Any]) -> None:
        settings = self.store.get()
        if not yt.available():
            raise DownloadError("服务端缺少 yt-dlp 依赖，无法下载 YouTube 视频")
        vid = str(spec.get("vid") or "")
        url = str(spec.get("web_url") or spec.get("url") or f"https://www.youtube.com/watch?v={vid}")
        quality = yt.quality_label(settings.quality)
        task.quality = quality
        extras = settings.extras or {}
        audio_only = bool(extras.get("audio_only"))
        video_only = bool(extras.get("video_only"))
        audio_format = str(getattr(settings, "audio_format", "m4a") or "m4a").lower()
        if audio_format not in ("m4a", "mp3"):
            audio_format = "m4a"
        template = str(spec.get("template") or settings.video_template)
        directory = self._video_dir(spec)
        author = str(spec.get("author") or "")
        channel_id = str(spec.get("author_uid") or "")
        cover = str(spec.get("cover") or f"https://i.ytimg.com/vi/{vid}/maxresdefault.jpg")
        list_title = str(spec.get("season_title") or "")
        list_order = str(spec.get("season_order") or "")
        list_id = str(spec.get("season_id") or "")
        mapping = {
            # 与 B 站保持同一套变量名，老模板直接可用
            "video_title": spec["video_title"],
            "video_id": vid,
            "video_episode": "1",
            "video_page_title": spec.get("page_title") or spec["video_title"],
            "video_author": author,
            "video_quality": quality,
            "video_date": _date(int(spec.get("pubdate") or 0)),
            "video_author_uid": channel_id,
            "videolist_title": list_title,
            "videolist_order": list_order,
            "videolist_id": list_id,
            # YouTube 专属别名（取值与上面一致）
            "youtube_id": vid,
            "youtube_channel": author,
            "youtube_channel_id": channel_id,
            "youtube_list_title": list_title,
            "youtube_list_order": list_order,
            "youtube_list_id": list_id,
        }
        if video_only:
            mapping["video_quality"] = f"无声视频 {quality}"
        elif audio_only:
            mapping["video_quality"] = f"纯音频 {quality}"

        def final_rel(ext: str) -> Path:
            rel = build_relative(template, mapping, ext)
            if video_only:
                rel = rel.with_name(f"{rel.stem}-mute{rel.suffix}")
            return rel

        if settings.skip_existing:
            for ext in yt.ext_candidates(audio_only=audio_only, audio_format=audio_format):
                cand = directory / final_rel(ext)
                if cand.exists():
                    task.status = "skipped"
                    task.path = str(cand)
                    task.progress = 1.0
                    self._note_file(task, cand, mapping, directory, template)
                    self.log(f"已存在，跳过：{cand.name}", "info")
                    return

        tmp = Path(self.store.dir) / "tmp" / f"yt-{task.id}"
        fmt = yt.format_selector(quality, audio_only=audio_only, video_only=video_only)
        task.speed = 0.0

        def progress(done: int, total: int, speed: float) -> None:
            if total > 0:
                task.progress = min(0.9, 0.02 + 0.88 * min(1.0, done / total))
                task.total_bytes = total
            task.done_bytes = done
            task.speed = speed

        try:
            result = await yt.download(
                settings,
                self.store.dir,
                url,
                fmt=fmt,
                tmp_dir=tmp,
                progress=progress,
                should_stop=lambda: self._should_stop(task),
                subtitles=bool(extras.get("subtitle")),
                fallbacks=yt.format_chain(quality)[1:],
            )
            if result.get("fallback"):
                self.task_note(task, "目标清晰度下没有可用的音视频组合，已自动退回能下载的最好格式")
            raw = Path(str(result.get("media") or ""))
            if not raw.is_file():
                raise DownloadError("YouTube 没有产出可用的视频文件（可能只有直播/会员内容）")
            raw_ext = raw.suffix.lstrip(".").lower()
            if audio_only:
                want = "mp3" if audio_format == "mp3" else "m4a"
                if raw_ext in ("m4a", "mp4", "m4b"):
                    out_ext = want
                elif want == "mp3" and self.ffmpeg_ok:
                    out_ext = "mp3"
                else:
                    # opus/webm 音轨：m4a 容器装不下，保留原扩展名，别给假 m4a
                    out_ext = raw_ext or "m4a"
                    self.task_note(task, f"该视频只有 {raw_ext or '未知'} 音轨，已按原格式保存")
                rel = final_rel(out_ext)
                dest = unique_path(directory / rel.parent, rel.name)
                dest.parent.mkdir(parents=True, exist_ok=True)
                if out_ext == raw_ext:
                    shutil.move(str(raw), str(dest))
                else:
                    dest = await self._finalize_audio(
                        raw, dest, out_ext, {**spec, "web_url": url, "bvid": vid}
                    )
            else:
                out_ext = raw_ext if raw_ext in ("mp4", "mkv", "webm") else "mp4"
                rel = final_rel(out_ext)
                dest = unique_path(directory / rel.parent, rel.name)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(raw), str(dest))
            await self._youtube_extras(
                task,
                spec,
                settings,
                mapping,
                dest,
                template,
                result.get("subs") or [],
                cover,
            )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        task.path = str(dest)
        size = dest.stat().st_size if dest.exists() else 0
        task.total_bytes = max(task.total_bytes, size)
        task.done_bytes = max(task.done_bytes, size)
        task.progress = 1.0
        self._note_file(task, dest, mapping, directory, template)
        self.log(f"YouTube 下载完成：{dest.name}", "ok")

    async def _youtube_extras(
        self,
        task: Task,
        spec: dict[str, Any],
        settings: Any,
        mapping: dict[str, str],
        dest: Path,
        template: str,
        subs: list[dict[str, str]],
        cover: str,
    ) -> None:
        """YouTube 的附加文件：字幕（VTT→SRT）、封面、NFO。"""
        extras = settings.extras or {}
        wanted = [key for key in ("subtitle", "cover", "nfo") if extras.get(key)]
        if not wanted:
            return
        directory = self._video_dir(spec)

        def target(ext: str, suffix: str = "") -> Path:
            rel = build_relative(template, mapping, ext)
            if suffix:
                rel = rel.with_name(f"{rel.stem}-{suffix}{rel.suffix}")
            out = unique_path(directory / rel.parent, rel.name)
            out.parent.mkdir(parents=True, exist_ok=True)
            return out

        if "cover" in wanted and cover:
            with contextlib.suppress(Exception):
                data = await self.session.get_bytes(cover, referer="https://www.youtube.com/")
                out = target("jpg")
                out.write_bytes(data)
                self.log(f"封面已保存：{out.name}", "ok")

        if "nfo" in wanted:
            with contextlib.suppress(Exception):
                text = yt.build_nfo(
                    {
                        "id": spec.get("vid"),
                        "title": spec.get("video_title"),
                        "description": spec.get("desc"),
                        "uploader": spec.get("author"),
                        "channel_id": spec.get("author_uid"),
                        "thumb": cover,
                        "timestamp": spec.get("pubdate"),
                        "duration": spec.get("duration"),
                        "webpage_url": spec.get("web_url"),
                    }
                )
                out = target("nfo")
                out.write_text(text, encoding="utf-8")
                self.log(f"NFO 已保存：{out.name}", "ok")

        if "subtitle" in wanted:
            saved = 0
            multi = len(subs) > 1
            for item in subs:
                path = Path(str(item.get("path") or ""))
                if not path.is_file():
                    continue
                with contextlib.suppress(OSError, UnicodeDecodeError):
                    text = path.read_text(encoding="utf-8", errors="ignore")
                    body = text if item.get("ext") == "srt" else yt.vtt_to_srt(text)
                    if body.strip():
                        out = target("srt", str(item.get("lang") or "") if multi else "")
                        out.write_text(body, encoding="utf-8")
                        saved += 1
                        self.log(f"字幕已保存：{out.name}", "ok")
            if not saved:
                self.task_note(task, "该视频没有可用字幕")
        if extras.get("danmaku") and "subtitle" not in wanted:
            self.task_note(task, "YouTube 视频没有弹幕，已跳过")

    # ------------------------------------------------------- 附加文件
    async def _write_extra_files(
        self,
        task: Task,
        spec: dict[str, Any],
        settings: Any,
        streams: dict[str, Any],
        dest: Path,
        referer: str,
        template: str = "",
    ) -> None:
        template = template or settings.video_template
        extras = settings.extras or {}
        wanted = [key for key in ("subtitle", "danmaku", "cover", "nfo") if extras.get(key)]
        if not wanted:
            return
        bvid = spec["bvid"]
        cid = int(spec["cid"])
        mapping = {
            "video_title": spec["video_title"],
            "video_id": bvid,
            "video_episode": str(spec["page_index"]),
            "video_page_title": spec["page_title"] or spec["video_title"],
            "video_author": spec.get("author", ""),
            "video_quality": streams["quality_label"],
            "video_date": _date(int(spec.get("pubdate") or 0)),
        }
        directory = self._video_dir(spec)

        def target(ext: str, suffix: str = "") -> Path:
            rel = build_relative(template, mapping, ext)
            if suffix:
                rel = rel.with_name(f"{rel.stem}-{suffix}{rel.suffix}")
            out = unique_path(directory / rel.parent, rel.name)
            out.parent.mkdir(parents=True, exist_ok=True)
            return out

        if "cover" in wanted:
            with contextlib.suppress(Exception):
                url = await api.video_pic(self.session, bvid)
                if url:
                    data = await self.session.get_bytes(url, referer=referer)
                    out = target("jpg")
                    out.write_bytes(data)
                    self.log(f"封面已保存：{out.name}", "ok")

        if "nfo" in wanted:
            with contextlib.suppress(Exception):
                info = await api.video_info(self.session, bvid)
                text = extras_mod.build_nfo(
                    {
                        "title": spec["video_title"],
                        "desc": getattr(info, "desc", "") or "",
                        "bvid": bvid,
                        "episode": spec["page_index"],
                        "author": spec.get("author", ""),
                        "date": _date(int(spec.get("pubdate") or 0)),
                        "cover": getattr(info, "cover", "") or "",
                        "duration": "",
                    }
                )
                out = target("nfo")
                out.write_text(text, encoding="utf-8")
                self.log(f"NFO 已保存：{out.name}", "ok")

        if "subtitle" in wanted:
            with contextlib.suppress(Exception):
                items = await api.subtitles(self.session, bvid, cid)
                multi = len(items) > 1
                for item in items:
                    payload = await api.subtitle_json(self.session, item["url"], referer)
                    body = extras_mod.subtitle_to_srt(payload)
                    if not body.strip():
                        continue
                    out = target("srt", item["lan"] if multi else "")
                    out.write_text(body, encoding="utf-8")
                    self.log(f"字幕已保存：{out.name}", "ok")
                if not items:
                    self.task_note(task, "该视频没有可用字幕（多为 UP 主未上传或需登录）")

        if "danmaku" in wanted:
            with contextlib.suppress(Exception):
                raw = await api.danmaku_xml(self.session, cid)
                text = raw.decode("utf-8", "ignore")
                body = extras_mod.danmaku_to_srt(text)
                if body.strip():
                    out = target("srt", "danmaku")
                    out.write_text(body, encoding="utf-8")
                    self.log(f"弹幕已保存：{out.name}", "ok")
                else:
                    self.task_note(task, "没有抓到弹幕内容")

    def task_note(self, task: Task, note: str) -> None:
        task.subtitle = f"{task.subtitle} · {note}" if task.subtitle else note

    async def _fetch_stream(
        self,
        task: Task,
        urls: list[str],
        dest: Path,
        referer: str,
        base: float,
        span: float,
    ) -> None:
        errors: list[str] = []
        for index, url in enumerate(urls):
            if self._should_stop(task):
                raise DownloadError("已取消")
            last_bytes = {"value": 0, "time": _now()}

            def progress(done: int, total: int) -> None:
                if total:
                    task.progress = base + span * min(1.0, done / total)
                now = _now()
                elapsed = now - last_bytes["time"]
                if elapsed >= 0.5:
                    task.speed = (done - last_bytes["value"]) / elapsed
                    last_bytes["value"] = done
                    last_bytes["time"] = now

            try:
                size = await self.session.download(
                    url,
                    dest,
                    referer=referer,
                    progress=progress,
                    should_stop=lambda: self._should_stop(task),
                )
                # CDN 偶发回 200 + 空 body：不拦就会留下 0 字节「文件」，
                # 播放器表现就是没声音 / 打不开。当成失败换下一条线路。
                if size <= 0:
                    with contextlib.suppress(OSError):
                        if dest.exists():
                            dest.unlink()
                    raise DownloadError(f"下载得到空文件（线路 {index + 1}）")
                task.done_bytes += size
                task.speed = 0.0
                return
            except DownloadError as exc:
                errors.append(f"{exc}（线路 {index + 1}）")
                with contextlib.suppress(OSError):
                    part = dest.with_suffix(dest.suffix + ".part")
                    if part.exists():
                        part.unlink()
        raise DownloadError("；".join(errors) or "下载失败")

    # ------------------------------------------------------------------ 图文
    async def _download_opus(self, task: Task, spec: dict[str, Any]) -> None:
        oid = spec["oid"]
        sub_kind = spec.get("sub_kind") or "opus"
        if sub_kind == "opus":
            info: OpusInfo = await api.opus_detail(self.session, oid)
        elif sub_kind == "dynamic":
            info = await api.dynamic_detail(self.session, oid)
        else:
            info = await api.article_detail(self.session, oid)

        settings = self.store.get()
        directory = self._opus_dir(spec)
        directory.mkdir(parents=True, exist_ok=True)
        task.title = info.title
        total = len(info.images)
        task.total_items = max(1, total)
        task.subtitle = f"图文 {total} 张"
        if not total:
            raise NotFound("该图文作品没有可下载的图片（可能是纯文字或视频动态）")
        self.log(f"开始下载图文：{info.title}（{total} 张）", "info")

        base_mapping = {
            "opus_title": info.title,
            "opus_id": info.oid,
            "opus_author": info.author,
            "opus_date": _date(info.pubdate),
        }
        # 文集里的文章额外带 readlist_* 变量，并用「文集重命名规则」；普通图文沿用 opus 规则
        rl = spec.get("readlist") or {}
        if rl:
            base_mapping.update({
                "readlist_title": str(rl.get("title") or ""),
                "readlist_order": str(rl.get("order") or ""),
                "readlist_id": str(rl.get("id") or ""),
            })
            template = spec.get("template") or settings.readlist_template
        else:
            template = spec.get("template") or settings.opus_template
        saved = 0
        for index, image in enumerate(info.images, start=1):
            if self._should_stop(task):
                raise DownloadError(f"已取消（已完成 {saved}/{total}）")
            mapping = dict(base_mapping)
            mapping["opus_order"] = str(index)
            ext = image_ext(image["url"])
            rel = build_relative(template, mapping, ext)
            dest = directory / rel
            if settings.skip_existing and dest.exists():
                self._note_file(task, dest, mapping, directory, template)
                saved += 1
                task.done_items = saved
                task.progress = saved / total
                continue
            if dest.exists():
                dest = unique_path(directory / rel.parent, rel.name)
            dest.parent.mkdir(parents=True, exist_ok=True)
            last = {"done": 0, "time": _now()}

            def progress(done: int, total_bytes: int, index: int = index, saved: int = saved) -> None:
                task.done_items = saved
                task.progress = min(1.0, (saved + (done / total_bytes if total_bytes else 0)) / total)
                now = _now()
                elapsed = now - last["time"]
                if elapsed >= 0.5:
                    task.speed = (done - last["done"]) / elapsed
                    last["done"] = done
                    last["time"] = now

            errors: list[str] = []
            for attempt in range(MAX_IMAGE_RETRY + 1):
                try:
                    size = await self.session.download(
                        image["url"],
                        dest,
                        referer=info.url or "https://www.bilibili.com/",
                        progress=progress,
                        should_stop=lambda: self._should_stop(task),
                        resume=False,
                    )
                    task.done_bytes += size
                    task.speed = 0.0
                    errors = []
                    break
                except DownloadError as exc:
                    errors.append(str(exc))
                    if attempt < MAX_IMAGE_RETRY:
                        await asyncio.sleep(1.2 + attempt * 1.5 + random.uniform(0, 0.5))
            if errors:
                raise DownloadError(f"第 {index}/{total} 张图片下载失败：{errors[-1]}")
            self._note_file(task, dest, mapping, directory, template)
            saved += 1
            task.done_items = saved
            task.progress = saved / total

        task.path = str(directory)
        self.log(f"图文下载完成：{info.title}（{saved} 张）", "ok")

    # ------------------------------------------------------------------ 空间扫描
    async def start_scan(self, mid: str, tabs: list[str] | None = None) -> str:
        mid = str(mid or "").strip()
        if not mid.isdigit():
            raise ParseError("UP 主 ID 不正确")
        tabs = tabs or ["video", "opus"]
        job = ScanJob(id=uuid.uuid4().hex[:12], mid=mid)
        self.scans[job.id] = job
        asyncio.create_task(self._run_scan(job, tabs))
        return job.id

    async def _run_scan(self, job: ScanJob, tabs: list[str]) -> None:
        settings = self.store.get()
        try:
            job.user = await api.user_card(self.session, job.mid)
            job.message = "正在获取 UP 主信息…"
            if "video" in tabs:
                job.message = "正在检索视频投稿…"
                works, note = await api.space_videos(
                    self.session,
                    job.mid,
                    delay=settings.scan_interval,
                    max_pages=settings.max_pages,
                    progress=lambda msg: setattr(job, "message", msg),
                )
                job.video = [w.to_dict() for w in works]
                if note:
                    job.note = note
            if "opus" in tabs and not job.canceled:
                job.message = "正在检索图文作品…"
                works, note = await api.space_opus(
                    self.session,
                    job.mid,
                    delay=settings.scan_interval,
                    max_pages=settings.max_pages,
                    progress=lambda msg: setattr(job, "message", msg),
                )
                job.opus = [w.to_dict() for w in works]
                if note:
                    job.note = (job.note + " " + note).strip()
            job.status = "canceled" if job.canceled else "done"
            job.message = (
                f"检索完成：视频 {len(job.video)} 个，图文 {len(job.opus)} 个"
                if not job.canceled
                else "已取消"
            )
            self.log(job.message, "ok")
        except RiskControl as exc:
            job.status = "error"
            job.message = str(exc)
            self._cooldown_until = _now() + 45
            self.log(f"检索触发风控：{exc}", "error")
        except Exception as exc:  # noqa: BLE001
            job.status = "error"
            job.message = str(exc)
            self.log(f"检索失败：{exc}", "error")

    def scan_status(self, job_id: str) -> dict[str, Any]:
        job = self.scans.get(job_id)
        if not job:
            raise NotFound("检索任务不存在")
        return job.to_dict()

    def cancel_scan(self, job_id: str) -> None:
        job = self.scans.get(job_id)
        if job:
            job.canceled = True
