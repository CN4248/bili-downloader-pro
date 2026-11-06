"""opus/detail 返回 item=null + fallback 时的回归测试。

真实案例：https://www.bilibili.com/opus/1066072524289212420
接口返回 {"item": null, "fallback": {"type": 2, "id": "41645323"}}；
旧代码直接抛「图文不存在或已被删除」，但 /opus 页面 SSR 里仍有完整 modules。

跑法：python3 -m unittest tests.opus_fallback_test -v
"""

import unittest
from unittest.mock import patch

from bilidl import api
from bilidl.models import OpusInfo


class FakeSession:
    async def get(self, *args, **kwargs):
        return {
            "data": {
                "item": None,
                "fallback": {"type": 2, "id": "41645323"},
            }
        }


class OpusFallbackTest(unittest.IsolatedAsyncioTestCase):
    async def test_fallback_to_html_when_item_null(self):
        info = OpusInfo(
            oid="1066072524289212420",
            kind="opus",
            title="赛马娘 无声铃鹿（画师emyo27）",
            author="-蓝眼睛的爱丽丝-",
            mid="6089321",
            pubdate=0,
            cover="https://i0.hdslb.com/bfs/new_dyn/9710fb21e94fe680e59b8a20ec976a016089321.jpg",
            text="",
            images=[{"url": f"https://i0.hdslb.com/bfs/new_dyn/{i}.jpg", "width": 0, "height": 0} for i in range(52)],
            url="https://www.bilibili.com/opus/1066072524289212420",
        )

        async def fake_html(session, oid):
            self.assertEqual(oid, "1066072524289212420")
            return info

        with patch.object(api, "opus_from_html", fake_html):
            got = await api.opus_detail(FakeSession(), "1066072524289212420")

        self.assertEqual(got.oid, "1066072524289212420")
        self.assertEqual(len(got.images), 52)
        self.assertEqual(got.title, "赛马娘 无声铃鹿（画师emyo27）")

    async def test_still_not_found_when_html_has_no_detail(self):
        async def fake_html(session, oid):
            raise api.NotFound("图文不存在或已被删除")

        with patch.object(api, "opus_from_html", fake_html):
            with self.assertRaises(api.NotFound):
                await api.opus_detail(FakeSession(), "1066072524289212420")


if __name__ == "__main__":
    unittest.main()
