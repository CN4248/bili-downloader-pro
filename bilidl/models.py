"""数据模型：面向前端序列化为普通 dict。"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Page:
    index: int
    cid: int
    title: str
    duration: int = 0
    bvid: str = ""
    cover: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SeasonEpisode:
    index: int
    bvid: str
    cid: int
    title: str
    duration: int = 0
    cover: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class VideoInfo:
    bvid: str
    aid: int
    title: str
    author: str
    mid: str
    cover: str
    desc: str
    pubdate: int
    duration: int
    pages: list[Page] = field(default_factory=list)
    season_id: str = ""
    season_title: str = ""
    season_episodes: list[SeasonEpisode] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "video",
            "bvid": self.bvid,
            "aid": self.aid,
            "title": self.title,
            "author": self.author,
            "mid": self.mid,
            "cover": self.cover,
            "desc": self.desc,
            "pubdate": self.pubdate,
            "duration": self.duration,
            "pages": [p.to_dict() for p in self.pages],
            "season": {
                "id": self.season_id,
                "title": self.season_title,
                "episodes": [e.to_dict() for e in self.season_episodes],
            }
            if self.season_id
            else None,
        }


@dataclass
class OpusInfo:
    oid: str
    kind: str  # opus / dynamic / article
    title: str
    author: str
    mid: str
    pubdate: int
    cover: str
    text: str
    images: list[dict[str, Any]] = field(default_factory=list)
    url: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "opus",
            "oid": self.oid,
            "sub_kind": self.kind,
            "title": self.title,
            "author": self.author,
            "mid": self.mid,
            "pubdate": self.pubdate,
            "cover": self.cover,
            "text": self.text[:600],
            "images": self.images,
            "image_count": len(self.images),
            "url": self.url,
        }


@dataclass
class AuthorWork:
    kind: str  # video / opus
    ident: str
    title: str
    cover: str = ""
    duration: int = 0
    pubdate: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
