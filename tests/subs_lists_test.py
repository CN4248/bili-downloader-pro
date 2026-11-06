"""合集订阅 + 批量操作单测（全部离线，用假作品/假引擎）。

跑法（项目根目录）：
    python3 tests/subs_lists_test.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.subs import Subscriber  # noqa: E402


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.logs = []

    async def add_video_idents(self, idents, *, all_pages=True, directory="", template="", sub_id=""):
        self.calls.append((list(idents), bool(all_pages)))
        return {"tasks": list(idents), "failed": [], "count": len(idents)}

    def log(self, msg, kind="info"):
        self.logs.append((kind, msg))


def works(*specs):
    """specs: (ident, pubdate)，顺序按「合集顺序（旧→新）」。"""
    return [SimpleNamespace(ident=i, title=f"作品{i}", pubdate=p, duration=60) for i, p in specs]


class ListsSubscriptionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = FakeEngine()
        self.sub = Subscriber(self.engine, Path(self.tmp.name) / "subs.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_start_downloads_whole_collection_in_order(self):
        # _fetch 交给 _candidates 的顺序是「新→旧」
        ws = works(("V3", 300), ("V2", 200), ("V1", 100))
        picked, baseline = self.sub._candidates("video", ws, {"since": "", "seen": []}, "lists")
        self.assertFalse(baseline)
        self.assertEqual([w.ident for w in picked], ["V1", "V2", "V3"])

    def test_start_inside_collection_is_inclusive(self):
        ws = works(("V4", 400), ("V3", 300), ("V2", 200), ("V1", 100))
        picked, _ = self.sub._candidates("video", ws, {"since": "V2", "seen": []}, "lists")
        self.assertEqual([w.ident for w in picked], ["V2", "V3", "V4"])

    def test_lists_kind_survives_reload(self):
        raw = {"kind": "lists", "mid": "601598", "target": "6413356", "name": "合集测试"}
        sub = self.sub._normalize_sub(raw)
        self.assertEqual(sub["kind"], "lists")
        self.assertEqual(sub["target"], "6413356")
        self.assertEqual(sub["mid"], "601598")

    def test_up_without_start_still_baseline(self):
        ws = works(("V1", 100), ("V2", 200))
        picked, baseline = self.sub._candidates("video", ws, {"since": "", "seen": []}, "up")
        self.assertTrue(baseline)
        self.assertEqual(picked, [])

    def test_scan_creates_tasks_for_all_parts(self):
        ws = works(("V3", 300), ("V2", 200), ("V1", 100))
        ch = {"since": "", "since_time": 0, "seen": [], "dir": "", "filters": {}, "enabled": True}
        self.sub.data["max_new"] = 2

        async def fake_fetch(kind, sub, stop):
            return ws, "合集测试"

        self.sub._fetch = fake_fetch
        n, msg = asyncio.run(self.sub._scan_channel({"id": "s1", "kind": "lists"}, "video", ch))
        self.assertEqual(n, 2)
        self.assertEqual(self.engine.calls, [(["V1", "V2"], True)])   # 第一批：合集最前面两个，且 all_pages=True
        self.assertEqual(ch["seen"], ["V1", "V2"])
        self.assertIn("新增 2 个作品", msg)


class BatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = FakeEngine()
        self.sub = Subscriber(self.engine, Path(self.tmp.name) / "subs.json")
        self.sub.data["subs"] = [
            {"id": "a", "enabled": True},
            {"id": "b", "enabled": False},
            {"id": "c", "enabled": True},
            {"id": "d", "enabled": True},
        ]

    def tearDown(self):
        self.tmp.cleanup()

    def test_disable(self):
        r = self.sub.batch({"action": "disable", "ids": ["a", "c"]})
        self.assertEqual(r["count"], 2)
        self.assertEqual([s["enabled"] for s in self.sub.data["subs"]], [False, False, False, True])

    def test_enable(self):
        r = self.sub.batch({"action": "enable", "ids": ["b", "d"]})
        self.assertEqual(r["count"], 2)
        self.assertTrue(all(s["enabled"] for s in self.sub.data["subs"]))

    def test_delete(self):
        r = self.sub.batch({"action": "delete", "ids": ["a", "c"]})
        self.assertEqual(r["count"], 2)
        self.assertEqual([s["id"] for s in self.sub.data["subs"]], ["b", "d"])

    def test_bad_action(self):
        with self.assertRaises(Exception):
            self.sub.batch({"action": "boom", "ids": ["a"]})

    def test_no_selection(self):
        with self.assertRaises(Exception):
            self.sub.batch({"action": "enable", "ids": []})


if __name__ == "__main__":
    unittest.main(verbosity=2)
