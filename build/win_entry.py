"""Windows 打包入口（PyInstaller）。

等价于 `python -m bilidl`，只是给 PyInstaller 一个显式的脚本入口。
"""

import multiprocessing
import os
import sys

# 冻结版里 httpcore 依赖 anyio 的异步后端；先显式导入，避免 PyInstaller 懒加载顺序
# 导致 httpcore 认为没装 anyio（报 "requires installation of 'httpcore[asyncio]'"）。
try:  # pragma: no cover
    import anyio  # noqa: F401
    import anyio._backends._asyncio  # noqa: F401
except Exception:  # pragma: no cover
    pass


def _bootstrap() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    if root not in sys.path:
        sys.path.insert(0, root)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    _bootstrap()
    from bilidl.__main__ import main

    sys.exit(main())
