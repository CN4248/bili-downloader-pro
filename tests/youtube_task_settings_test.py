#!/usr/bin/env python3
"""YouTube 单任务设置：清晰度 / 命名模板 / 子目录随 videos 载荷进 spec。

油猴的 YouTube 下载设置（清晰度、子目录、命名模板）按任务下发，
服务端 _download_youtube 优先用 spec["quality"]，没有才退回全局设置。
"""
import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bilidl.config import SettingsStore          # noqa: E402
from bilidl.downloader import Engine            # noqa: E402


def check(name: str, cond: bool, extra: str = "") -> tuple[int, int]:
    if cond:
        print(f"  ok  {name}")
        return 1, 0
    print(f"  FAIL {name}" + (f" :: {extra}" if extra else ""))
    return 0, 1


async def main() -> int:
    ok = fail = 0
    with tempfile.TemporaryDirectory() as tmp:
        engine = Engine(SettingsStore(Path(tmp)))
        ids = await engine.add_youtube_targets([
            {
                "bvid": "yHOGj2hS4gw",
                "source": "youtube",
                "video_title": "Cat video",
                "quality": "720P",
                "template": "YouTube/<video_title>-<video_id>.<ext>",
                "dir": "/tmp/downloads/YouTube",
            }
        ])
        o, f = check("YouTube 任务已创建", len(ids) == 1, str(ids)); ok += o; fail += f
        spec = engine.specs[ids[0]]
        o, f = check("spec 记录单任务清晰度", spec.get("quality") == "720P", str(spec.get("quality"))); ok += o; fail += f
        o, f = check("spec 记录命名模板", spec.get("template") == "YouTube/<video_title>-<video_id>.<ext>", str(spec.get("template"))); ok += o; fail += f
        o, f = check("spec 记录下载子目录", spec.get("dir") == "/tmp/downloads/YouTube", str(spec.get("dir"))); ok += o; fail += f

        ids2 = await engine.add_youtube_targets([{"bvid": "3URtTIdnXIk", "source": "youtube", "video_title": "No quality"}])
        spec2 = engine.specs[ids2[0]]
        o, f = check("未带清晰度时留空（回退全局）", spec2.get("quality") == "", repr(spec2.get("quality"))); ok += o; fail += f

        # 去重：同一 vid 再推不会重复建
        ids3 = await engine.add_youtube_targets([{"bvid": "yHOGj2hS4gw", "source": "youtube"}])
        o, f = check("同一视频去重", ids3 == [], str(ids3)); ok += o; fail += f

        await engine.close()

    print(f"\n{ok} passed, {fail} failed")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
