#!/usr/bin/env python3
"""「点推送立刻建任务」：视频任务延迟补 cid / 标题的回归测试。

背景：add_video_idents / add_video_targets 以前在**创建任务时**调 api.video_info 补 cid，
而 B站 接口有 1.2s+ 的全局间隔；油猴一次推送 20 个视频要 20 多秒才出现任务，
用户看到的是「点了推送没反应」。现在改成：

1. 建任务只入库、立即入队，cid 先留 0（任务列表马上出现，标题用页面上的）；
2. worker 真正开始下载前，_resolve_video_spec 才调一次接口补 cid / 真标题；
3. all_pages 时把同一视频的其余分P 补成独立任务。

跑法（项目根目录，不联网、不启动服务）：
    python3 tests/lazy_video_test.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bilidl import api as api_mod                 # noqa: E402
from bilidl.config import SettingsStore          # noqa: E402
from bilidl.downloader import Engine             # noqa: E402

PASS = 0
FAIL: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    global PASS
    if cond:
        PASS += 1
    else:
        FAIL.append(f"{name} -> {detail!r}")


def build(root: Path) -> Engine:
    store = SettingsStore(root)
    store.save({"video_dir": str(root / "dl"), "concurrency": 1})
    return Engine(store)


def fake_info(ident: str, *, pages: int = 1, title: str = "真实标题", bvid: str = "BV1real000001"):
    return types.SimpleNamespace(
        bvid=bvid,
        title=title,
        pages=[
            types.SimpleNamespace(cid=100 + i, index=i + 1, title=f"第{i + 1}P")
            for i in range(pages)
        ],
        author="测试UP",
        pubdate=1700000000,
        mid=123456,
        season_id="",
        season_title="",
        season_episodes=[],
    )


class Counter:
    def __init__(self, info):
        self.calls: list[str] = []
        self.info = info

    async def __call__(self, session, ident):
        self.calls.append(str(ident))
        return self.info


def main() -> int:
    real_video_info = api_mod.video_info
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            # ------------------------------------------------ 1) 建任务不联网
            counter = Counter(fake_info("BV1xxxxxxxxx"))
            api_mod.video_info = counter
            e = build(root / "a")
            ids = asyncio.run(e.add_video_idents(["BV1xxxxxxxxx"]))
            check("add_video_idents 立即返回 1 个任务", ids["count"] == 1 and len(ids["tasks"]) == 1, ids)
            task = e.tasks[ids["tasks"][0]]
            spec = e.specs[task.id]
            check("创建阶段没有调接口补 cid", counter.calls == [], counter.calls)
            check("任务已入队（pending）", task.status == "pending" and e.queue.qsize() == 1, task.status)
            check("cid 暂为 0、标记 lazy", spec["cid"] == 0 and spec["lazy"] is True, spec)

            # ------------------------------------------------ 2) 开始时补详情
            asyncio.run(e._resolve_video_spec(task, spec))
            check("解析只调一次接口", counter.calls == ["BV1xxxxxxxxx"], counter.calls)
            check("解析后写入 cid / 标题", spec["cid"] == 100 and task.title == "真实标题", (spec["cid"], task.title))
            check("解析后 lazy 关闭、BV 归一", spec["lazy"] is False and spec["bvid"] == "BV1real000001", spec)
            check("副标题带 P1 与分P标题", task.subtitle.startswith("P1"), task.subtitle)

            # 重复调用是幂等的（worker 重试 / 暂停恢复）
            asyncio.run(e._resolve_video_spec(task, spec))
            check("已解析的任务不再调接口", counter.calls == ["BV1xxxxxxxxx"], counter.calls)

            # ------------------------------------------------ 3) all_pages 补分P
            counter2 = Counter(fake_info("BV1multi0001", pages=3, title="多P视频", bvid="BV1multi0001"))
            api_mod.video_info = counter2
            e2 = build(root / "b")
            ids2 = asyncio.run(e2.add_video_idents(["BV1multi0001"]))
            tid2 = ids2["tasks"][0]
            asyncio.run(e2._resolve_video_spec(e2.tasks[tid2], e2.specs[tid2]))
            specs = list(e2.specs.values())
            check("all_pages 后共 3 个分P任务", len(specs) == 3, len(specs))
            check("其余分P 都带 cid 和正确的序号", sorted(s["cid"] for s in specs) == [100, 101, 102], [s["cid"] for s in specs])
            check("分P 任务带 P2/P3 副标题", sorted(e2.tasks[t].subtitle[:2] for t in e2.specs) == ["P1", "P2", "P3"], "subs")

            # ------------------------------------------------ 4) videos 推送带标题
            counter3 = Counter(fake_info("BV1titled001", title="接口标题"))
            api_mod.video_info = counter3
            e3 = build(root / "c")
            tid3 = asyncio.run(e3.add_video_targets([{"bvid": "BV1titled001", "video_title": "卡片标题", "all_pages": False}]))
            t3 = e3.tasks[tid3[0]]
            check("videos 推送直接用卡片标题、不调接口", t3.title == "卡片标题" and counter3.calls == [], (t3.title, counter3.calls))
            asyncio.run(e3._resolve_video_spec(t3, e3.specs[t3.id]))
            check("开始下载后标题更新为接口标题", t3.title == "接口标题", t3.title)

            # ------------------------------------------------ 5) 显式 cid 不受影响
            counter4 = Counter(fake_info("BV1explicit01"))
            api_mod.video_info = counter4
            e4 = build(root / "d")
            tid4 = asyncio.run(e4.add_video_targets([{"bvid": "BV1explicit01", "cid": 777, "page_index": 2, "video_title": "已解析"}]))
            check("带 cid 的任务仍是显式分P", e4.specs[tid4[0]]["cid"] == 777 and e4.specs[tid4[0]]["lazy"] is False, e4.specs[tid4[0]])
            asyncio.run(e4._resolve_video_spec(e4.tasks[tid4[0]], e4.specs[tid4[0]]))
            check("带 cid 的任务不会重复调接口", counter4.calls == [], counter4.calls)
    finally:
        api_mod.video_info = real_video_info

    print(f"\nPASS {PASS} / FAIL {len(FAIL)}")
    for name in FAIL:
        print("  FAIL", name)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    raise SystemExit(main())
