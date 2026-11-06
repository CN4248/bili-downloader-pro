#!/usr/bin/env python3
"""任务队列控制：暂停 / 继续 / 取消（单个、多选、全部）与持久化。

跑法（项目根目录，不联网、不启动服务）：
    python3 tests/queue_control_test.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bilidl.config import SettingsStore          # noqa: E402
from bilidl.downloader import Engine            # noqa: E402
from bilidl.server import Api                   # noqa: E402

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


def add_videos(engine: Engine, n: int) -> list[str]:
    targets = [
        {"bvid": f"BV1{i:09d}", "cid": i, "page_index": i, "video_title": f"测试{i}"}
        for i in range(1, n + 1)
    ]
    return asyncio.run(engine.add_video_targets(targets))


def close(engine: Engine) -> None:
    asyncio.run(engine.close())


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        # ------------------------------------------------ 全部暂停 / 全部开始
        e = build(root / "a")
        ids = add_videos(e, 3)
        check("新增任务默认 pending", all(e.tasks[t].status == "pending" for t in ids))
        check("新增任务进入 asyncio 队列", e.queue.qsize() == 3 and e._queued == set(ids))

        n = e.pause(all_=True)
        check("全部暂停数量", n == 3, n)
        check("全部暂停后状态为 paused", all(e.tasks[t].status == "paused" for t in ids))
        check("暂停的任务不会被 worker 取走", not any(e._take(t) for t in ids))
        check("暂停不清空 asyncio 队列（靠 _take 跳过）", e.queue.qsize() == 3, e.queue.qsize())

        n = e.resume(all_=True)
        check("全部开始数量", n == 3, n)
        check("全部开始后回到 pending", all(e.tasks[t].status == "pending" for t in ids))
        check("继续时不会重复入队", e.queue.qsize() == 3, e.queue.qsize())

        # worker 取走一条后，恢复那个任务应该重新补进队列（且只补一次）
        taken = e.queue.get_nowait()
        e._queued.discard(taken)
        e.queue.task_done()
        e.tasks[taken].status = "paused"
        check("继续单个任务返回 1", e.resume([taken]) == 1)
        check("继续后重新入队", e.queue.qsize() == 3 and taken in e._queued, e.queue.qsize())
        check("同一任务重复继续不会重复入队", e.resume([taken]) == 0 and e.queue.qsize() == 3)

        # 单个暂停 / 重复 id 去重
        check("单个暂停", e.pause([ids[1]]) == 1 and e.tasks[ids[1]].status == "paused")
        check("重复 id 只算一次", e.pause([ids[2], ids[2]]) == 1)
        check("对已暂停任务再暂停返回 0", e.pause([ids[1]]) == 0)

        # ------------------------------------------------ 下载中的任务暂停
        running = ids[0]
        e.tasks[running].status = "running"
        e._active.add(running)
        check("暂停下载中任务返回 1", e.pause([running]) == 1)
        check("下载中任务先打暂停标记", running in e.pause_flags)
        check("_should_stop 认暂停标记", e._should_stop(e.tasks[running]))
        check("_stop_reason 认暂停", e._stop_reason(running) == "pause")
        asyncio.run(e._run_task(running, e.tasks[running], e.specs[running]))
        check("worker 退出后落成 paused", e.tasks[running].status == "paused", e.tasks[running].status)
        e._active.discard(running)
        e.pause_flags.discard(running)

        # ------------------------------------------------ 取消（单个 / 多选 / 全部）
        n = e.cancel_many([ids[1], ids[2]])
        check("多选取消数量", n == 2, n)
        check("多选取消状态", [e.tasks[t].status for t in (ids[1], ids[2])] == ["canceled", "canceled"])
        check("取消已暂停任务会清掉暂停标记", ids[1] not in e.pause_flags)
        check("对已取消任务再取消返回 0", e.cancel_many([ids[1]]) == 0)

        e.tasks[running].status = "running"
        e._active.add(running)
        check("取消下载中任务", e.cancel_many([running]) == 1)
        check("下载中任务打取消标记", running in e.cancel_flags and e._stop_reason(running) == "cancel")
        e._active.discard(running)
        e.cancel_flags.discard(running)

        removed = e.cancel_all()
        check("取消全部移除任务", removed == 3 and e.tasks == {} and e.order == [], removed)
        check("取消全部清空队列与标记", e.queue.qsize() == 0 and not e._queued and not e.pause_flags)
        check("空队列暂停/继续都返回 0", e.pause(all_=True) == 0 and e.resume(all_=True) == 0)
        close(e)

        # ------------------------------------------------ 暂停状态持久化
        e = build(root / "b")
        pids = add_videos(e, 2)
        e.pause([pids[0]])
        saved = json.loads((root / "b" / "queue.json").read_text(encoding="utf-8"))
        statuses = {t["id"]: t["status"] for t in saved["tasks"]}
        check("queue.json 记录 paused", statuses.get(pids[0]) == "paused", statuses)
        close(e)

        e2 = build(root / "b")
        e2._load_queue()
        check("重启后仍保留 paused", e2.tasks[pids[0]].status == "paused", e2.tasks[pids[0]].status)
        check("重启后 pending 正常恢复", e2.tasks[pids[1]].status == "pending")
        check("重启后只恢复 pending 任务", e2.queue.qsize() == 1, e2.queue.qsize())
        check("暂停任务重启后不占用队列", e2._queued == {pids[1]}, e2._queued)
        # 重启后「全部开始」能把暂停任务接着排上
        check("重启后继续暂停任务", e2.resume(all_=True) == 1 and e2.queue.qsize() == 2, e2.queue.qsize())
        close(e2)

        # ------------------------------------------------ HTTP 路由（无运行中的 loop，直接执行）
        e3 = build(root / "c")
        rids = add_videos(e3, 2)
        loop = asyncio.new_event_loop()
        try:
            obj = Api(SettingsStore(root / "c"), e3, loop)
            check("API pause all", obj.post("/api/tasks/pause", {"all": True})["paused"] == 2)
            check("API pause 单个状态", e3.tasks[rids[0]].status == "paused")
            check("API resume ids", obj.post("/api/tasks/resume", {"ids": [rids[0]]})["resumed"] == 1)
            check("API resume 后回到 pending", e3.tasks[rids[0]].status == "pending")
            check("API cancel ids", obj.post("/api/tasks/cancel", {"ids": rids})["count"] == 2)
            check("API cancel 后状态", e3.tasks[rids[1]].status == "canceled")
            check("API cancel 单个仍返回 id", obj.post("/api/tasks/cancel", {"id": rids[0]})["canceled"] == rids[0])
        finally:
            loop.close()
            close(e3)

        # ------------------------------------------------ HTTP 路由（真实事件循环线程）
        e4 = build(root / "d")
        tids = add_videos(e4, 2)
        loop2 = asyncio.new_event_loop()
        th = threading.Thread(target=loop2.run_forever, daemon=True)
        th.start()
        try:
            obj = Api(SettingsStore(root / "d"), e4, loop2)
            check("loop 线程中全部暂停", obj.post("/api/tasks/pause", {"all": True})["paused"] == 2)
            check("loop 线程中暂停状态", all(e4.tasks[t].status == "paused" for t in tids))
            check("loop 线程中单个继续", obj.post("/api/tasks/resume", {"ids": [tids[0]]})["resumed"] == 1)
            check("loop 线程中继续后 pending", e4.tasks[tids[0]].status == "pending")
            check("loop 线程中多选取消", obj.post("/api/tasks/cancel", {"ids": tids})["count"] == 2)
            check("loop 线程中取消状态", all(e4.tasks[t].status == "canceled" for t in tids))
        finally:
            loop2.call_soon_threadsafe(loop2.stop)
            th.join(timeout=5)
            loop2.close()
            close(e4)

    print(f"queue_control_test: {PASS}/{PASS + len(FAIL)} PASS")
    for item in FAIL:
        print("  FAIL:", item)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    raise SystemExit(main())
