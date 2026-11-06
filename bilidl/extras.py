"""附加文件：字幕 / 弹幕转 SRT、封面、NFO 元信息。

所有文件名都由视频重命名规则推导（ext 换成 srt/jpg/nfo/m4a），
用户只需要在设置页勾选想要哪种文件。
"""

from __future__ import annotations

import json
import re
from typing import Any

DEFAULT_EXTRAS: dict[str, bool] = {
    "audio_only": False,   # 纯音频（m4a）
    "video_only": False,   # 无声视频（不含音轨）
    "subtitle": False,     # 字幕 SRT
    "danmaku": False,      # 弹幕 SRT
    "cover": False,        # 封面图片
    "nfo": False,          # NFO 元信息
}

EXTRA_KEYS = tuple(DEFAULT_EXTRAS)

XML_ENTITY = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'"}


def normalize_extras(value: Any) -> dict[str, bool]:
    data = value if isinstance(value, dict) else {}
    return {key: bool(data.get(key)) for key in EXTRA_KEYS}


def _unescape(text: str) -> str:
    for raw, plain in XML_ENTITY.items():
        text = text.replace(raw, plain)
    return text


def _clock(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    hours, rest = divmod(int(seconds), 3600)
    minutes, secs = divmod(rest, 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis >= 1000:
        millis = 999
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _clean_line(text: str) -> str:
    return re.sub(r"\s+", " ", _unescape(text or "")).strip()


def subtitle_to_srt(payload: dict[str, Any]) -> str:
    """B 站字幕 JSON（body[{from,to,content}]）→ SRT。"""
    body = payload.get("body") if isinstance(payload, dict) else None
    rows: list[str] = []
    if isinstance(body, list):
        for index, item in enumerate(body, start=1):
            if not isinstance(item, dict):
                continue
            start = float(item.get("from") or 0)
            end = float(item.get("to") or start + 0.5)
            text = _clean_line(str(item.get("content") or ""))
            if not text:
                continue
            rows.append(f"{index}\n{_clock(start)} --> {_clock(end)}\n{text}\n")
    return "\n".join(rows)


DANMAKU_RE = re.compile(r'<d p="([^"]+)"[^>]*>(.*?)</d>', re.S)


def danmaku_to_srt(xml_text: str) -> str:
    """弹幕 XML（<d p="时间,模式,字号,颜色,...">文本</d>）→ SRT。"""
    rows: list[str] = []
    for index, match in enumerate(DANMAKU_RE.finditer(xml_text or ""), start=1):
        fields = (match.group(1) or "").split(",")
        try:
            start = float(fields[0])
        except (IndexError, ValueError):
            continue
        text = _clean_line(match.group(2))
        if not text:
            continue
        rows.append(f"{index}\n{_clock(start)} --> {_clock(start + 4.0)}\n{text}\n")
    return "\n".join(rows)


def build_nfo(info: dict[str, Any]) -> str:
    """生成 Kodi/Jellyfin 可读的 movie nfo。"""
    def esc(value: Any) -> str:
        text = str(value if value is not None else "")
        return (
            text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    title = esc(info.get("title"))
    plot = esc(info.get("desc"))
    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        "<movie>",
        f"  <title>{title}</title>",
        f"  <originaltitle>{title}</originaltitle>",
        f"  <showtitle>{title}</showtitle>",
    ]
    episode = str(info.get("episode") or "1")
    lines += [
        f"  <episode>{esc(episode)}</episode>",
        f"  <uniqueid type=\"bilibili\" default=\"true\">{esc(info.get('bvid'))}</uniqueid>",
        f"  <id>{esc(info.get('bvid'))}</id>",
    ]
    if info.get("author"):
        lines.append(f"  <director>{esc(info.get('author'))}</director>")
        lines.append(f"  <studio>{esc(info.get('author'))}</studio>")
    if info.get("date"):
        lines.append(f"  <premiered>{esc(info.get('date'))}</premiered>")
        lines.append(f"  <year>{esc(str(info.get('date'))[:4])}</year>")
    if info.get("cover"):
        lines.append(f"  <thumb aspect=\"poster\">{esc(info.get('cover'))}</thumb>")
    if plot:
        lines.append(f"  <plot>{plot}</plot>")
        lines.append(f"  <outline>{plot}</outline>")
    if info.get("duration"):
        lines.append(f"  <runtime>{esc(info.get('duration'))}</runtime>")
    lines.append("</movie>")
    return "\n".join(lines) + "\n"


def dump_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)
