"""订阅「已下载文件按新规则改名」单测（离线）。

跑法（项目根目录）：
    python3 tests/subs_rename_test.py

覆盖：
* 引擎 spec 带上 sub_id，下载完成后回调把文件清单交给订阅；
* 订阅改重命名规则后，已下载文件按新规则重命名（含同名字幕/封面等附加文件）；
* 原文件不存在（作品被删/被手动移走）时保持原样，不报错；
* 改目录时既搬迁文件，也同步清单里的路径。
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.config import SettingsStore  # noqa: E402
from bilidl.downloader import Engine  # noqa: E402
from bilidl.subs import Subscriber  # noqa: E402


class FakeEngine:
    def __init__(self, root: Path):
        self.store = SettingsStore(root / "data")
        self.store.save(
            {
                "video_dir": str(root / "global-video"),
                "opus_dir": str(root / "global-opus"),
                "video_template": "<video_title>-<video_id>-<video_episode>.<ext>",
                "opus_template": "<opus_title>-<opus_id>-<opus_order>.<ext>",
                "readlist_template": "<readlist_title>/<readlist_order>-<opus_title>/<opus_id>-<opus_order>.<ext>",
            }
        )
        self.logs = []

    async def add_video_idents(self, idents, *, all_pages=True, directory="", template="", sub_id=""):
        return {"tasks": list(idents), "failed": [], "count": len(idents)}

    async def add_opus_targets(self, targets):
        return [f"t{i}" for i in range(len(targets))]

    def log(self, msg, kind="info"):
        self.logs.append((kind, msg))


class RenameTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.engine = FakeEngine(self.root)
        self.sub = Subscriber(self.engine, self.root / "subs.json")
        self.subid = asyncio.run(
            self.sub.upsert(
                {
                    "kind": "readlist",
                    "target": "rl1099181",
                    "name": "测试文集",
                    "opus": {"enabled": True},
                }
            )
        )["id"]

    def tearDown(self):
        self.tmp.cleanup()

    def _make_file(self, rel: str, text: str = "x") -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def _record(self, path: Path, variables: dict) -> None:
        self.sub.record_files(
            {"kind": "opus", "sub_id": self.subid},
            [{"path": str(path), "root": str(path.parent), "vars": variables}],
        )

    def test_record_and_relayout_readlist(self):
        old = self._make_file("old/测试文集/1-文章A/123-1.jpg")
        self._record(
            old,
            {
                "readlist_title": "测试文集",
                "readlist_id": "rl1099181",
                "readlist_order": "1",
                "opus_title": "文章A",
                "opus_id": "123",
                "opus_order": "1",
            },
        )
        ch = self.sub.data["subs"][0]["opus"]
        self.assertEqual(len(ch["files"]), 1)
        asyncio.run(
            self.sub.upsert(
                {
                    "id": self.subid,
                    "opus": {
                        "dir": str(self.root / "new"),
                        "template": "<readlist_title>/<opus_title>/<opus_id>-<opus_order>.<ext>",
                    },
                }
            )
        )
        target = self.root / "new/测试文集/文章A/123-1.jpg"
        self.assertTrue(target.is_file(), "文件应按新规则改名并移到新目录")
        self.assertFalse(old.exists())
        self.assertEqual(self.sub.data["subs"][0]["opus"]["files"][0]["path"], str(target))

    def test_sibling_files_renamed_together(self):
        old = self._make_file("dl/old-name.mp4")
        self._make_file("dl/old-name.nfo")
        self._make_file("dl/old-name.zh-CN.srt")
        self.sub.record_files(
            {"kind": "video", "sub_id": self.subid},
            [{"path": str(old), "root": str(old.parent), "vars": {"video_title": "标题", "video_id": "BV1", "video_episode": "1"}}],
        )
        asyncio.run(
            self.sub.upsert(
                {"id": self.subid, "video": {"template": "<video_title>.<ext>", "dir": str(self.root / "dl")}}
            )
        )
        self.assertTrue((self.root / "dl/标题.mp4").is_file())
        self.assertTrue((self.root / "dl/标题.nfo").is_file())
        self.assertTrue((self.root / "dl/标题.zh-CN.srt").is_file())

    def test_missing_file_is_left_alone(self):
        missing = self.root / "gone" / "x.jpg"
        self._record(
            missing,
            {"readlist_title": "测试文集", "readlist_order": "2", "opus_title": "文章B", "opus_id": "456", "opus_order": "1"},
        )
        asyncio.run(
            self.sub.upsert(
                {"id": self.subid, "opus": {"template": "<readlist_title>/<opus_title>/<opus_id>-<opus_order>.<ext>"}}
            )
        )
        # 原文件不存在：不抛错、清单保留原路径，等待以后再说
        self.assertEqual(self.sub.data["subs"][0]["opus"]["files"][0]["path"], str(missing))

    def test_empty_template_uses_global_default(self):
        old = self._make_file("dl/任意旧名.jpg")
        self._record(
            old,
            {"readlist_title": "测试文集", "readlist_order": "1", "opus_title": "文章A", "opus_id": "123", "opus_order": "1"},
        )
        asyncio.run(self.sub.upsert({"id": self.subid, "opus": {"template": "", "dir": str(self.root / "dl")}}))
        self.assertTrue((self.root / "dl/测试文集/1-文章A/123-1.jpg").is_file(), "应使用全局文集规则")

    def test_backfill_from_old_template_for_untracked_files(self):
        # 升级前下载的文件没有清单：先设目录，文件按旧规则放在目录里，再改规则应能反推并改名
        asyncio.run(self.sub.upsert({"id": self.subid, "opus": {"dir": str(self.root / "dl")}}))
        old = self._make_file("dl/测试文集/1-文章A/123-1.jpg")
        self._make_file("dl/测试文集/1-文章A/123-2.jpg")
        asyncio.run(
            self.sub.upsert(
                {"id": self.subid, "opus": {"template": "<readlist_title>/<opus_title>/<opus_id>-<opus_order>.<ext>"}}
            )
        )
        self.assertFalse(old.exists(), "旧路径应被改名")
        self.assertTrue((self.root / "dl/测试文集/文章A/123-1.jpg").is_file())
        self.assertTrue((self.root / "dl/测试文集/文章A/123-2.jpg").is_file())
        ch = self.sub.data["subs"][0]["opus"]
        self.assertEqual(ch["files_count"] if "files_count" in ch else len(ch["files"]), 2)

    def test_backfill_skipped_without_own_dir(self):
        # 订阅没设自己的目录（用全局）时不做回填，避免误伤全局目录里其它订阅的文件
        self._make_file("global-opus/测试文集/1-文章A/123-1.jpg")
        asyncio.run(self.sub.upsert({"id": self.subid, "opus": {"template": "<opus_title>.<ext>"}}))
        self.assertEqual(self.sub.data["subs"][0]["opus"]["files"], [])

    def test_dir_change_keeps_old_name_when_global_template_changed(self):
        # 落盘时的规则会被记住：之后只改目录、全局规则又变了，也不该擅自把旧文件改名
        old = self._make_file("dl/标题-BV1-1.mp4")
        self.sub.record_files(
            {"kind": "video", "sub_id": self.subid},
            [{
                "path": str(old),
                "root": str(old.parent),
                "tpl": "<video_title>-<video_id>-<video_episode>.<ext>",
                "vars": {"video_title": "标题", "video_id": "BV1", "video_episode": "1"},
            }],
        )
        self.engine.store.save({**self.engine.store.get().to_dict(), "video_template": "<video_title>.<ext>"})
        asyncio.run(self.sub.upsert({"id": self.subid, "video": {"dir": str(self.root / "moved")}}))
        self.assertTrue((self.root / "moved/标题-BV1-1.mp4").is_file(), "只改目录时沿用落盘时的规则")

    def test_engine_spec_carries_sub_id(self):
        store = SettingsStore(self.root / "eng")
        store.save({"video_dir": str(self.root / "v"), "opus_dir": str(self.root / "o")})
        engine = Engine(store)
        ids = asyncio.run(
            engine.add_video_targets(
                [{"bvid": "BV1xx411c7mD", "cid": 1, "video_title": "t", "sub_id": "s-1", "dir": "/x", "template": "a"}]
            )
        )
        self.assertEqual(engine.specs[ids[0]]["sub_id"], "s-1")
        self.assertEqual(engine.specs[ids[0]]["template"], "a")
        opus_ids = asyncio.run(
            engine.add_opus_targets([{"oid": "123", "sub_id": "s-2", "title": "t", "template": "b"}])
        )
        self.assertEqual(engine.specs[opus_ids[0]]["sub_id"], "s-2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
