"""配置读写：下载目录、清晰度、重命名模板与防风控节流参数。"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from .constants import (
    APP_NAME,
    DEFAULT_API_INTERVAL,
    DEFAULT_CONCURRENCY,
    DEFAULT_FILE_INTERVAL,
    DEFAULT_QUALITY,
    DEFAULT_SCAN_INTERVAL,
    QUALITY_CHOICES,
)
from .extras import DEFAULT_EXTRAS, normalize_extras
from .naming import DEFAULT_OPUS_TEMPLATE, DEFAULT_READLIST_TEMPLATE, DEFAULT_VIDEO_TEMPLATE

FALLBACK_ROOT = str(Path.home() / "Videos" / "BiliDL")


def default_root() -> str:
    """默认下载根目录：优先环境变量，其次按平台选择。"""
    env = os.environ.get("BILIDL_DOWNLOAD_DIR", "").strip()
    if env:
        return env
    if os.name == "nt":
        return str(Path.home() / "Videos" / "BiliDL")
    return FALLBACK_ROOT


def app_dir() -> Path:
    """配置与本地数据目录（打包后放在可执行文件旁边，便于用户查看）。"""
    env = os.environ.get("BILIDL_DATA_DIR", "").strip()
    if env:
        path = Path(env)
    elif getattr(sys, "frozen", False):
        path = Path(sys.executable).resolve().parent / "data"
    else:
        path = Path(__file__).resolve().parent.parent / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


@dataclass
class Settings:
    """全部可配置项。字段名与前端表单一一对应。"""

    # 下载目录（视频与图文可分别设置）
    video_dir: str = field(default_factory=lambda: default_root())
    opus_dir: str = field(
        default_factory=lambda: os.path.join(default_root(), "图文")
        if os.name != "nt"
        else os.path.join(default_root(), "opus")
    )
    # 清晰度
    quality: str = DEFAULT_QUALITY
    # 重命名规则
    video_template: str = DEFAULT_VIDEO_TEMPLATE
    opus_template: str = DEFAULT_OPUS_TEMPLATE
    readlist_template: str = DEFAULT_READLIST_TEMPLATE
    # 选择行为默认值
    default_all_pages: bool = True
    default_season_all: bool = False
    skip_existing: bool = True
    # 防风控节流
    api_interval: float = DEFAULT_API_INTERVAL
    scan_interval: float = DEFAULT_SCAN_INTERVAL
    file_interval: float = DEFAULT_FILE_INTERVAL
    concurrency: int = DEFAULT_CONCURRENCY
    max_pages: int = 60
    # 代理：B站 与 YouTube 可以分开开关（也可各用各的地址）
    proxy: str = ""
    # YouTube 专用代理地址（留空 = 与上面共用）
    proxy_youtube: str = ""
    use_proxy_bili: bool = True
    use_proxy_youtube: bool = True
    # YouTube 登录 Cookie（Netscape cookie 文本或浏览器里复制的内容）；
    # 用于年龄限制/会员专属/需要登录验证（反爬）的视频
    youtube_cookies: str = ""
    # 纯音频格式：m4a = 原 AAC 音轨重封装（音质最好）；mp3 = 转码 192k（老设备兼容）
    audio_format: str = "m4a"
    # 附加文件（多选；全部为 False 时下载正常有声视频）
    extras: dict[str, bool] = field(default_factory=lambda: dict(DEFAULT_EXTRAS))

    def normalized(self) -> "Settings":
        data = asdict(self)
        if data["quality"] not in QUALITY_CHOICES:
            data["quality"] = DEFAULT_QUALITY
        data["api_interval"] = _clamp(data["api_interval"], 0.5, 10.0)
        data["scan_interval"] = _clamp(data["scan_interval"], 0.8, 15.0)
        data["file_interval"] = _clamp(data["file_interval"], 0.0, 30.0)
        data["concurrency"] = int(_clamp(data["concurrency"], 1, 4))
        data["max_pages"] = int(_clamp(data["max_pages"], 1, 200))
        data["extras"] = normalize_extras(data.get("extras"))
        data["audio_format"] = "mp3" if str(data.get("audio_format") or "").lower() == "mp3" else "m4a"
        # 纯音频与无声视频现在可以同时勾选：各下一份文件，不再互斥
        data["youtube_cookies"] = str(data.get("youtube_cookies") or "")
        data["proxy"] = str(data.get("proxy") or "").strip()
        data["proxy_youtube"] = str(data.get("proxy_youtube") or "").strip()
        data["use_proxy_bili"] = bool(data.get("use_proxy_bili", True))
        data["use_proxy_youtube"] = bool(data.get("use_proxy_youtube", True))
        for key in ("video_dir", "opus_dir"):
            data[key] = str(data[key] or "").strip() or default_root()

        return Settings(**data)

    # -------------------------------------------------------------- 代理
    def bili_proxy(self) -> str:
        """B站在用的代理地址（未勾选则空串 = 直连）。"""
        return (self.proxy or "").strip() if self.use_proxy_bili else ""

    def youtube_proxy(self) -> str:
        """YouTube 在用的代理地址（专用地址优先；未勾选则空串 = 直连）。"""
        if not self.use_proxy_youtube:
            return ""
        return (self.proxy_youtube or "").strip() or (self.proxy or "").strip()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self.normalized())


def _clamp(value: Any, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return low
    return max(low, min(high, number))


class SettingsStore:
    """settings.json + cookie.json 的读写；Cookie 单独存放并限制权限。"""

    def __init__(self, root: Path | None = None) -> None:
        self.dir = root or app_dir()
        self.path = self.dir / "settings.json"
        self.cookie_path = self.dir / "cookie.txt"
        self._settings = self._load()

    def _load(self) -> Settings:
        data: dict[str, Any] = {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
        except (OSError, json.JSONDecodeError):
            data = {}
        known = {f.name for f in fields(Settings)}
        clean = {k: v for k, v in data.items() if k in known}
        return Settings(**clean).normalized()

    def get(self) -> Settings:
        return self._settings

    def save(self, patch: dict[str, Any]) -> Settings:
        known = {f.name for f in fields(Settings)}
        merged = asdict(self._settings)
        for key, value in (patch or {}).items():
            if key in known and value is not None:
                merged[key] = value
        self._settings = Settings(**merged).normalized()
        payload = json.dumps(asdict(self._settings), ensure_ascii=False, indent=2)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(payload + "\n", encoding="utf-8")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
        return self._settings

    # -------------------------------------------------------------- Cookie
    def load_cookie(self) -> str:
        try:
            return self.cookie_path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def save_cookie(self, cookie: str) -> None:
        cookie = (cookie or "").strip()
        self.cookie_path.parent.mkdir(parents=True, exist_ok=True)
        if not cookie:
            if self.cookie_path.exists():
                self.cookie_path.unlink()
            return
        self.cookie_path.write_text(cookie + "\n", encoding="utf-8")
        try:
            os.chmod(self.cookie_path, 0o600)
        except OSError:
            pass


def var_hints() -> dict[str, Any]:
    """重命名变量提示，供 WebUI 直接渲染。"""
    from .naming import OPUS_VARS, READLIST_VARS, VIDEO_VARS, YT_VIDEO_VARS

    def render(vars_map: dict[str, str]) -> list[dict[str, str]]:
        return [
            {"var": f"<{key}>", "plain": f"${{{key}}}", "desc": desc, "key": key}
            for key, desc in vars_map.items()
        ]

    return {
        "video": render(VIDEO_VARS),
        "opus": render(OPUS_VARS),
        "readlist": render(READLIST_VARS),
        "youtube": render(YT_VIDEO_VARS),
        "app": APP_NAME,
    }
