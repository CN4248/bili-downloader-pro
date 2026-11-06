"""订阅目标归一化单测：贴完整链接也能正确存成接口需要的 ID。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.subs import Subscriber, _norm_target  # noqa: E402


class NormTargetTest(unittest.TestCase):
    def test_lists_url(self):
        self.assertEqual(
            _norm_target("lists", "https://space.bilibili.com/100001/lists/6413356?type=season"),
            "6413356",
        )
        self.assertEqual(_norm_target("lists", "https://space.bilibili.com/100001/lists/6413356"), "6413356")
        self.assertEqual(_norm_target("lists", "6413356"), "6413356")

    def test_bangumi_variants(self):
        self.assertEqual(_norm_target("bangumi", "https://www.bilibili.com/bangumi/play/ss42295"), "42295")
        self.assertEqual(_norm_target("bangumi", "https://www.bilibili.com/bangumi/play/ep123456"), "ep123456")
        self.assertEqual(_norm_target("bangumi", "ss42295"), "42295")
        self.assertEqual(_norm_target("bangumi", "ep123456"), "ep123456")
        self.assertEqual(_norm_target("bangumi", "42295"), "42295")

    def test_fav_variants(self):
        self.assertEqual(_norm_target("fav", "https://www.bilibili.com/medialist/detail/ml45073815"), "45073815")
        self.assertEqual(_norm_target("fav", "https://www.bilibili.com/medialist/detail/ml45073815?type=1"), "45073815")
        self.assertEqual(_norm_target("fav", "45073815"), "45073815")

    def test_readlist_normalized(self):
        self.assertEqual(_norm_target("readlist", "https://www.bilibili.com/read/readlist/rl1099181"), "rl1099181")
        self.assertEqual(_norm_target("readlist", "RL1099181"), "rl1099181")

    def test_normalize_sub_repairs_stored_url(self):
        sub = Subscriber(None, Path(tempfile.mkdtemp()) / "subs.json")
        fixed = sub._normalize_sub({"kind": "lists", "target": "https://space.bilibili.com/1/lists/2"})
        self.assertEqual(fixed["target"], "2")
        fixed = sub._normalize_sub({"kind": "bangumi", "target": "https://www.bilibili.com/bangumi/play/ep99"})
        self.assertEqual(fixed["target"], "ep99")


class FakeEngine:
    def __init__(self, root: Path):
        from bilidl.config import SettingsStore

        self.store = SettingsStore(root / "data")
        self.calls = []

    async def add_video_idents(self, idents, **kw):
        self.calls.append(list(idents))
        return {"count": len(idents)}

    async def add_opus_targets(self, targets, **kw):
        return [f"t{i}" for i in range(len(targets))]

    def log(self, *args, **kwargs):
        pass


class UpsertTargetTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sub = Subscriber(FakeEngine(self.root), self.root / "subs.json")

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_lists_url_gets_lid_and_mid(self):
        got = await self.sub.upsert(
            {
                "kind": "lists",
                "target": "https://space.bilibili.com/100001/lists/6413356?type=season",
                "url": "https://space.bilibili.com/100001/lists/6413356?type=season",
                "name": "测试合集",
                "video": {"enabled": True},
            }
        )
        self.assertEqual(got["target"], "6413356")
        self.assertEqual(got["mid"], "100001")

    async def test_bangumi_ep_link(self):
        got = await self.sub.upsert(
            {
                "kind": "bangumi",
                "target": "https://www.bilibili.com/bangumi/play/ep123456",
                "name": "测试番剧",
                "video": {"enabled": True},
            }
        )
        self.assertEqual(got["target"], "ep123456")
        self.assertEqual(got["mid"], "")

    async def test_lists_target_url_only_gets_mid(self):
        got = await self.sub.upsert(
            {
                "kind": "lists",
                "target": "https://space.bilibili.com/100001/lists/6413356?type=season",
                "name": "测试合集2",
                "video": {"enabled": True},
            }
        )
        self.assertEqual(got["target"], "6413356")
        self.assertEqual(got["mid"], "100001")

    async def test_fav_ml_link(self):
        got = await self.sub.upsert(
            {
                "kind": "fav",
                "target": "https://www.bilibili.com/medialist/detail/ml45073815",
                "name": "测试收藏夹",
                "video": {"enabled": True},
            }
        )
        self.assertEqual(got["target"], "45073815")


if __name__ == "__main__":
    unittest.main(verbosity=2)
