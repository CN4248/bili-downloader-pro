#!/usr/bin/env python3
"""任务队列跨容器重启持久化：pending 重新入队，running 标记中断，done/error 保留。"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bilidl.config import SettingsStore          # noqa: E402
from bilidl.downloader import Engine, Task      # noqa: E402


def make_task(tid: str, status: str) -> Task:
    return Task(
        id=tid, kind="video", title=f"任务-{tid}", subtitle="", ident=tid,
        status=status, total_items=1,
    )


def main() -> int:
    ok = 0
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        e = Engine(SettingsStore(root))
        pending = make_task("pending-1", "pending")
        running = make_task("running-1", "running")
        done = make_task("done-1", "done")
        for t in (pending, running, done):
            e._new_task(t)
            e.specs[t.id] = {"kind": "video", "title": t.title, "ident": t.ident}
        e._persist()

        saved = json.loads((root / "queue.json").read_text(encoding="utf-8"))
        assert len(saved["tasks"]) == 3, saved
        assert (root / "queue.json").is_file()
        ok += 1

        e2 = Engine(SettingsStore(root))
        e2._load_queue()
        assert e2.order == ["pending-1", "running-1", "done-1"], e2.order
        assert e2.tasks["pending-1"].status == "pending"
        assert e2.queue.qsize() == 1, e2.queue.qsize()
        assert e2.tasks["running-1"].status == "error"
        assert "重启" in e2.tasks["running-1"].error
        assert e2.tasks["done-1"].status == "done"
        ok += 1

        # 损坏的 queue.json 不应阻止服务启动
        (root / "queue.json").write_text("{broken", encoding="utf-8")
        e3 = Engine(SettingsStore(root))
        e3._load_queue()
        assert e3.tasks == {} and e3.order == []
        ok += 1

        # 空文件/无文件同样安全
        (root / "queue.json").unlink()
        e4 = Engine(SettingsStore(root))
        e4._load_queue()
        assert e4.tasks == {}
        ok += 1

    print(f"queue_persist_test: {ok}/4 PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
