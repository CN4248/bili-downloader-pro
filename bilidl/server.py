"""WebUI 服务：标准库 HTTP 服务 + asyncio 引擎桥接。

刻意只依赖 httpx（纯 Python）与 qrcode（纯 Python），
便于用 PyInstaller 打包成 exe，也便于在 Android(Chaquopy) 上运行。
"""

from __future__ import annotations

import asyncio
import io
import json
import mimetypes
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__, api, youtube as yt
from .config import SettingsStore, app_dir, var_hints
from .downloader import Engine
from .errors import AuthRequired, BiliError, NotFound, ParseError, RiskControl
from .subs import Subscriber

MAX_BODY = 8 * 1024 * 1024


def web_dir() -> Path:
    env = os.environ.get("BILIDL_WEB_DIR", "").strip()
    if env and Path(env).is_dir():
        return Path(env)
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        if (base / "web").is_dir():
            return base / "web"
    here = Path(__file__).resolve().parent.parent / "web"
    return here


class Api:
    """把 HTTP 请求翻译成引擎调用。"""

    def __init__(
        self,
        store: SettingsStore,
        engine: Engine,
        loop: asyncio.AbstractEventLoop,
        subscriber: Subscriber | None = None,
    ) -> None:
        self.store = store
        self.engine = engine
        self.loop = loop
        self.subscriber = subscriber

    def run(self, coro, timeout: float = 180.0):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def queue_call(self, fn, *args, **kwargs):
        """队列变更（暂停/继续/取消/重试）放到事件循环线程里执行。

        asyncio.Queue 不是线程安全的，而 HTTP 请求跑在 ThreadingHTTPServer 的
        工作线程里；直接在工作线程 put_nowait 可能唤醒不了等队列的 worker。
        """
        if not self.loop.is_running():  # 单元测试里没有跑 loop
            return fn(*args, **kwargs)

        async def _invoke():
            return fn(*args, **kwargs)

        return self.run(_invoke(), timeout=30.0)

    async def _diagnose(self) -> dict[str, Any]:
        """给 Docker 部署用的连通性自检：容器里能不能出网、能不能拿到 B站 接口与视频 CDN。"""
        import time as _t
        checks: list[dict[str, Any]] = []

        async def probe(name: str, url: str) -> None:
            t0 = _t.monotonic()
            try:
                r = await self.engine.session.client.get(url, timeout=15.0)  # type: ignore[attr-defined]
                ok = r.status_code < 500
                checks.append({"name": name, "ok": ok, "status": r.status_code,
                               "ms": int((_t.monotonic() - t0) * 1000)})
            except Exception as exc:  # noqa: BLE001
                checks.append({"name": name, "ok": False, "status": 0,
                               "ms": int((_t.monotonic() - t0) * 1000),
                               "error": f"{type(exc).__name__}: {exc}"[:160]})

        await probe("B站 主接口", "https://api.bilibili.com/x/web-interface/nav")
        await probe("Passport（扫码登录）", "https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
        await probe("视频 CDN", "https://upos-sz-mirrorcos.bilivideo.com/")
        if yt.available():
            await probe("YouTube 网页", "https://www.youtube.com/generate_204")
            await probe("YouTube 图片 CDN", "https://i.ytimg.com/generate_204")
        else:
            checks.append(
                {
                    "name": "YouTube 解析（yt-dlp）",
                    "ok": False,
                    "status": 0,
                    "ms": 0,
                    "error": "未安装 yt-dlp，YouTube 功能不可用",
                }
            )
        settings = self.store.get()
        dirs = {}
        for label, path in (("视频目录", settings.video_dir), ("图文目录", settings.opus_dir)):
            try:
                from pathlib import Path
                p = Path(path)
                p.mkdir(parents=True, exist_ok=True)
                probe_file = p / ".bilidl-write-test"
                probe_file.write_text("ok", encoding="utf-8")
                probe_file.unlink()
                dirs[label] = {"path": path, "writable": True}
            except Exception as exc:  # noqa: BLE001
                dirs[label] = {"path": path, "writable": False, "error": str(exc)[:120]}
        from .constants import APP_VERSION
        try:
            cookie = self.store.cookie_path.read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            cookie = ""
        return {
            "version": APP_VERSION,
            "checks": checks,
            "dirs": dirs,
            "logged_in": "SESSDATA" in cookie,
            "youtube": yt.status(),
        }

    # ---------------------------------------------------------------- GET
    def get(self, path: str, query: dict[str, str]) -> Any:
        engine = self.engine
        if path in ("/api/status", "/api/health"):
            return engine.status()
        if path == "/api/tasks":
            return engine.snapshot()
        if path == "/api/vars":
            return var_hints()
        if path == "/api/settings":
            return {"settings": self.store.get().to_dict(), "vars": var_hints()}
        if path.startswith("/api/space/scan/"):
            job_id = path.rsplit("/", 1)[-1]
            return engine.scan_status(job_id)
        if path == "/api/subs":
            return self._subs().snapshot()
        if path == "/api/diagnose":
            return self.run(self._diagnose(), timeout=60.0)
        if path == "/api/qr":
            return {"svg": self._qr_svg(query.get("url", ""))}
        raise NotFound("接口不存在")

    # --------------------------------------------------------------- POST
    def post(self, path: str, body: dict[str, Any]) -> Any:
        engine = self.engine
        if path == "/api/settings":
            settings = self.store.save(body.get("settings") or body)
            self.run(self._apply(settings))
            return {"settings": settings.to_dict()}
        if path == "/api/login/cookie":
            return self.run(engine.login_cookie(str(body.get("cookie") or "")))
        if path == "/api/login/qr/start":
            return self.run(engine.login_qr_start())
        if path == "/api/login/qr/poll":
            return self.run(engine.login_qr_poll(str(body.get("key") or "")))
        if path == "/api/logout":
            self.run(engine.logout())
            return {"logout": True}
        if path == "/api/parse":
            items = self.run(engine.parse(str(body.get("text") or "")), timeout=300.0)
            return {"items": items}
        if path == "/api/download":
            return self.run(self._download(body), timeout=300.0)
        if path == "/api/tasks/cancel":
            if body.get("all"):
                # 取消全部 = 直接从队列里删除（返回删掉的数量）
                removed = self.queue_call(engine.cancel_all)
                return {"canceled": "all", "removed": removed}
            ids = body.get("ids")
            if isinstance(ids, list):
                return {"canceled": "many", "count": self.queue_call(engine.cancel_many, [str(i) for i in ids])}
            task_id = str(body.get("id") or "")
            self.queue_call(engine.cancel, task_id)
            return {"canceled": task_id}
        if path in ("/api/tasks/pause", "/api/tasks/resume"):
            all_ = bool(body.get("all"))
            ids = body.get("ids")
            if not isinstance(ids, list):
                ids = [body.get("id")] if body.get("id") else []
            ids = [str(i) for i in ids]
            if path.endswith("pause"):
                return {"paused": self.queue_call(engine.pause, ids, all_=all_), "all": all_}
            return {"resumed": self.queue_call(engine.resume, ids, all_=all_), "all": all_}
        if path == "/api/tasks/clear":
            self.queue_call(engine.clear_finished)
            return {"cleared": True}
        if path == "/api/tasks/retry":
            return {"retried": self.queue_call(engine.retry_failed, str(body.get("id") or ""))}
        if path == "/api/space/scan":
            mid = str(body.get("mid") or "")
            tabs = body.get("tabs") or ([body["tab"]] if body.get("tab") else ["video", "opus"])
            job_id = self.run(engine.start_scan(mid, [str(t) for t in tabs if str(t) in ("video", "opus")] or ["video", "opus"]))
            return {"job": job_id}
        if path == "/api/subs":
            sub = self.run(self._subs().upsert(body), timeout=600.0)
            return {"sub": sub, "state": self._subs().snapshot()}
        if path == "/api/subs/delete":
            self._subs().delete(str(body.get("id") or ""))
            return self._subs().snapshot()
        if path == "/api/subs/batch":
            result = self._subs().batch(body)
            result["state"] = self._subs().snapshot()
            return result
        if path == "/api/subs/config":
            return self._subs().set_config(body)
        if path == "/api/subs/check":
            return self.run(self._subs().check_now(str(body.get("id") or "")), timeout=900.0)
        if path == "/api/subs/works":
            return self.run(
                self._subs().list_works(str(body.get("id") or ""), str(body.get("kind") or "video")),
                timeout=300.0,
            )
        if path == "/api/subs/report":
            return self.run(self._subs().report_works(body), timeout=300.0)
        if path == "/api/space/scan/cancel":
            engine.cancel_scan(str(body.get("id") or ""))
            return {"canceled": True}
        raise NotFound("接口不存在")

    def _subs(self) -> Subscriber:
        if self.subscriber is None:
            raise BiliError("自动追更模块未初始化")
        return self.subscriber

    async def _apply(self, settings) -> None:
        await self.engine.apply_settings()

    async def _download(self, body: dict[str, Any]) -> dict[str, Any]:
        videos = body.get("videos") or []
        opus = body.get("opus") or []
        idents = body.get("video_idents") or []
        # 抖音 / 小红书：脚本已经知道作品 ID 时直接建任务（毫秒级），
        # 详细信息和真实标题由 worker 在下载前补齐，和 B站 的 lazy 任务一个思路。
        social = body.get("social") or []
        links = str(body.get("links") or "").strip()
        if links:
            # 直接推链接（油猴脚本 / curl 都走这里）：解析后按类型分发，
            # 省得前端先 /api/parse 再拼 payload。
            parsed = await self.engine.parse(links)
            failed_links = [p.get("error") for p in parsed if not p.get("ok")]
            for item in parsed:
                if not item.get("ok"):
                    continue
                kind = item.get("kind")
                if kind == "video":
                    videos.append(item)
                elif kind == "videolist":
                    for work in item.get("works") or []:
                        videos.append(
                            {
                                "bvid": work.get("ident"),
                                "video_title": work.get("title"),
                                "author": item.get("uploader") or item.get("author") or "",
                                "author_uid": item.get("mid") or "",
                                "season_id": item.get("id") or "",
                                "season_title": item.get("title") or "",
                                "source": item.get("source") or "",
                                "cover": work.get("cover") or "",
                                "duration": work.get("duration") or 0,
                            }
                        )
                else:
                    opus.append(item)
            if not videos and not opus and not idents:
                raise ParseError("；".join(failed_links) or "没有识别到可下载的内容")
        if not videos and not opus and not idents and not social:
            raise ParseError("没有选择任何下载内容")
        video_ids = await self.engine.add_video_targets(videos)
        ident_result = {"tasks": [], "failed": [], "count": 0}
        if idents:
            # 元素可以是 "BV…" 字符串，也可以是 {bvid|ident, video_title, author, pubdate} 对象
            ident_result = await self.engine.add_video_idents(
                idents, all_pages=bool(body.get("all_pages", True))
            )
            video_ids = list(video_ids) + list(ident_result["tasks"])
        opus_ids = await self.engine.add_opus_targets(opus)
        social_ids = await self.engine.add_social_targets(social) if social else []
        return {
            "videos": video_ids,
            "opus": opus_ids,
            "social": social_ids,
            "failed": (ident_result.get("failed") or []) + (failed_links if links else []),
            "count": len(video_ids) + len(opus_ids) + len(social_ids),
        }

    @staticmethod
    def _qr_svg(url: str) -> str:
        if not url:
            raise ParseError("二维码内容为空")
        try:
            import qrcode
            import qrcode.image.svg
        except ImportError as exc:  # pragma: no cover
            raise BiliError("缺少 qrcode 依赖，无法生成二维码") from exc
        image = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
        buffer = io.BytesIO()
        image.save(buffer)
        return buffer.getvalue().decode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "BiliDL-PRO/" + __version__
    protocol_version = "HTTP/1.1"
    api: Api
    static_root: Path

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - 覆盖标准库
        if os.environ.get("BILIDL_VERBOSE"):
            sys.stderr.write("[http] %s\n" % (fmt % args))

    # ------------------------------------------------------------ 分发
    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if path.startswith("/api/"):
                if method == "GET":
                    payload = self.api.get(path, query)
                else:
                    body = self._read_json()
                    payload = self.api.post(path, body)
                self._json(HTTPStatus.OK, {"ok": True, "data": payload})
                return
            self._static(path)
        except RiskControl as exc:
            self._json(HTTPStatus.TOO_MANY_REQUESTS, {"ok": False, "error": str(exc), "kind": "risk"})
        except AuthRequired as exc:
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": str(exc), "kind": "auth"})
        except NotFound as exc:
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc), "kind": "notfound"})
        except (ParseError, BiliError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc), "kind": "bili"})
        except asyncio.TimeoutError:
            self._json(HTTPStatus.GATEWAY_TIMEOUT, {"ok": False, "error": "请求超时，请稍后重试"})
        except Exception as exc:  # noqa: BLE001
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"服务异常：{exc}"})

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ParseError("请求体过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ParseError("请求格式不是合法 JSON") from exc
        return data if isinstance(data, dict) else {}

    def _cors(self) -> None:
        """允许油猴脚本 / 本地网页跨域调用。"""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(int(status))
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (self.static_root / rel).resolve()
        root = self.static_root.resolve()
        if not str(target).startswith(str(root)) or not target.is_file():
            target = root / "index.html"
        if not target.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "WebUI 文件缺失"})
            return
        data = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


