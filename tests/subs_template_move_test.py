"""订阅自定义重命名规则 + 目录迁移单测（离线）。

跑法（项目根目录）：
    python3 tests/subs_template_move_test.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.config import SettingsStore  # noqa: E402
from bilidl.downloader import Engine  # noqa: E402
from bilidl.errors import ParseError  # noqa: E402
from bilidl.models import AuthorWork  # noqa: E402
from bilidl.subs import Subscriber  # noqa: E402


class FakeEngine:
    def __init__(self, root: Path):
        self.store = SettingsStore(root / "data")
        self.store.save({"video_dir": str(root / "global-video"), "opus_dir": str(root / "global-opus")})
        self.video_calls = []
        self.opus_calls = []
        self.logs = []

    async def add_video_idents(self, idents, *, all_pages=True, directory="", template="", sub_id=""):
        self.video_calls.append({"idents": list(idents), "all_pages": all_pages, "dir": directory, "template": template})
        return {"tasks": list(idents), "failed": [], "count": len(idents)}

    async def add_opus_targets(self, targets):
        self.opus_calls.append([dict(t) for t in targets])
        return [f"t{i}" for i in range(len(targets))]

    def log(self, msg, kind="info"):
        self.logs.append((kind, msg))


class MoveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.engine = FakeEngine(self.root)
        self.sub = Subscriber(self.engine, self.root / "subs.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_move_all_files_and_folders(self):
        old = self.root / "old"
        new = self.root / "new"
        (old / "合集A").mkdir(parents=True)
        (old / "a.m4a").write_bytes(b"a")
        (old / "合集A" / "b.png").write_bytes(b"b")
        moved = asyncio.run(self.sub._move_dir("video", str(old), str(new)))
        self.assertEqual(moved, 2)
        self.assertEqual((new / "a.m4a").read_bytes(), b"a")
        self.assertTrue((new / "合集A" / "b.png").is_file())
        self.assertFalse(old.exists())

    def test_existing_file_is_not_overwritten(self):
        old = self.root / "old"
        new = self.root / "new"
        old.mkdir(); new.mkdir()
        (old / "a.txt").write_text("old", encoding="utf-8")
        (new / "a.txt").write_text("new", encoding="utf-8")
        moved = asyncio.run(self.sub._move_dir("video", str(old), str(new)))
        self.assertEqual(moved, 1)
        self.assertEqual((new / "a.txt").read_text(encoding="utf-8"), "new")
        self.assertEqual((new / "a-1.txt").read_text(encoding="utf-8"), "old")

    def test_global_root_is_not_moved(self):
        root = self.root / "global-video"
        root.mkdir(parents=True)
        (root / "keep.txt").write_text("x", encoding="utf-8")
        moved = asyncio.run(self.sub._move_dir("video", str(root), str(self.root / "other")))
        self.assertEqual(moved, 0)
        self.assertTrue((root / "keep.txt").exists())
        self.assertTrue(any("未自动搬移" in m for _, m in self.engine.logs))

    def test_nested_paths_are_rejected(self):
        old = self.root / "old"
        old.mkdir()
        with self.assertRaises(ParseError):
            asyncio.run(self.sub._move_dir("video", str(old), str(old / "inside")))

    def test_empty_dirs_do_nothing(self):
        self.assertEqual(asyncio.run(self.sub._move_dir("video", "", str(self.root / "x"))), 0)
        self.assertEqual(asyncio.run(self.sub._move_dir("video", str(self.root / "y"), "")), 0)


class TemplateScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.engine = FakeEngine(self.root)
        self.sub = Subscriber(self.engine, self.root / "subs.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_video_scan_uses_sub_template(self):
        tpl = "<video_author>/<video_id>-<video_episode>.<ext>"
        ch = {"enabled": True, "dir": "/tmp/v", "template": tpl, "filters": {}, "since": "BV1", "seen": []}
        works = [SimpleNamespace(ident="BV1", title="标题", pubdate=1, duration=60)]

        async def fake_fetch(kind, sub, stop):
            return works, ""

        self.sub._fetch = fake_fetch
        asyncio.run(self.sub._scan_channel({"id": "s1", "kind": "up"}, "video", ch))
        self.assertEqual(self.engine.video_calls[0]["template"], tpl)
        self.assertTrue(self.engine.video_calls[0]["all_pages"])

    def test_opus_scan_uses_sub_template_and_readlist(self):
        tpl = "<readlist_title>/<readlist_order>-<opus_title>/<opus_id>.<ext>"
        ch = {"enabled": True, "dir": "/tmp/o", "template": tpl, "filters": {}, "since": "", "seen": ["1000"]}
        works = [
            AuthorWork(
                kind="opus", ident="1001", title="文章一", pubdate=0,
                extra={"readlist": {"id": "rl1", "title": "文集", "order": 1}},
            )
        ]

        async def fake_fetch(kind, sub, stop):
            return works, ""

        self.sub._fetch = fake_fetch
        asyncio.run(self.sub._scan_channel({"id": "s1", "kind": "readlist"}, "opus", ch))
        target = self.engine.opus_calls[0][0]
        self.assertEqual(target["template"], tpl)
        self.assertEqual(target["readlist"]["id"], "rl1")


class EngineTemplateSpecTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        store = SettingsStore(self.root / "data")
        store.save({"video_dir": str(self.root / "v"), "opus_dir": str(self.root / "o")})
        self.engine = Engine(store)

    def tearDown(self):
        asyncio.run(self.engine.close())
        self.tmp.cleanup()

    def test_video_spec_keeps_template(self):
        ids = asyncio.run(self.engine.add_video_targets([
            {"bvid": "BV1aaaaaaaaa", "cid": 1, "video_title": "t", "template": "<video_id>.<ext>"}
        ]))
        self.assertEqual(self.engine.specs[ids[0]]["template"], "<video_id>.<ext>")

    def test_opus_spec_keeps_template(self):
        ids = asyncio.run(self.engine.add_opus_targets([
            {"oid": "123456789", "sub_kind": "opus", "title": "t", "template": "<opus_id>.<ext>"}
        ]))
        self.assertEqual(self.engine.specs[ids[0]]["template"], "<opus_id>.<ext>")


if __name__ == "__main__":
    unittest.main(verbosity=2)
