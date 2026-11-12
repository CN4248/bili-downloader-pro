#!/usr/bin/env python3
"""回归：旧动态转 opus（接口 item=null）走 HTML 兜底时，必须从 modules 取作者昵称。"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bilidl import api  # noqa: E402


class FakeResponse:
    def __init__(self, text: str):
        self.text = text


class FakeClient:
    async def get(self, *args, **kwargs):
        detail = {
            "id_str": "760502970183843896",
            "basic": {"uid": "397706516", "title": "测试图文"},
            "modules": [
                {"module_type": "MODULE_TYPE_AUTHOR",
                 "module_author": {"name": "美图分享师", "mid": 397706516, "pub_ts": 1700000000}},
                {"module_type": "MODULE_TYPE_CONTENT", "module_content": {"paragraphs": [
                    {"para_type": 2, "pic": {"pics": [
                        {"url": "//i0.hdslb.com/bfs/new_dyn/a.jpg", "width": 100, "height": 100}
                    ]}}
                ]}},
            ],
        }
        html = "<script>window.__INITIAL_STATE__=" + json.dumps({"detail": detail}) + ";</script>"
        return FakeResponse(html)


class FakeSession:
    client = FakeClient()


def main() -> int:
    # list 结构
    name, mid, pub = api._module_author([
        {"module_type": "MODULE_TYPE_AUTHOR",
         "module_author": {"name": "作者A", "mid": 123, "pub_ts": 1700000000}},
    ])
    assert (name, mid, pub) == ("作者A", "123", 1700000000), (name, mid, pub)
    # 旧版 dict 结构
    name, mid, pub = api._module_author({
        "module_author": {"name": "作者B", "mid": "456", "pub_ts": 1700000001},
    })
    assert (name, mid, pub) == ("作者B", "456", 1700000001), (name, mid, pub)
    # 没有作者模块
    assert api._module_author([]) == ("", "", 0)

    info = asyncio.run(api.opus_from_html(FakeSession(), "760502970183843896"))
    assert info.author == "美图分享师", info
    assert info.mid == "397706516", info
    assert len(info.images) == 1 and info.images[0]["url"].endswith("/a.jpg"), info.images
    print("opus_author_test: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