class ServerThread(threading.Thread):
    """在后台线程运行 HTTP 服务，主线程跑 asyncio 事件循环。"""

    def __init__(self, api_obj: Api, host: str, port: int, static: Path) -> None:
        super().__init__(daemon=True, name="bilidl-http")
        handler = type("BoundHandler", (Handler,), {"api": api_obj, "static_root": static})
        self.httpd = ThreadingHTTPServer((host, port), handler)
        self.httpd.daemon_threads = True
        self.host = host
        self.port = port

    def run(self) -> None:
        self.httpd.serve_forever(poll_interval=0.4)

    def stop(self) -> None:
        self.httpd.shutdown()


def serve(host: str = "0.0.0.0", port: int = 2197, open_browser: bool = False) -> None:
    """启动 WebUI；阻塞运行。"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    store = SettingsStore()
    engine = Engine(store)
    loop.run_until_complete(engine.start())
    subscriber = Subscriber(engine, store.dir / "subs.json")
    # 订阅任务落盘后登记文件清单，改重命名规则时才能把旧文件一起改名
    engine.on_files_saved = subscriber.record_files
    loop.run_until_complete(subscriber.start())
    api_obj = Api(store, engine, loop, subscriber)
    server = ServerThread(api_obj, host, port, web_dir())
    server.start()
    url = f"http://127.0.0.1:{port}/"
    print(f"BiliDL-PRO WebUI 已启动： {url}")
    print(f"下载目录（视频）：{store.get().video_dir}")
    print(f"下载目录（图文）：{store.get().opus_dir}")
    print(f"ffmpeg：{'已检测到' if engine.ffmpeg_ok else '未检测到（将使用 mp4 直链）'}")
    if open_browser:
        threading.Timer(1.2, lambda: _open(url)).start()
    try:
        loop.run_forever()
    except KeyboardInterrupt:
        print("\n正在退出…")
    finally:
        server.stop()
        loop.run_until_complete(subscriber.close())
        loop.run_until_complete(engine.close())
        loop.close()


def _open(url: str) -> None:
    import webbrowser

    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001
        pass
