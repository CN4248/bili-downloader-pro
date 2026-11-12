#!/usr/bin/env python3
"""抖音 / 小红书「已知作品 ID」直建任务：不联网、毫秒级、与 B站 videos 载荷同速。

油猴推送版多选发送时走 /api/download 的 social 数组；服务端只写队列 + spec，
真实标题 / 流地址由 worker 下载前再补（和 B站 的 lazy cid 一个思路）。
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
        # 1) 抖音视频：没有 kind 提示时按视频建
        ids = await engine.add_social_targets([
            {
                "source": "douyin",
                "ident": "7318693128016252212",
                "web_url": "https://www.douyin.com/video/7318693128016252212",
                "title": "测试抖音",
            }
        ])
        o, f = check("抖音直建任务", len(ids) == 1, str(ids))
        ok += o; fail += f
        spec = engine.specs[ids[0]]
        o, f = check("抖音 spec 记录来源与地址",
                     spec["source"] == "douyin" and spec["share_url"].endswith("7318693128016252212"),
                     str(spec))
        ok += o; fail += f
        o, f = check("抖音任务默认是 video", engine.tasks[ids[0]].kind == "video", engine.tasks[ids[0]].kind)
        ok += o; fail += f

        # 2) 小红书图文：带 sub_kind=opus → 图文任务，token 跟着 spec 走
        ids2 = await engine.add_social_targets([
            {
                "source": "xhs",
                "ident": "6acb1701000000000a0242d6",
                "sub_kind": "opus",
                "web_url": "https://www.xiaohongshu.com/explore/6acb1701000000000a0242d6?xsec_token=T",
                "xsec_token": "T",
            }
        ])
        o, f = check("小红书图文直建任务", len(ids2) == 1, str(ids2))
        ok += o; fail += f
        o, f = check("小红书图文任务 kind=opus", engine.tasks[ids2[0]].kind == "opus", engine.tasks[ids2[0]].kind)
        ok += o; fail += f
        o, f = check("xsec_token 写进 spec", engine.specs[ids2[0]]["xsec_token"] == "T")
        ok += o; fail += f

        # 3) 去重：同一作品重复推送不再建任务
        ids3 = await engine.add_social_targets([
            {"source": "xhs", "ident": "6acb1701000000000a0242d6", "sub_kind": "opus"}
        ])
        o, f = check("同作品去重", ids3 == [], str(ids3))
        ok += o; fail += f

        # 4) 非法来源直接忽略
        ids4 = await engine.add_social_targets([{"source": "vimeo", "ident": "123"}])
        o, f = check("未知来源忽略", ids4 == [], str(ids4))
        ok += o; fail += f

        # 5) 建任务不做网络请求：pending 任务立刻可查
        o, f = check("任务进入 pending 队列",
                     engine.tasks[ids[0]].status == "pending" and ids[0] in engine._queued)
        ok += o; fail += f
        await engine.close()

    print(f"\n{ok} passed, {fail} failed")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
