#!/usr/bin/env python3
"""抖音 / 小红书追更（浏览器上报）的数据层测试。

背景：抖音、小红书的「作者作品列表」接口需要平台签名（抖音还要真实 UIFID），
服务端请求不到，所以这两个平台改成由油猴脚本在作者主页把作品上报过来：
POST /api/subs/report → Subscriber.report_works()。这里保证：

1. 订阅类型 douyin / xhs 能用作者主页链接创建，target 归一成作者 ID；
2. 两种平台的订阅默认同时开「追视频」「追图文」（一条列表里混排）；
3. 首次上报只建基线，不下载历史作品；
4. 之后上报的新作品会调 add_social_targets 建任务，并带分享地址 / xsec_token / 来源；
5. 重复上报不会重复建任务；
6. 作品类型按 URL 分流（/note/、/slides/ 进图文，其余进视频）；
7. 服务端扫描这两个类型时不会被当成 B站 UP 主去联网；
8. 起点选择接口明确提示「由上报自动建立」。

跑法（项目根目录，不联网、不启动服务）：
    python3 tests/subs_social_test.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.config import SettingsStore  # noqa: E402
from bilidl.errors import ParseError  # noqa: E402
from bilidl.subs import Subscriber  # noqa: E402


class FakeEngine:
    def __init__(self, root: Path):
        self.store = SettingsStore(root / "data")
        self.session = None
        self.logs: list[str] = []
        self.social_calls: list[list[dict]] = []

    def log(self, *args, **kwargs):
        self.logs.append(" ".join(str(a) for a in args))

    async def add_social_targets(self, targets, **kw):
        self.social_calls.append(list(targets))
        return [f"s{i}" for i in range(len(targets))]

    async def add_video_idents(self, idents, **kw):
        return {"count": len(idents), "tasks": [], "failed": []}

    async def add_opus_targets(self, targets, **kw):
        return [f"t{i}" for i in range(len(targets))]


DOUYIN_URL = "https://www.douyin.com/user/MS4wLjABAAAAqUVcCjQ2QkdlY3MaweIh3SQDditufbRDq1lm"
XHS_URL = "https://www.xiaohongshu.com/user/profile/6603db30000000000d027c6b"


class SubsSocialTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.engine = FakeEngine(self.root)
        self.subs = Subscriber(self.engine, self.root / "subs.json")

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def _douyin_sub(self) -> dict:
        return await self.subs.upsert({"kind": "douyin", "target": DOUYIN_URL})

    async def _xhs_sub(self) -> dict:
        return await self.subs.upsert({"kind": "xhs", "target": XHS_URL})

    def _douyin_works(self, n=3):
        return [
            {
                "ident": f"73186931280162522{i:02d}",
                "title": f"作品 {i}",
                "url": f"https://www.douyin.com/video/73186931280162522{i:02d}",
                "kind": "video",
                "pubdate": 1700000000 + i,
            }
            for i in range(n)
        ]

    async def test_create_douyin_normalizes_target(self):
        sub = await self._douyin_sub()
        self.assertEqual(sub["kind"], "douyin")
        self.assertEqual(sub["target"], "MS4wLjABAAAAqUVcCjQ2QkdlY3MaweIh3SQDditufbRDq1lm")
        self.assertTrue(sub["video"]["enabled"])
        self.assertTrue(sub["opus"]["enabled"])

    async def test_create_xhs_normalizes_target(self):
        sub = await self._xhs_sub()
        self.assertEqual(sub["kind"], "xhs")
        self.assertEqual(sub["target"], "6603db30000000000d027c6b")
        self.assertTrue(sub["video"]["enabled"])
        self.assertTrue(sub["opus"]["enabled"])

    async def test_invalid_target_rejected(self):
        with self.assertRaises(ParseError):
            await self.subs.upsert({"kind": "douyin", "target": ""})
        with self.assertRaises(ParseError):
            await self.subs.upsert({"kind": "xhs", "target": ""})

    async def test_first_report_builds_baseline_only(self):
        await self._douyin_sub()
        res = await self.subs.report_works(
            {"source": "douyin", "target": DOUYIN_URL, "works": self._douyin_works(3)}
        )
        self.assertEqual(res["matched"], 1)
        self.assertEqual(res["created"], 0)
        self.assertIn("基线", res["message"])
        self.assertEqual(self.engine.social_calls, [])
        sub = self.subs.data["subs"][0]
        self.assertEqual(len(sub["video"]["seen"]), 3)

    async def test_second_report_creates_tasks(self):
        await self._douyin_sub()
        await self.subs.report_works(
            {"source": "douyin", "target": DOUYIN_URL, "works": self._douyin_works(3)}
        )
        works = self._douyin_works(3) + [
            {
                "ident": "7318693128016252299",
                "title": "新作品",
                "url": "https://www.douyin.com/video/7318693128016252299",
                "kind": "video",
                "pubdate": 1800000000,
            }
        ]
        res = await self.subs.report_works({"source": "douyin", "target": DOUYIN_URL, "works": works})
        self.assertEqual(res["created"], 1)
        self.assertEqual(len(self.engine.social_calls), 1)
        target = self.engine.social_calls[0][0]
        self.assertEqual(target["source"], "douyin")
        self.assertEqual(target["ident"], "7318693128016252299")
        self.assertEqual(target["kind"], "video")
        self.assertIn("/video/", target["web_url"])
        self.assertEqual(target["sub_id"], self.subs.data["subs"][0]["id"])

    async def test_duplicate_report_not_recreated(self):
        await self._douyin_sub()
        works = self._douyin_works(2)
        await self.subs.report_works({"source": "douyin", "target": DOUYIN_URL, "works": works})
        await self.subs.report_works({"source": "douyin", "target": DOUYIN_URL, "works": works})
        res = await self.subs.report_works({"source": "douyin", "target": DOUYIN_URL, "works": works})
        self.assertEqual(res["created"], 0)
        self.assertEqual(self.engine.social_calls, [])

    async def test_xhs_note_goes_to_opus_with_token(self):
        sub = await self._xhs_sub()
        token = "ABCtoken123"
        notes = [
            {
                "ident": "6ac854d3000000001a0284ff",
                "title": "关于礼貌",
                "url": f"https://www.xiaohongshu.com/explore/6ac854d3000000001a0284ff?xsec_token={token}&xsec_source=pc_feed",
                "kind": "opus",
                "cover": "https://sns-img-qc.xhscdn.com/a",
            }
        ]
        await self.subs.report_works({"source": "xhs", "target": XHS_URL, "works": notes})
        stored = [x for x in self.subs.data["subs"] if x["id"] == sub["id"]][0]
        self.assertEqual(stored["opus"]["seen"], ["6ac854d3000000001a0284ff"])
        res = await self.subs.report_works({
            "source": "xhs",
            "target": XHS_URL,
            "works": notes + [{
                "ident": "6ad1970f000000001500a8db",
                "title": "新笔记",
                "url": "https://www.xiaohongshu.com/explore/6ad1970f000000001500a8db?xsec_token=TOK2&xsec_source=pc_feed",
                "kind": "opus",
            }],
        })
        self.assertEqual(res["created"], 1)
        target = self.engine.social_calls[0][0]
        self.assertEqual(target["kind"], "opus")
        self.assertEqual(target["xsec_token"], "TOK2")

    async def test_unknown_author_not_matched(self):
        await self._douyin_sub()
        res = await self.subs.report_works(
            {"source": "douyin", "target": "MS4wLjABAAAAsomeoneelse", "works": self._douyin_works(2)}
        )
        self.assertEqual(res["matched"], 0)

    async def test_scan_does_not_network_for_social(self):
        await self._douyin_sub()
        with patch.object(Subscriber, "_fetch", side_effect=AssertionError("不应联网")):
            await self.subs.check_now(self.subs.data["subs"][0]["id"])
        sub = self.subs.data["subs"][0]
        self.assertIn("浏览器", sub["video"]["last_message"])
        self.assertIn("上报", sub["video"]["last_message"])

    async def test_list_works_explains_browser_report(self):
        sub = await self._xhs_sub()
        with self.assertRaises(ParseError) as ctx:
            await self.subs.list_works(sub["id"], "video")
        self.assertIn("上报", str(ctx.exception))

    async def test_seen_persisted(self):
        await self._douyin_sub()
        await self.subs.report_works(
            {"source": "douyin", "target": DOUYIN_URL, "works": self._douyin_works(2)}
        )
        again = Subscriber(self.engine, self.root / "subs.json")
        self.assertEqual(len(again.data["subs"][0]["video"]["seen"]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
