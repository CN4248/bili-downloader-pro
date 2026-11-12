"""业务异常类型。所有面向用户的提示都使用中文短句。"""

from __future__ import annotations


class BiliError(Exception):
    """基础异常，message 直接展示给用户。"""

    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code


class AuthRequired(BiliError):
    """需要登录（未登录或 Cookie 失效）。"""


class RiskControl(BiliError):
    """触发 B站风控，必须降速或等待。"""


class NotFound(BiliError):
    """内容不存在、已删除或无权限。"""


class ParseError(BiliError):
    """链接无法识别。"""


class DownloadError(BiliError):
    """文件下载失败。"""
