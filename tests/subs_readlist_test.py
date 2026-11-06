"""文集订阅单测：首次建基线，之后新文章自动建图文任务（带 readlist 上下文）。

跑法（项目根目录，不联网）：
    python3 tests/subs_readlist_test.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.models import AuthorWork  # noqa: E402
from bilidl.subs import Subscriber  # noqa: E402


class FakeEngine:
    def __init__(self):
        self.opus = []

    async def add_opus_targets(self, targets):
        self.opus.append([dict(t) for t in targets])
        return [f"task{i}" for i in range(len(targets))]

    def log(self, msg, kind="info"):
        pass


def article(oid, title, order):
    return AuthorWork(
        kind="opus",
        ident=oid,
        title=title,
        pubdate=0,
        extra={"readlist": {"id": "rl1099181", "title": "夏莱的魅魔老师", "order": order}},
    )


class ReadlistSubscriptionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = FakeEngine()
        self.sub = Subscriber(self.engine, Path(self.tmp.name) / "subs.json")
        self.works = [article("1001", "第一话", 1), article("1002", "第二话", 2)]

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_scan_is_baseline(self):
        picked, baseline = self.sub._candidates(
            "opus", self.works, {"seen": [], "since": ""}, "readlist"
        )
        self.assertTrue(baseline)
        self.assertEqual(picked, [])

    def test_new_article_is_detected(self):
        works = self.works + [article("1003", "第三话", 3)]
        picked, baseline = self.sub._candidates(
            "opus", works, {"seen": ["1001", "1002"], "since": ""}, "readlist"
        )
        self.assertFalse(baseline)
        self.assertEqual([w.ident for w in picked], ["1003"])

    def test_since_downloads_from_that_article(self):
        picked, baseline = self.sub._candidates("opus", self.works, {"seen": [], "since": "1002"}, "readlist")
        self.assertFalse(baseline)
        self.assertEqual([w.ident for w in picked], ["1002"])

    def test_since_missing_article_downloads_nothing(self):
        picked, baseline = self.sub._candidates("opus", self.works, {"seen": [], "since": "9999"}, "readlist")
        self.assertFalse(baseline)
        self.assertEqual(picked, [])

    def test_baseline_message_mentions_pick_start(self):
        ch = {"seen": [], "since": "", "dir": "", "filters": {}, "enabled": True}

        async def fake_fetch(kind, sub, stop, max_pages=None):
            return self.works, "文集共 2 篇"

        self.sub._fetch = fake_fetch
        n, msg = asyncio.run(self.sub._scan_channel({"id": "s1", "kind": "readlist"}, "opus", ch))
        self.assertEqual(n, 0)
        self.assertIn("图文起点", msg)

    def test_scan_builds_opus_task_with_readlist_context(self):
        works = self.works + [article("1003", "第三话", 3)]
        ch = {"seen": ["1001", "1002"], "since": "", "dir": "/tmp/readlist", "filters": {}, "enabled": True}

        async def fake_fetch(kind, sub, stop):
            return works, "文集「夏莱的魅魔老师」共 3 篇"

        self.sub._fetch = fake_fetch
        n, msg = asyncio.run(self.sub._scan_channel({"id": "s1", "kind": "readlist"}, "opus", ch))
        self.assertEqual(n, 1)
        self.assertEqual(len(self.engine.opus), 1)
        target = self.engine.opus[0][0]
        self.assertEqual(target["oid"], "1003")
        self.assertEqual(target["sub_kind"], "opus")
        self.assertEqual(target["dir"], "/tmp/readlist")
        self.assertEqual(target["readlist"]["id"], "rl1099181")
        self.assertEqual(target["readlist"]["order"], 3)
        self.assertEqual(ch["seen"], ["1003", "1001", "1002"])
        self.assertIn("新增 1 个作品", msg)

    def test_scan_uses_opus_channel_only(self):
        calls = []

        async def fake_channel(sub, kind, ch):
            calls.append(kind)
            return 0, ""

        self.sub._scan_channel = fake_channel
        self.sub._save = lambda: None
        sub = {
            "id": "s1",
            "kind": "readlist",
            "name": "文集",
            "enabled": True,
            "video": {"enabled": False},
            "opus": {"enabled": True},
        }
        asyncio.run(self.sub._scan(sub))
        self.assertEqual(calls, ["opus"])

    def test_video_works_are_not_mixed_in(self):
        works = [article("1001", "第一话", 1)]
        picked, baseline = self.sub._candidates(
            "opus", works, {"seen": ["1001"], "since": ""}, "readlist"
        )
        self.assertFalse(baseline)
        self.assertEqual(picked, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
