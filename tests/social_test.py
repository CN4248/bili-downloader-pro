"""抖音 / 小红书 解析的纯函数单测（不联网）。

跑法（项目根目录）：
    python3 tests/social_test.py

覆盖：
  1. links.classify 能识别抖音 / 小红书长链与短链；
  2. 清晰度标签到抖音 ratio 的映射；
  3. 抖音分享页 `window._ROUTER_DATA` 与小红书 `window.__INITIAL_STATE__` 的提取；
  4. 抖音图集的 play_addr 是实况照片占位时，不能当成作品视频；
  5. 超长中文标题按 UTF-8 字节截断，不会触发 ENAMETOOLONG。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl import links, naming, social  # noqa: E402


class ClassifyTest(unittest.TestCase):
    def test_douyin_long(self):
        ref = links.classify("https://www.douyin.com/video/7318693128016252212")
        self.assertEqual(ref.kind, "douyin")
        self.assertEqual(ref.ident, "7318693128016252212")

    def test_douyin_note(self):
        ref = links.classify("https://www.douyin.com/note/7469411074119322899")
        self.assertEqual(ref.kind, "douyin")
        self.assertEqual(ref.ident, "7469411074119322899")

    def test_douyin_short(self):
        ref = links.classify("https://v.douyin.com/iLkweNS1/")
        self.assertEqual(ref.kind, "short")
        self.assertEqual(ref.extra.get("site"), "douyin")

    def test_xhs_explore_keeps_token(self):
        url = (
            "https://www.xiaohongshu.com/explore/6aaf5cfb000000002b000454"
            "?xsec_token=TESTTOKEN1234567890=&xsec_source=pc_feed"
        )
        ref = links.classify(url)
        self.assertEqual(ref.kind, "xhs")
        self.assertEqual(ref.ident, "6aaf5cfb000000002b000454")
        self.assertTrue(ref.extra.get("xsec_token"))

    def test_xhs_short(self):
        ref = links.classify("https://xhslink.com/a/abcDEF")
        self.assertEqual(ref.kind, "short")
        self.assertEqual(ref.extra.get("site"), "xhs")

    def test_bilibili_unchanged(self):
        ref = links.classify("https://www.bilibili.com/video/BV1xx411c7mD?p=2")
        self.assertEqual(ref.kind, "video")
        self.assertEqual(ref.ident, "BV1xx411c7mD")


class RatioTest(unittest.TestCase):
    def test_quality_to_ratio(self):
        self.assertEqual(social.ratio_for_quality("4K"), "1080p")
        self.assertEqual(social.ratio_for_quality("1080P60"), "1080p")
        self.assertEqual(social.ratio_for_quality("720P"), "720p")
        self.assertEqual(social.ratio_for_quality("480P"), "540p")
        self.assertEqual(social.ratio_for_quality("360P"), "360p")


class DouyinParseTest(unittest.TestCase):
    def _page(self, item: dict) -> str:
        payload = {"loaderData": {"video_(id)/page": {"videoInfoRes": {"item_list": [item]}}}}
        return "<script>window._ROUTER_DATA = " + json.dumps(payload) + "</script><script>x</script>"

    def test_router_item(self):
        page = self._page({"aweme_id": "1", "desc": "标题"})
        self.assertEqual(social._router_item(social._router_data(page))["aweme_id"], "1")

    def test_gallery_has_no_video_url(self):
        item = {
            "aweme_id": "7469411074119322899",
            "desc": "图集",
            "author": {"nickname": "kamada", "uid": "u1"},
            "images": [{"url_list": ["https://p3-sign.douyinpic.com/a.webp"]}],
            # 实况照片的占位音频，uri 是 http 地址
            "video": {"play_addr": {"uri": "https://lf3.example/audio.mp3"}},
        }
        detail = social._douyin_detail(item, "1080p")
        self.assertEqual(detail["kind"], "opus")
        self.assertEqual(detail["video_url"], "")
        self.assertEqual(len(detail["images"]), 1)

    def test_video_url_uses_play_api(self):
        item = {
            "aweme_id": "7318693128016252212",
            "desc": "视频",
            "author": {"nickname": "大碗姐"},
            "video": {"play_addr": {"uri": "v0200fg10000abc", "url_list": ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=x"]},
                      "duration": 35665},
        }
        detail = social._douyin_detail(item, "1080p")
        self.assertEqual(detail["kind"], "video")
        self.assertIn("aweme/v1/play/?video_id=v0200fg10000abc", detail["video_url"])
        self.assertEqual(detail["duration"], 35)


class XhsParseTest(unittest.TestCase):
    def test_initial_state(self):
        html = '<script>window.__INITIAL_STATE__ = {"note": {"noteDetailMap": {}}}</script><script>y</script>'
        self.assertIn("noteDetailMap", json.dumps(social._initial_state(html)))

    def test_file_id_to_original_image(self):
        url = social._xhs_image_url({"fileId": "notes_pre_post/1040g3k0abc"})
        self.assertTrue(url.startswith("https://sns-img-qc.xhscdn.com/notes_pre_post/1040g3k0abc"))

    def test_strip_image_transform(self):
        url = social._strip_image_transform("https://sns-webpic-qc.xhscdn.com/a/b.webp!nd_dft_wlteh_webp_3")
        self.assertEqual(url, "https://sns-webpic-qc.xhscdn.com/a/b.webp")

    def test_video_stream_prefers_h264(self):
        video = {"media": {"stream": {
            "h264": [{"masterUrl": "http://sns-video-v2.xhscdn.com/a.mp4", "height": 1080}],
            "h265": [{"masterUrl": "http://sns-video-v2.xhscdn.com/b.mp4", "height": 1080}],
        }}}
        url, label = social._xhs_stream_url(video)
        self.assertIn("/a.mp4", url)
        self.assertEqual(label, "1080P")


class LongNameTest(unittest.TestCase):
    def test_truncate_bytes(self):
        long_title = "说唱" * 120
        rel = naming.build_relative("<video_title>-<video_id>.<ext>", {"video_title": long_title, "video_id": "7318693"}, "mp4")
        self.assertLessEqual(len(rel.name.encode("utf-8")), 200)
        self.assertTrue(rel.name.endswith(".mp4"))

    def test_sanitize_keeps_short_name(self):
        self.assertEqual(naming.sanitize("短标题.mp4", "mp4"), "短标题.mp4")


if __name__ == "__main__":
    unittest.main(verbosity=2)
