#!/usr/bin/env python3
"""UP 主追更「追视频 / 追图文」随时开关的回归测试。

背景：订阅创建时只勾了视频，之后想补开图文（或临时关掉视频）时，旧 UI 没有入口，
只能删了重建。数据层本来就有 video/opus 两个 channel（各有 enabled），这里保证：

1. 创建时 video 开、opus 关；
2. 之后 upsert 只改 opus.enabled 就能开图文，video 不受影响；
3. 反过来关视频也不影响图文；
4. 开关不清空 seen —— 关掉再开不会把历史作品当新作品重下；
5. 两个都关时不会被调度、手动「立即检查」会明确报错；
6. 改动会落盘，重启后仍生效。

跑法（项目根目录，不联网、不启动服务）：
    python3 tests/subs_channels_test.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.errors import ParseError  # noqa: E402
from bilidl.subs import Subscriber  # noqa: E402


class FakeEngine:
    def __init__(self, root: Path):
        from bilidl.config import SettingsStore

        self.store = SettingsStore(root / "data")
        self.session = None
        self.logs: list[str] = []

    def log(self, *args, **kwargs):
        self.logs.append(" ".join(str(a) for a in args))

    async def add_video_idents(self, idents, **kw):
        return {"count": len(idents), "tasks": [], "failed": []}

    async def add_opus_targets(self, targets, **kw):
        return [f"t{i}" for i in range(len(targets))]


def fake_card(name="测试UP"):
    card = AsyncMock()
    card.return_value = {"name": name, "face": ""}
    return card


class SubChannelsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.engine = FakeEngine(self.root)
        self.subs = Subscriber(self.engine, self.root / "subs.json")
        self.card = fake_card()
        self.patcher = patch("bilidl.subs.api.user_card", self.card)
        self.patcher.start()

    async def asyncTearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    async def _create_video_only(self) -> dict:
        return await self.subs.upsert(
            {
                "kind": "up",
                "mid": "3546575051688471",
                "video": {"enabled": True},
                "opus": {"enabled": False},
            }
        )

    async def test_create_video_only_then_enable_opus(self):
        sub = await self._create_video_only()
        self.assertTrue(sub["video"]["enabled"])
        self.assertFalse(sub["opus"]["enabled"])

        # 之后随时补开图文：只发 id + opus.enabled，不重建
        got = await self.subs.upsert({"id": sub["id"], "opus": {"enabled": True}})
        self.assertTrue(got["opus"]["enabled"], "图文通道应已开启")
        self.assertTrue(got["video"]["enabled"], "开图文不应影响视频")
        self.assertEqual(got["id"], sub["id"], "仍是同一个订阅，不是新建")

    async def test_disable_video_keeps_opus(self):
        sub = await self._create_video_only()
        got = await self.subs.upsert({"id": sub["id"], "video": {"enabled": False}, "opus": {"enabled": True}})
        self.assertFalse(got["video"]["enabled"])
        self.assertTrue(got["opus"]["enabled"])

    async def test_toggle_keeps_seen_history(self):
        sub = await self._create_video_only()
        # 模拟已经追过一批图文
        live = next(s for s in self.subs.data["subs"] if s["id"] == sub["id"])
        live["opus"]["seen"] = ["1170527883436752897", "1135335093177417729"]
        live["opus"]["since"] = "1135335093177417729"

        await self.subs.upsert({"id": sub["id"], "opus": {"enabled": False}})
        got = await self.subs.upsert({"id": sub["id"], "opus": {"enabled": True}})
        self.assertEqual(got["opus"]["seen"], ["1170527883436752897", "1135335093177417729"], "开关不能清空 seen")
        self.assertEqual(got["opus"]["since"], "1135335093177417729", "开关不能清空起点")

    async def test_both_off_not_scheduled_and_check_rejected(self):
        sub = await self._create_video_only()
        await self.subs.upsert({"id": sub["id"], "video": {"enabled": False}})
        self.assertEqual(self.subs._next_run(), -1.0, "两个频道都关时不该进入调度")
        with self.assertRaises(ParseError):
            await self.subs.check_now(sub["id"])

        # 重新打开图文后应恢复调度
        await self.subs.upsert({"id": sub["id"], "opus": {"enabled": True}})
        self.assertGreaterEqual(self.subs._next_run(), 0.0)

    async def test_toggle_persists_across_reload(self):
        sub = await self._create_video_only()
        await self.subs.upsert({"id": sub["id"], "opus": {"enabled": True}})

        reloaded = Subscriber(self.engine, self.root / "subs.json")
        got = next(s for s in reloaded.data["subs"] if s["id"] == sub["id"])
        self.assertTrue(got["opus"]["enabled"], "重启后图文开关仍应开启")
        self.assertTrue(got["video"]["enabled"])

    async def test_new_opus_channel_starts_with_baseline(self):
        # 从未追过图文（seen 为空、无起点）时，第一次扫描只建基线，不补历史
        sub = await self._create_video_only()
        await self.subs.upsert({"id": sub["id"], "opus": {"enabled": True}})
        live = next(s for s in self.subs.data["subs"] if s["id"] == sub["id"])
        works = [type("W", (), {"ident": f"10000000000000000{i}", "title": f"w{i}", "pubdate": 0})() for i in range(3)]
        picked, baseline = self.subs._candidates("opus", works, live["opus"], "up")
        self.assertTrue(baseline, "空 seen 的图文通道首扫应该建基线")
        self.assertEqual(picked, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
