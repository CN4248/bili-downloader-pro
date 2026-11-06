"""对最终产物（Windows exe / WebUI 服务）跑一遍验收测试。

用法：
    python final_test.py http://127.0.0.1:2197 /tmp/dltest

覆盖：
  1) UP 主 100001 全部图文作品：检索 + 批量下载；
  2) 视频 BV1TEST0001；
  3) 图文 1187271566475395078（普通 6 图）；
  4) 图文 1257520704352419856（100+ 图）。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:2197"
ROOT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/dltest")
VIDEO_DIR = ROOT / "video"
OPUS_DIR = ROOT / "opus"

VIDEO = "BV1TEST0001"
OPUS_NORMAL = "1187271566475395078"
OPUS_BIG = "1257520704352419856"
MID = "100001"


def post(client: httpx.Client, path: str, body: dict) -> dict:
    resp = client.post(BASE + path, json=body, timeout=120)
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"POST {path} 失败：{data}")
    return data["data"]


def get(client: httpx.Client, path: str, **params) -> dict:
    resp = client.get(BASE + path, params=params, timeout=120)
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"GET {path} 失败：{data}")
    return data["data"]


def wait_tasks(client: httpx.Client, label: str, timeout: float = 900) -> list:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        state = get(client, "/api/tasks")
        stats = state["stats"]
        line = (
            f"{label}: done={stats['done']} skip={stats['skipped']} "
            f"err={stats['error']} run={stats['running']} wait={stats['pending']}"
        )
        if line != last:
            print("  " + line, flush=True)
            last = line
        if stats["running"] == 0 and stats["pending"] == 0:
            return state["tasks"]
        time.sleep(2)
    raise TimeoutError(f"{label} 超时")


def wait_scan(client: httpx.Client, job: str, timeout: float = 600) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = get(client, f"/api/space/scan/{job}")
        print(
            f"  检索中 status={state.get('status')} 视频={state.get('video_count')} 图文={state.get('opus_count')}",
            flush=True,
        )
        if state.get("status") in {"done", "finished", "error", "canceled"}:
            return state
        time.sleep(3)
    raise TimeoutError("检索超时")


def count_files(path: Path, *suffixes: str) -> int:
    if not path.exists():
        return 0
    return sum(
        1
        for p in path.rglob("*")
        if p.is_file() and (not suffixes or p.suffix.lower() in suffixes)
    )


def main() -> int:
    ROOT.mkdir(parents=True, exist_ok=True)
    client = httpx.Client()
    results: list[tuple[str, bool, str]] = []

    health = get(client, "/api/health")
    print("健康检查：", health, flush=True)

    post(client, "/api/settings", {"settings": {"video_dir": str(VIDEO_DIR), "opus_dir": str(OPUS_DIR)}})
    print(f"下载目录：视频 {VIDEO_DIR} / 图文 {OPUS_DIR}", flush=True)

    # ---------------------------------------------------------------- 1) 视频
    try:
        post(client, "/api/download", {"video_idents": [VIDEO]})
        tasks = wait_tasks(client, "视频")
        ok = all(t["status"] in {"done", "skipped"} for t in tasks)
        files = sorted(p.name for p in VIDEO_DIR.glob("*") if p.is_file())
        detail = f"{len(files)} 个文件；样例：{files[:1]}；任务数 {len(tasks)}"
        results.append(("BV1TEST0001 视频", ok and bool(files), detail))
    except Exception as exc:  # noqa: BLE001
        results.append(("BV1TEST0001 视频", False, repr(exc)))

    # ------------------------------------------------------- 2) 普通图文作品
    try:
        info = post(client, "/api/parse", {"text": f"https://www.bilibili.com/opus/{OPUS_NORMAL}"})
        item = info["items"][0]
        post(client, "/api/download", {"opus": [{"oid": OPUS_NORMAL, "sub_kind": item.get("sub_kind", "opus")}]})
        wait_tasks(client, "图文6图")
        n = count_files(OPUS_DIR)
        results.append((f"opus {OPUS_NORMAL}（{item.get('image_count')} 图）", n > 0, f"目录内图片 {n} 个"))
    except Exception as exc:  # noqa: BLE001
        results.append((f"opus {OPUS_NORMAL}", False, repr(exc)))

    # ------------------------------------------------------- 3) 100+ 图图文
    try:
        info = post(client, "/api/parse", {"text": f"https://www.bilibili.com/opus/{OPUS_BIG}"})
        item = info["items"][0]
        expected = int(item.get("image_count") or 0)
        before = count_files(OPUS_DIR)
        post(client, "/api/download", {"opus": [{"oid": OPUS_BIG, "sub_kind": item.get("sub_kind", "opus")}]})
        wait_tasks(client, "图文100图")
        after = count_files(OPUS_DIR)
        results.append(
            (
                f"opus {OPUS_BIG}（{expected} 图）",
                after - before >= expected,
                f"新增 {after - before} 张（期望 {expected}）",
            )
        )
    except Exception as exc:  # noqa: BLE001
        results.append((f"opus {OPUS_BIG}", False, repr(exc)))

    # ------------------------------------------- 4) UP 主全部图文（检索+下载）
    try:
        job = post(client, "/api/space/scan", {"mid": MID, "tabs": ["opus"], "max_pages": 60})["job"]
        state = wait_scan(client, job)
        works = state.get("opus") or []
        print(f"检索到图文 {len(works)} 个，开始批量下载", flush=True)
        before = count_files(OPUS_DIR)
        post(
            client,
            "/api/download",
            {
                "opus": [
                    {"oid": str(w.get("ident") or w.get("opus_id") or ""), "sub_kind": "opus"}
                    for w in works
                    if str(w.get("ident") or w.get("opus_id") or "").isdigit()
                ]
            },
        )
        tasks = wait_tasks(client, "UP图文", timeout=1800)
        failed = [t for t in tasks if t["status"] == "error"]
        after = count_files(OPUS_DIR)
        results.append(
            (
                f"UP {MID} 全部图文 {len(works)} 个",
                len(works) > 0 and not failed,
                f"新增 {after - before} 张；失败任务 {len(failed)}",
            )
        )
        for task in failed[:5]:
            print("  失败：", task.get("title"), task.get("error"), flush=True)
    except Exception as exc:  # noqa: BLE001
        results.append((f"UP {MID} 全部图文", False, repr(exc)))

    print("\n================ 验收结果 ================", flush=True)
    all_ok = True
    for name, ok, detail in results:
        all_ok = all_ok and ok
        print(f"[{'通过' if ok else '失败'}] {name} —— {detail}", flush=True)
    print("=========================================", flush=True)
    print("总计：" + ("全部通过" if all_ok else "存在失败项"), flush=True)
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
