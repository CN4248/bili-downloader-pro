"""设置项的单测（只用标准库，不联网）。

跑法（项目根目录）：
    python3 tests/settings_test.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bilidl.config import Settings, SettingsStore  # noqa: E402


class AudioFormatTest(unittest.TestCase):
    def test_default_is_m4a(self):
        self.assertEqual(Settings().normalized().audio_format, "m4a")

    def test_mp3_case_insensitive(self):
        for value in ("mp3", "MP3", "Mp3"):
            self.assertEqual(Settings(audio_format=value).normalized().audio_format, "mp3")

    def test_unknown_falls_back_to_m4a(self):
        for value in ("flac", "", "wav", None):
            self.assertEqual(Settings(audio_format=value).normalized().audio_format, "m4a")

    def test_dict_exposes_field(self):
        self.assertEqual(Settings(audio_format="mp3").to_dict()["audio_format"], "mp3")

    def test_store_persists_and_reloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "data"
            store = SettingsStore(root)
            self.assertEqual(store.get().audio_format, "m4a")
            store.save({"audio_format": "mp3"})
            self.assertEqual(store.get().audio_format, "mp3")
            raw = json.loads((root / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(raw["audio_format"], "mp3")
            # 模拟容器重启：重新读盘
            self.assertEqual(SettingsStore(root).get().audio_format, "mp3")
            # 旧配置文件里没有这个字段时，回落 m4a，不会报错
            (root / "settings.json").write_text('{"quality": "720P"}', encoding="utf-8")
            self.assertEqual(SettingsStore(root).get().audio_format, "m4a")


if __name__ == "__main__":
    unittest.main(verbosity=2)
