"""重命名规则的单测（只用标准库，不联网）。

跑法（项目根目录）：
    python3 tests/naming_test.py

重点覆盖：
  1. 模板里的 `/` 才建子文件夹；
  2. 标题等变量值里的 `/`（B站 很常见：`【官方广播剧/中文字幕】`）要变成 `_`，不能多一层目录；
  3. 缺失变量的残渣（`-`、`_`）与目录穿越照旧被清掉。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.naming import build_filename, build_relative  # noqa: E402

TEMPLATE = "<videolist_title>/<video_title>-<video_id>-<video_episode>.<ext>"
TITLE = "【官方广播剧/中文字幕】为这位深闺门主献上约会！Vol.29"


def mapping(**extra):
    base = {
        "video_title": TITLE,
        "video_id": "BV1V7nU6mE24",
        "video_episode": "1",
        "video_page_title": TITLE,
        "video_author": "UP",
        "video_date": "20260101",
        "video_quality": "1080P60",
        "video_author_uid": "42",
        "videolist_title": "碧蓝档案-角色广播剧",
        "videolist_order": "1",
        "videolist_id": "4104277",
    }
    base.update(extra)
    return base


class BuildRelativeTest(unittest.TestCase):
    def test_title_slash_does_not_create_folder(self):
        rel = build_relative(TEMPLATE, mapping(), "mp4")
        self.assertEqual(len(rel.parts), 2, rel)
        self.assertEqual(rel.parts[0], "碧蓝档案-角色广播剧")
        self.assertIn("【官方广播剧_中文字幕】", rel.parts[1])
        self.assertNotIn("/", rel.parts[1])
        self.assertTrue(rel.name.endswith("-BV1V7nU6mE24-1.mp4"))

    def test_template_slash_still_creates_folder(self):
        rel = build_relative("合集/<video_id>/<video_title>.<ext>", mapping(video_title="a/b"), "mp4")
        self.assertEqual(rel.parts[0], "合集")
        self.assertEqual(rel.parts[1], "BV1V7nU6mE24")
        self.assertEqual(rel.parts[2], "a_b.mp4")

    def test_backslash_in_value(self):
        rel = build_relative("<video_title>.<ext>", mapping(video_title="a\\b"), "mp4")
        self.assertEqual(rel.parts, ("a_b.mp4",))

    def test_missing_season_leaves_no_residue(self):
        rel = build_relative(
            TEMPLATE,
            mapping(videolist_title="", videolist_order="", videolist_id=""),
            "mp4",
        )
        self.assertEqual(len(rel.parts), 1, rel)
        self.assertFalse(rel.name.startswith(("-", "_")), rel.name)
        self.assertNotIn("__", rel.name)

    def test_traversal_is_flattened(self):
        rel = build_relative(TEMPLATE, mapping(video_title="../../etc/passwd"), "mp4")
        self.assertEqual(len(rel.parts), 2, rel)
        self.assertNotIn("..", rel.parts)

    def test_dot_segments_from_template_are_dropped(self):
        rel = build_relative("../<video_id>.<ext>", mapping(), "mp4")
        self.assertEqual(rel.parts, ("BV1V7nU6mE24.mp4",))

    def test_chinese_alias(self):
        rel = build_relative("<视频标题>-<视频BV号>.<ext>", mapping(), "mp4")
        self.assertTrue(rel.name.startswith("【官方广播剧_中文字幕】"))
        self.assertTrue(rel.name.endswith("-BV1V7nU6mE24.mp4"))

    def test_build_filename_has_no_separator(self):
        name = build_filename(TEMPLATE, mapping(), "mp4")
        self.assertNotIn("/", name)
        self.assertIn("【官方广播剧_中文字幕】", name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
