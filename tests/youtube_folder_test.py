#!/usr/bin/env python3
"""YouTube 落盘目录：多选批量时不能按「当前页面标题」建文件夹。

背景：油猴批量推送曾经把 document.title 当 season_title 传上来，
模板里只要有 <videolist_title>/ 就会给整批视频建一个「当前视频页命名」的文件夹。
现在的规则是——只有真的属于某个播放列表（带 season_id）才保留合辑名，
其余一律清空，文件落到视频目录根下（或按各自的 <video_author>/<video_title>/ 等变量）。

跑法（项目根目录，不联网、不启动服务）：
    python3 tests/youtube_folder_test.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bilidl.config import SettingsStore   # noqa: E402
from bilidl.downloader import Engine     # noqa: E402

PASS = 0
FAIL: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(f"{name} -> {detail!r}")
        print(f"  FAIL {name} -> {detail!r}")


async def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ytfolder-") as tmp:
        root = Path(tmp)
        store = SettingsStore(root)
        store.save({"video_dir": str(root / "dl")})
        engine = Engine(store)
        await engine.start()

        # 1) 旧版客户端：只给 season_title（当前页面标题），没有 season_id
        ids = await engine.add_youtube_targets([
            {"vid": "dQw4w9WgXcQ", "video_title": "Batch A",
             "season_title": "当前视频页面标题", "season_order": 3},
        ])
        spec = engine.specs[ids[0]]
        check("无 season_id 时 season_title 清空", spec["season_title"] == "", spec["season_title"])
        check("无 season_id 时 season_order 归零", spec["season_order"] == 0, spec["season_order"])

        # 2) 真播放列表：season_id + season_title 保留（模板想按列表建目录仍然有效）
        ids = await engine.add_youtube_targets([
            {"vid": "9bZkp7q19f0", "video_title": "Batch B",
             "season_id": "PLtest123", "season_title": "真实播放列表名", "season_order": 2},
        ])
        spec = engine.specs[ids[0]]
        check("有 season_id 时 season_title 保留", spec["season_title"] == "真实播放列表名", spec["season_title"])
        check("有 season_id 时 season_order 保留", spec["season_order"] == 2, spec["season_order"])

        # 3) 模板里的 <videolist_title>/ 在没列表时应被压掉，不会拼出以页面标题命名的目录
        from bilidl.naming import build_relative

        rel = build_relative("<videolist_title>/<video_title>-<video_id>.<ext>",
                             {"video_title": "Batch A", "video_id": "dQw4w9WgXcQ", "videolist_title": ""},
                             "mp4")
        check("空合辑名不产生空目录段", str(rel) == "Batch A-dQw4w9WgXcQ.mp4", str(rel))

        rel2 = build_relative("<videolist_title>/<video_title>.<ext>",
                              {"video_title": "Batch B", "videolist_title": "真实播放列表名"}, "mp4")
        check("有合辑名时仍按合辑建目录", str(rel2) == "真实播放列表名/Batch B.mp4", str(rel2))

        await engine.close()

    print(f"\nyoutube_folder_test: {PASS} passed, {len(FAIL)} failed")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
