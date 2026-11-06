"""「取消全部」必须直接把任务从队列里删掉，而不是留下 canceled 占位。

跑法（项目根目录，只跑这一个用例，不联网）：
    python3 tests/cancel_all_test.py
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


class CancelAllTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        store = SettingsStore(self.root / "data")
        store.save({"video_dir": str(self.root / "dl"), "concurrency": 1})
        self.engine = Engine(store)

    def tearDown(self):
        asyncio.run(self.engine.close())
        self.tmp.cleanup()

    def _add(self, n: int) -> list[str]:
        targets = [
            {"bvid": f"BV1{i:09d}", "cid": i, "page_index": i, "video_title": f"测试{i}"}
            for i in range(1, n + 1)
        ]
        return asyncio.run(self.engine.add_video_targets(targets))

    def test_cancel_all_removes_every_task(self):
        ids = self._add(3)
        self.assertEqual(len(ids), 3)
        self.assertEqual(len(self.engine.tasks), 3)
        self.assertEqual(self.engine.queue.qsize(), 3)

        removed = self.engine.cancel_all()

        self.assertEqual(removed, 3)
        self.assertEqual(self.engine.tasks, {})
        self.assertEqual(self.engine.order, [])
        self.assertEqual(self.engine.specs, {})
        self.assertEqual(self.engine.queue.qsize(), 0)
        self.assertEqual(self.engine.snapshot()["tasks"], [])
        self.assertEqual(self.engine.snapshot()["stats"]["pending"], 0)

    def test_cancel_all_is_idempotent(self):
        self._add(2)
        self.assertEqual(self.engine.cancel_all(), 2)
        self.assertEqual(self.engine.cancel_all(), 0)
        self.assertEqual(self.engine.tasks, {})

    def test_new_tasks_can_be_added_after_cancel(self):
        self._add(2)
        self.engine.cancel_all()
        ids = self._add(1)
        self.assertEqual(len(ids), 1)
        self.assertEqual(len(self.engine.tasks), 1)
        self.assertEqual(self.engine.queue.qsize(), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
