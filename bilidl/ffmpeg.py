"""ffmpeg 探测与音视频合并。

没有 ffmpeg 时自动降级为 mp4 直链（清晰度通常不超过 720P），
从而保证程序在 Android / 精简环境下也能工作。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path

from .errors import DownloadError

_CANDIDATES = ("ffmpeg", "ffmpeg.exe")


def _search_paths() -> list[Path]:
    paths: list[Path] = []
    env = os.environ.get("BILIDL_FFMPEG", "").strip()
    if env:
        paths.append(Path(env))
    exe = shutil.which("ffmpeg")
    if exe:
        paths.append(Path(exe))
    bases: list[Path] = [Path(__file__).resolve().parent.parent]
    if getattr(sys, "frozen", False):
        bases.insert(0, Path(sys.executable).resolve().parent)
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            bases.insert(1, Path(meipass))
    bases.append(Path.cwd())
    for base in bases:
        for name in _CANDIDATES:
            paths.append(base / name)
            paths.append(base / "bin" / name)
            paths.append(base / "ffmpeg" / "bin" / name)
    return paths


def find_ffmpeg() -> str:
    """返回可用的 ffmpeg 路径，找不到返回空字符串。"""
    for path in _search_paths():
        try:
            if path.is_file() and os.access(path, os.X_OK):
                return str(path)
        except OSError:
            continue
    return ""


FFMPEG = find_ffmpeg()


def available() -> bool:
    return bool(FFMPEG)


async def merge(video: Path, audio: Path, output: Path) -> Path:
    """把 DASH 的视频流和音频流合并为一个 mp4。"""
    if not FFMPEG:
        raise DownloadError("未检测到 ffmpeg，无法合并音视频（请安装 ffmpeg 或选择 mp4 直链清晰度）")
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(video),
        "-i",
        str(audio),
        "-c",
        "copy",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-movflags",
        "+faststart",
        str(output),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = (stderr or b"").decode("utf-8", "ignore").strip().splitlines()
        raise DownloadError(f"ffmpeg 合并失败：{detail[-1] if detail else proc.returncode}")
    if not output.exists() or output.stat().st_size == 0:
        raise DownloadError("ffmpeg 合并后文件为空")
    return output


async def remux(source: Path, output: Path) -> Path:
    """不转码，把 B站 DASH 的分片 MP4 重封装成标准 mp4/m4a。

    DASH 音轨是 fragmented MP4（moof/mdat）。用 ffmpeg 合并出来的视频没问题，
    但「纯音频」是原样落盘的，某些播放器 / 电视 / 媒体库解不出这种音轨，
    表现为「文件有、时长也对，就是没有声音」。重封装一次兼容性最好。
    """
    if not FFMPEG:
        raise DownloadError("未检测到 ffmpeg，无法重封装音轨")
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        # ipod 复用器 = 标准 m4a（major_brand: M4A），比通用 isom 更贴合 .m4a 的播放器预期
        "-f",
        "ipod",
        str(output),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = (stderr or b"").decode("utf-8", "ignore").strip().splitlines()
        raise DownloadError(f"ffmpeg 重封装失败：{detail[-1] if detail else proc.returncode}")
    if not output.exists() or output.stat().st_size == 0:
        raise DownloadError("ffmpeg 重封装后文件为空")
    return output


async def transcode_audio(
    source: Path,
    output: Path,
    bitrate: str = "192k",
    meta: dict[str, str] | None = None,
) -> Path:
    """把任意音轨转成 MP3（44.1kHz / 192k CBR）。

    有些老电视、车机、媒体库没有 AAC 解码器：文件能识别、进度条也走，就是没声音。
    MP3 是兼容性最好的兜底格式，转码只在用户把「纯音频格式」设成 mp3 时发生。
    """
    if not FFMPEG:
        raise DownloadError("未检测到 ffmpeg，无法转码 MP3（请安装 ffmpeg 或把纯音频格式改回 m4a）")
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        "-ar",
        "44100",
        "-id3v2_version",
        "3",
    ]
    for key, value in (meta or {}).items():
        text = str(value or "").strip()
        if text:
            cmd += ["-metadata", f"{key}={text}"]
    cmd.append(str(output))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = (stderr or b"").decode("utf-8", "ignore").strip().splitlines()
        raise DownloadError(f"ffmpeg 转 MP3 失败：{detail[-1] if detail else proc.returncode}")
    if not output.exists() or output.stat().st_size == 0:
        raise DownloadError("ffmpeg 转 MP3 后文件为空")
    return output
