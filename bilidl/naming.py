"""文件重命名规则：变量替换、非法字符清理与去重。"""

from __future__ import annotations

import re
from pathlib import Path

DEFAULT_VIDEO_TEMPLATE = "<video_title>-<video_id>-<video_episode>.<ext>"
DEFAULT_OPUS_TEMPLATE = "<opus_title>-<opus_id>-<opus_order>.<ext>"
DEFAULT_READLIST_TEMPLATE = "<readlist_title>/<readlist_order>-<opus_title>/<opus_id>-<opus_order>.<ext>"

# 变量名 -> 中文说明，同时作为 WebUI 提示
VIDEO_VARS: dict[str, str] = {
    "video_title": "视频标题",
    "video_id": "视频BV号",
    "video_episode": "视频分集序号",
    "video_page_title": "分集标题",
    "video_author": "UP主昵称",
    "video_quality": "实际清晰度",
    "video_date": "发布时间(YYYYMMDD)",
    "videolist_title": "合集标题(不在合集则忽略)",
    "videolist_order": "合集内视频序号(不在合集则忽略)",
    "videolist_id": "合集ID(不在合集则忽略)",
    "video_author_uid": "视频作者UID",
    "ext": "文件扩展名",
}
READLIST_VARS: dict[str, str] = {
    "readlist_title": "文集标题",
    "readlist_order": "文集内文章序号",
    "readlist_id": "文集ID",
    "opus_title": "文章标题",
    "opus_id": "文章id(cv号)",
    "opus_order": "文章内图片序号",
    "opus_author": "作者昵称",
    "opus_date": "发布时间(YYYYMMDD)",
    "ext": "文件扩展名",
}
OPUS_VARS: dict[str, str] = {
    "opus_title": "专栏或动态标题",
    "opus_id": "专栏或动态id",
    "opus_order": "专栏或动态图片序号",
    "opus_author": "作者昵称",
    "opus_date": "发布时间(YYYYMMDD)",
    "ext": "文件扩展名",
}

# 中文别名 -> 变量名（允许用户直接写 <视频标题>）
# YouTube：变量名与 B 站保持一致（video_* / videolist_*），另加几个 YouTube 专属别名。
# video_id = YouTube 视频 ID；video_episode 固定为 1（YouTube 没有分 P）；
# videolist_* / youtube_list_* 对应播放列表（不在播放列表里时整段忽略）。
YT_VIDEO_VARS: dict[str, str] = {
    "video_title": "视频标题",
    "video_id": "视频ID（YouTube）",
    "video_episode": "分集序号（YouTube 固定 1）",
    "video_page_title": "分集标题",
    "video_author": "频道名",
    "video_quality": "实际清晰度",
    "video_date": "发布时间(YYYYMMDD)",
    "videolist_title": "播放列表标题(不在列表则忽略)",
    "videolist_order": "播放列表内序号(不在列表则忽略)",
    "videolist_id": "播放列表ID(不在列表则忽略)",
    "video_author_uid": "频道ID",
    "youtube_id": "视频ID（同 video_id）",
    "youtube_channel": "频道名",
    "youtube_channel_id": "频道ID（UC 开头）",
    "youtube_list_title": "播放列表标题",
    "youtube_list_order": "播放列表内序号",
    "youtube_list_id": "播放列表ID",
    "ext": "文件扩展名",
}

# B站 的三张表先建别名（描述唯一），YouTube 表只补「B站 没有的变量」，
# 否则 YouTube 的描述（视频ID / 频道名）会把 <视频BV号> 之类的老别名覆盖掉。
CN_ALIASES: dict[str, str] = {
    v: k for k, v in {**VIDEO_VARS, **OPUS_VARS, **READLIST_VARS}.items()
}
for _key, _desc in YT_VIDEO_VARS.items():
    CN_ALIASES.setdefault(_desc, _key)

MISSING = "\x00"
MISSING_RUN = re.compile(r"[\s/_\-]*\x00[\s/_\-]*")

ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
ANGLE = re.compile(r"<([^<>{}]+)>")
DOLLAR = re.compile(r"\$\{([^}]+)\}")


SEPARATOR = re.compile(r"[\\/]+")


