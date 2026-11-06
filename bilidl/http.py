"""B站 HTTP 会话：Cookie 管理、WBI 签名、全局节流与下载。

设计要点（防风控）：
1. 所有 API 请求串行执行，并保持 ``api_interval`` 秒（带随机抖动）的最小间隔；
2. 统一的桌面 Chrome UA + 正确 Referer，并预先申请 buvid3/buvid4；
3. 命中风控码后指数退避重试，仍失败则抛出 :class:`RiskControl`，由上层暂停任务；
4. 不实现任何验证码绕过或设备指纹伪造，只做正常的浏览器行为模拟。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import time
import urllib.parse
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from .constants import (
    APP_BUILD,
    APP_KEY,
    APP_MOBI_APP,
    APP_SEC,
    CHUNK_SIZE,
    COOKIE_FAILURE_CODES,
    DESKTOP_UA,
    MAX_API_RETRY,
    MIXIN_KEY_ENC_TAB,
    RISK_BACKOFF,
    RISK_CODES,
)
from .errors import AuthRequired, BiliError, DownloadError, NotFound, RiskControl

SITE = "https://www.bilibili.com"
API = "https://api.bilibili.com"
PASSPORT = "https://passport.bilibili.com"

ProgressCb = Callable[[int, int], Awaitable[None] | None]


def _mixin_key(img_key: str, sub_key: str) -> str:
    raw = img_key + sub_key
    return "".join(raw[i] for i in MIXIN_KEY_ENC_TAB)[:32]


def parse_cookie_text(text: str) -> dict[str, str]:
    """解析用户粘贴的 Cookie。

    支持 ``a=1; b=2``、换行分隔、以及浏览器插件导出的 JSON 数组/对象。
    """
    text = (text or "").strip()
    if not text:
        return {}
    if text.startswith("[") or text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = None
        if isinstance(data, list):
            out = {}
            for item in data:
                if isinstance(item, dict) and item.get("name"):
                    out[str(item["name"])] = str(item.get("value", ""))
            return out
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}

    out: dict[str, str] = {}
    for part in text.replace("\n", ";").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        if key.lower() in {"cookie", "path", "domain", "expires"}:
            continue
        if key and value.strip():
            out[key] = value.strip()
    return out


class BiliSession:
    """一个账号 + 一套节流参数的请求会话。"""

    def __init__(
        self,
        cookies: dict[str, str] | None = None,
        *,
        api_interval: float = 1.2,
        timeout: float = 30.0,
        proxy: str = "",
    ) -> None:
        self.cookies: dict[str, str] = dict(cookies or {})
        self.proxy = proxy.strip()
        self.api_interval = max(0.3, float(api_interval))
        self._lock = asyncio.Lock()
        self._last_request = 0.0
        self._wbi_cache = ""
        self._wbi_time = 0.0
        self._buvid_ready = False
        self.user: dict[str, Any] = {}
        self.last_risk_time = 0.0
        proxy_url = proxy.strip() or None
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=15.0),
            follow_redirects=True,
            headers={
                "User-Agent": DESKTOP_UA,
                "Referer": SITE + "/",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Origin": SITE,
            },
            proxy=proxy_url,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )

    # ------------------------------------------------------------------ 基础
    async def aclose(self) -> None:
        await self.client.aclose()

    def cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items() if v)

    def export_cookie(self) -> str:
        keep = [
            "SESSDATA",
            "bili_jct",
            "DedeUserID",
            "DedeUserID__ckMd5",
            "sid",
            "buvid3",
            "buvid4",
            "b_nut",
        ]
        return "; ".join(f"{k}={self.cookies[k]}" for k in keep if self.cookies.get(k))

    def has_login(self) -> bool:
        return bool(self.cookies.get("SESSDATA"))

    # ------------------------------------------------------------------ 签名
    def _app_sign(self, params: dict[str, Any]) -> dict[str, Any]:
        params = {k: v for k, v in params.items() if v is not None}
        params["appkey"] = APP_KEY
        query = urllib.parse.urlencode(sorted((k, str(v)) for k, v in params.items()))
        params["sign"] = hashlib.md5((query + APP_SEC).encode()).hexdigest()
        return params

    async def _wbi_key(self) -> str:
        """获取并缓存 WBI mixin key（默认 30 分钟刷新）。"""
        if self._wbi_cache and time.time() - self._wbi_time < 1800:
            return self._wbi_cache
        payload = await self.get(
            f"{API}/x/web-interface/nav", params={}, use_wbi=False, category="wbi"
        )
        try:
            wbi = (payload.get("data") or {}).get("wbi_img") or {}
            img = str(wbi.get("img_url", "")).rsplit("/", 1)[-1].split(".")[0]
            sub = str(wbi.get("sub_url", "")).rsplit("/", 1)[-1].split(".")[0]
        except Exception:  # pragma: no cover - 结构异常时退回空 key
            img = sub = ""
        if not img or not sub:
            self._wbi_cache = ""
        else:
            self._wbi_cache = _mixin_key(img, sub)
        self._wbi_time = time.time()
        return self._wbi_cache

    async def _prepare_buvid(self) -> None:
        """申请 buvid3/buvid4，模拟正常浏览器的首次访问行为。"""
        if self._buvid_ready or self.cookies.get("buvid3"):
            self._buvid_ready = True
            return
        try:
            resp = await self.client.get(f"{API}/x/frontend/finger/spi")
            data = (resp.json() or {}).get("data") or {}
            if data.get("b_3"):
                self.cookies["buvid3"] = data["b_3"]
            if data.get("b_4"):
                self.cookies["buvid4"] = data["b_4"]
            self.cookies["b_nut"] = str(int(time.time()))
        except Exception:
            pass
        self._buvid_ready = True

    async def _throttle(self) -> None:
        """保证两次 API 请求之间有足够的间隔（带抖动）。"""
        delay = self.api_interval + random.uniform(0, 0.4)
        elapsed = time.monotonic() - self._last_request
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        self._last_request = time.monotonic()

    # ------------------------------------------------------------------ 请求
    async def get(
        self,
        url: str,
        params: dict[str, Any] | None = None,
        *,
        use_wbi: bool = False,
        referer: str | None = None,
        category: str = "api",
        retries: int = MAX_API_RETRY,
    ) -> dict[str, Any]:
        """发起一次 GET 请求并返回 JSON，自动处理风控与登录错误。"""
        params = {k: v for k, v in (params or {}).items() if v is not None}
        if use_wbi:
            key = await self._wbi_key()
            if key:
                params["wts"] = int(time.time())
                cleaned = sorted(
                    (k, "".join(ch for ch in str(v) if ch not in "!'()*"))
                    for k, v in params.items()
                )
                query = urllib.parse.urlencode(cleaned)
                params["w_rid"] = hashlib.md5((query + key).encode()).hexdigest()

        await self._prepare_buvid()
        headers = {}
        if referer:
            headers["Referer"] = referer
        if self.cookies:
            headers["Cookie"] = self.cookie_header()

        attempt = 0
        while True:
            async with self._lock:
                await self._throttle()
                try:
                    resp = await self.client.get(url, params=params, headers=headers)
                except httpx.HTTPError as exc:
                    raise BiliError(f"网络请求失败：{exc}") from exc
            if resp.status_code == 412:
                attempt += 1
                if attempt > retries:
                    raise RiskControl("B站返回 412（请求被拦截），请降低速度或更换网络后重试")
                await asyncio.sleep(RISK_BACKOFF[min(attempt - 1, len(RISK_BACKOFF) - 1)])
                continue
            if resp.status_code == 429:
                attempt += 1
                if attempt > retries:
                    raise RiskControl("B站限流（429），请稍后再试")
                await asyncio.sleep(RISK_BACKOFF[min(attempt - 1, len(RISK_BACKOFF) - 1)])
                continue
            if resp.status_code >= 400:
                raise BiliError(f"HTTP {resp.status_code}：{url}")

            try:
                payload = resp.json()
            except ValueError as exc:
                raise BiliError("B站返回了非 JSON 响应，可能触发了风控") from exc

            code = int(payload.get("code") or 0)
            if code == 0:
                return payload
            message = str(payload.get("message") or payload.get("msg") or "") or f"错误码 {code}"
            if code in RISK_CODES:
                self.last_risk_time = time.time()
                attempt += 1
                if attempt > retries:
                    raise RiskControl(
                        f"触发B站风控校验失败（{message}）。已自动退避重试仍未通过，"
                        "请稍后重试或登录后使用（登录态更稳定）"
                    )
                await asyncio.sleep(RISK_BACKOFF[min(attempt - 1, len(RISK_BACKOFF) - 1)])
                continue
            if code == -101 or code == -111:
                raise AuthRequired(f"需要登录：{message}")
            if code == -404 or code == 62002 or code == 62004:
                raise NotFound(f"内容不存在或已删除：{message}")
            raise BiliError(message, code=code)

    async def get_bytes(
        self,
        url: str,
        *,
        referer: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> bytes:
        """取原始字节（弹幕 XML、字幕 JSON、封面图片等）。"""
        await self._prepare_buvid()
        headers: dict[str, str] = {"User-Agent": DESKTOP_UA}
        if referer:
            headers["Referer"] = referer
        if self.cookies:
            headers["Cookie"] = self.cookie_header()
        async with self._lock:
            await self._throttle()
            response = await self.client.get(url, params=params or {}, headers=headers)
        if response.status_code >= 400:
            raise BiliError(f"请求失败：HTTP {response.status_code}")
        return response.content

    async def get_app(self, url: str, params: dict[str, Any]) -> dict[str, Any]:
        """App 端签名接口（用于 UP 主投稿列表）。"""
        merged = {
            **params,
            "ts": int(time.time()),
            "mobi_app": APP_MOBI_APP,
            "platform": "android",
            "build": APP_BUILD,
        }
        # 注意：参与签名的参数必须与实际发送的参数完全一致，否则服务端返回「签名错误」
        full = self._app_sign(merged)
        return await self.get(url, full, use_wbi=False)

    # ------------------------------------------------------------------ 登录
    async def refresh_user(self) -> dict[str, Any]:
        payload = await self.get(f"{API}/x/web-interface/nav", use_wbi=False)
        data = payload.get("data") or {}
        self.user = {
            "logged_in": bool(data.get("isLogin")),
            "mid": str(data.get("mid") or ""),
            "name": data.get("uname") or "",
            "avatar": data.get("face") or "",
            "vip": bool((data.get("vipStatus") or 0) == 1),
            "level": data.get("level_info", {}).get("current_level", 0),
        }
        return self.user

    # ------------------------------------------------------------------ 下载
    async def download(
        self,
        url: str,
        dest: Path,
        *,
        referer: str = SITE + "/",
        progress: ProgressCb | None = None,
        should_stop: Callable[[], bool] | None = None,
        resume: bool = True,
    ) -> int:
        """流式下载单个文件，支持断点续传（.part 临时文件）。"""
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_suffix(dest.suffix + ".part")
        if dest.exists() and dest.stat().st_size > 0 and not resume:
            return dest.stat().st_size

        start = part.stat().st_size if (resume and part.exists()) else 0
        headers = {
            "Referer": referer,
            "User-Agent": DESKTOP_UA,
            # 别让 CDN gzip：压缩后 Content-Length 跟落盘字节数对不上，没法校验完整性
            "Accept-Encoding": "identity",
        }
        if start:
            headers["Range"] = f"bytes={start}-"
        if self.cookies:
            headers["Cookie"] = self.cookie_header()

        total = 0
        done = start
        try:
            async with self.client.stream(
                "GET", url, headers=headers, follow_redirects=True, timeout=httpx.Timeout(60.0, connect=20.0)
            ) as resp:
                if resp.status_code not in (200, 206):
                    raise DownloadError(f"下载失败（HTTP {resp.status_code}）")
                if start and resp.status_code == 200:
                    start = 0
                    done = 0
                total = int(resp.headers.get("Content-Length") or 0)
                if resp.status_code == 206:
                    content_range = resp.headers.get("Content-Range", "")
                    full = 0
                    if "/" in content_range:
                        try:
                            full = int(content_range.rsplit("/", 1)[-1])
                        except ValueError:
                            full = 0
                    # Content-Range 里的总长是整文件大小；没有它才用「已有 + 剩余」估算
                    total = full or (total + start if total else 0)
                mode = "ab" if start else "wb"
                with part.open(mode) as fh:
                    async for chunk in resp.aiter_bytes(CHUNK_SIZE):
                        if should_stop and should_stop():
                            raise DownloadError("已取消")
                        fh.write(chunk)
                        done += len(chunk)
                        if progress:
                            res = progress(done, total)
                            if asyncio.iscoroutine(res):
                                await res
        except httpx.HTTPError as exc:
            raise DownloadError(f"下载中断：{exc}") from exc

        # 连接被 CDN 悄悄掐断时 httpx 不一定报错；长度对不上就算失败，
        # 免得留下「能打开、但没声音/播一半」的残缺文件。
        if total and done < total:
            raise DownloadError(f"下载不完整（{done}/{total} 字节）")

        if dest.exists():
            dest.unlink()
        part.rename(dest)
        return dest.stat().st_size
