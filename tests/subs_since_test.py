"""定时追更「起点作品」语义单测：从起点开始（含起点本身）往新的方向下。

跑法（项目根目录，不联网）：
    python3 tests/subs_since_test.py
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


def works(*specs):
    """specs: (ident, pubdate) —— 按「新→旧」排列，和 B站 列表一致。"""
    return [SimpleNamespace(ident=i, title=f"作品{i}", pubdate=p, duration=60) for i, p in specs]


class FakeEngine:
    """只记 add_video_idents 的调用顺序，不真的建任务。"""

    def __init__(self):
        self.calls = []

    async def add_video_idents(self, idents, *, all_pages=True, directory="", template="", sub_id=""):
        self.calls.append(list(idents))
        return {"tasks": list(idents), "failed": [], "count": len(idents)}

    def log(self, *args, **kwargs):
        pass


class SinceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sub = Subscriber(None, Path(self.tmp.name) / "subs.json")

    def tearDown(self):
        self.tmp.cleanup()

    def candidates(self, ws, since="", since_time=0, seen=None):
        ch = {"since": since, "since_time": since_time, "seen": seen or []}
        return self.sub._candidates("video", ws, ch)

    def test_start_in_the_middle_is_included(self):
        ws = works(("W5", 500), ("W4", 400), ("W3", 300), ("W2", 200), ("W1", 100))
        picked, baseline = self.candidates(ws, since="W3")
        self.assertFalse(baseline)
        # 起点（W3）在，且排最前面；更早的 W2/W1 不在
        self.assertEqual([w.ident for w in picked], ["W3", "W4", "W5"])

    def test_start_is_newest(self):
        ws = works(("W3", 300), ("W2", 200), ("W1", 100))
        picked, _ = self.candidates(ws, since="W3")
        self.assertEqual([w.ident for w in picked], ["W3"])

    def test_start_is_oldest_downloads_whole_range(self):
        ws = works(("W3", 300), ("W2", 200), ("W1", 100))
        picked, _ = self.candidates(ws, since="W1")
        self.assertEqual([w.ident for w in picked], ["W1", "W2", "W3"])

    def test_start_work_is_first_for_max_new_slice(self):
        ws = works(*[(f"W{i}", i) for i in range(30, 0, -1)])
        picked, _ = self.candidates(ws, since="W1")
        self.assertEqual(picked[0].ident, "W1")          # 起点先下
        self.assertEqual(len(picked[:20]), 20)

    def test_seen_is_skipped_but_start_stays_when_not_seen(self):
        ws = works(("W3", 300), ("W2", 200), ("W1", 100))
        picked, _ = self.candidates(ws, since="W1", seen=["W2"])
        self.assertEqual([w.ident for w in picked], ["W1", "W3"])

    def test_since_time_fallback_inclusive(self):
        ws = works(("W4", 400), ("W3", 300), ("W2", 200), ("W1", 100))
        picked, _ = self.candidates(ws, since="GONE", since_time=300)
        self.assertEqual([w.ident for w in picked], ["W3", "W4"])

    def scan(self, ws, ch, engine, max_new=20):
        self.sub.engine = engine
        self.sub.data["max_new"] = max_new

        async def fake_fetch(kind, sub, stop):
            return ws, ""

        self.sub._fetch = fake_fetch
        n, msg = asyncio.run(self.sub._scan_channel({"id": "s1", "kind": "up"}, "video", ch))
        return n, msg, engine

    def test_scan_includes_start_first(self):
        ws = works(("W5", 500), ("W4", 400), ("W3", 300), ("W2", 200), ("W1", 100))
        ch = {"since": "W3", "since_time": 0, "seen": [], "dir": "", "filters": {}}
        eng = FakeEngine()
        n, msg, eng = self.scan(ws, ch, eng)
        self.assertEqual(n, 3)
        self.assertEqual(eng.calls, [["W3", "W4", "W5"]])   # 起点最先，按时间正序
        self.assertEqual(ch["seen"], ["W3", "W4", "W5"])
        self.assertIn("新增 3 个作品", msg)

    def test_scan_second_pass_downloads_nothing(self):
        ws = works(("W5", 500), ("W4", 400), ("W3", 300), ("W2", 200), ("W1", 100))
        ch = {"since": "W3", "since_time": 0, "seen": [], "dir": "", "filters": {}}
        eng = FakeEngine()
        self.scan(ws, ch, eng)
        n, msg, _ = self.scan(ws, ch, eng)
        self.assertEqual(n, 0)
        self.assertEqual(msg, "没有新作品")

    def test_scan_max_new_keeps_start(self):
        ws = works(*[(f"W{i}", i) for i in range(10, 0, -1)])
        ch = {"since": "W1", "since_time": 0, "seen": [], "dir": "", "filters": {}}
        eng = FakeEngine()
        n, _, eng = self.scan(ws, ch, eng, max_new=3)
        self.assertEqual(n, 3)
        self.assertEqual(eng.calls, [["W1", "W2", "W3"]])   # 起点在第一批里

    def test_no_start_is_baseline(self):
        ws = works(("W2", 200), ("W1", 100))
        picked, baseline = self.candidates(ws)
        self.assertTrue(baseline)
        self.assertEqual(picked, [])

    def test_after_baseline_new_work_is_downloaded(self):
        # 建过基线后，列表顶部新出现的作品要能自动下载
        ws = works(("W3", 300), ("W2", 200), ("W1", 100))
        picked, baseline = self.candidates(ws, seen=["W2", "W1"])
        self.assertFalse(baseline)
        self.assertEqual([w.ident for w in picked], ["W3"])

    def test_after_baseline_old_unseen_is_not_backlog(self):
        # 基线被 SEEN_LIMIT 截断：更旧、没进 seen 的作品不能被当成新作品重下
        ws = works(("W4", 400), ("W3", 300), ("W2", 200), ("W1", 100))
        picked, baseline = self.candidates(ws, seen=["W3", "W2"])
        self.assertFalse(baseline)
        self.assertEqual([w.ident for w in picked], ["W4"])

    def test_after_baseline_nothing_new(self):
        ws = works(("W2", 200), ("W1", 100))
        picked, baseline = self.candidates(ws, seen=["W2", "W1"])
        self.assertFalse(baseline)
        self.assertEqual(picked, [])

    def test_scan_after_baseline_downloads_new(self):
        ch = {"since": "", "since_time": 0, "seen": [], "dir": "", "filters": {}}
        eng = FakeEngine()
        n, msg, _ = self.scan(works(("W2", 200), ("W1", 100)), ch, eng)
        self.assertEqual(n, 0)
        self.assertIn("基线", msg)
        self.assertEqual(ch["seen"], ["W2", "W1"])
        eng2 = FakeEngine()
        n, msg, eng2 = self.scan(works(("W3", 300), ("W2", 200), ("W1", 100)), ch, eng2)
        self.assertEqual(n, 1)
        self.assertEqual(eng2.calls, [["W3"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