def _plain(value: object) -> str:
    """变量值里的路径分隔符一律降级成 `_`。

    标题里带斜杠很常见（例：「【官方广播剧/中文字幕】…」）。如果不过滤，
    渲染完再按 `/` 切段就会凭空多出一层目录，而且用户的模板意图也被曲解。
    只有模板里写的 `/` 才表示「建子文件夹」。
    """
    return ("" if value is None else str(value)).replace("/", "_").replace("\\", "_")


def _render(template: str, mapping: dict[str, object], ext: str) -> str:
    mapping = {k: _plain(v) for k, v in mapping.items()}
    mapping = {**mapping, "ext": ext}

    def repl_angle(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        key = CN_ALIASES.get(key, key)
        # 取不到（或为空）的变量用占位符，稍后连同相邻的分隔符一起清掉
        return mapping.get(key) or MISSING

    def repl_dollar(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        key = CN_ALIASES.get(key, key)
        return mapping.get(key) or MISSING

    out = ANGLE.sub(repl_angle, template)
    out = DOLLAR.sub(repl_dollar, out)
    # 缺失变量的位置连同它旁边的 - / _ 分隔符一起去掉，避免出现 "-标题" 这种残留
    return MISSING_RUN.sub("", out)


def sanitize(name: str, ext: str, max_length: int = 170) -> str:
    """清理文件名中的非法字符，并保证扩展名正确。"""
    name = ILLEGAL.sub("_", name).strip().strip(".")
    name = re.sub(r"\s+", " ", name)
    suffix = f".{ext.lstrip('.')}" if ext else ""
    if suffix and not name.lower().endswith(suffix.lower()):
        name = f"{name}{suffix}"
    if not name.strip("._"):
        name = f"bili{suffix}"
    if len(name) > max_length:
        stem, dot, tail = name.rpartition(".")
        if dot and len(tail) <= 8:
            keep = max_length - len(tail) - 1
            name = f"{stem[:keep]}.{tail}"
        else:
            name = name[:max_length]
    return name


def _clean_segment(text: str) -> str:
    seg = ILLEGAL.sub("_", text)
    seg = re.sub(r"\s+", " ", seg).strip().strip(".")
    return seg


def build_relative(template: str, mapping: dict[str, str], ext: str) -> Path:
    """按模板生成「相对路径」：模板里的 / 或反斜杠会变成子文件夹。

    * 变量值里的 `/`、`\\` 已在 _render 里换成 `_`，不会被当成目录分隔符；
    * 每一段单独清理非法字符，空段、`.`、`..` 直接丢弃（防目录穿越）；
    * 最后一段补上扩展名；
    * 返回值一定是相对路径，交由调用方拼到下载根目录下。
    """
    ext = (ext or "bin").lstrip(".")
    template = (template or "").strip()
    if not template:
        template = DEFAULT_VIDEO_TEMPLATE
    rendered = _render(template, mapping, ext)
    raw_parts = SEPARATOR.split(rendered)
    parts: list[str] = []
    for raw in raw_parts:
        seg = _clean_segment(raw)
        if not seg or seg in (".", ".."):
            continue
        parts.append(seg)
    if not parts:
        parts = ["bili"]
    # 最后一段补扩展名并限长
    last = parts[-1]
    suffix = f".{ext}" if ext else ""
    if suffix and not last.lower().endswith(suffix.lower()):
        last = f"{last}{suffix}"
    if len(last) > 170:
        stem, dot, tail = last.rpartition(".")
        if dot and len(tail) <= 8:
            last = f"{stem[:170 - len(tail) - 1]}.{tail}"
        else:
            last = last[:170]
    parts[-1] = last
    if not parts[-1].strip("._"):
        parts[-1] = f"bili{suffix}"
    return Path(*parts)


def build_filename(template: str, mapping: dict[str, str], ext: str) -> str:
    """按模板生成安全的文件名。"""
    ext = (ext or "bin").lstrip(".")
    template = (template or "").strip()
    if not template:
        template = DEFAULT_VIDEO_TEMPLATE
    rendered = _render(template, mapping, ext)
    return sanitize(rendered, ext)


def unique_path(directory: Path, filename: str) -> Path:
    """同名文件已存在时追加 (1)(2)…，避免覆盖。"""
    path = directory / filename
    if not path.exists():
        return path
    stem, dot, tail = filename.rpartition(".")
    if not dot:
        stem, tail = filename, ""
    index = 1
    while True:
        candidate = directory / (f"{stem}-{index}.{tail}" if tail else f"{stem}-{index}")
        if not candidate.exists():
            return candidate
        index += 1
