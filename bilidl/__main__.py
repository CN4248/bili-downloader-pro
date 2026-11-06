"""命令行入口：``python -m bilidl`` / 打包后的 exe。"""

from __future__ import annotations

import argparse
import os

from . import __version__
from .server import serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bilidl", description="B站视频 / 图文下载工具（WebUI）")
    parser.add_argument("--host", default=os.environ.get("BILIDL_HOST", "0.0.0.0"), help="监听地址")
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("BILIDL_PORT", "2917")), help="监听端口"
    )
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument("--version", action="version", version=f"BiliDL-PRO {__version__}")
    args = parser.parse_args(argv)
    serve(host=args.host, port=args.port, open_browser=args.open)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
