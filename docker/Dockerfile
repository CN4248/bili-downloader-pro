# ---------------------------------------------------------------------------
# BiliDL · WebUI + 下载引擎（Docker）
#
# 构建要点（为了快）：
#   1. 基础镜像用 python:3.12-slim（约 50MB），不碰 alpine（ffmpeg 依赖麻烦）；
#   2. 只装 ffmpeg 一个系统包，--no-install-recommends；
#   3. Python 依赖只有 httpx / qrcode / yt-dlp，无编译；nodejs 给 yt-dlp 当 JS 运行时；
#   4. apt / pip 全部走 BuildKit 缓存挂载，二次构建只重跑 COPY 之后的层；
#   5. 默认使用国内镜像源（可用 --build-arg 换回官方源）。
#
# 想用官方源：
#   docker compose build --build-arg DEBIAN_MIRROR=deb.debian.org \
#                        --build-arg PIP_INDEX=https://pypi.org/simple
# ---------------------------------------------------------------------------
FROM python:3.12-slim-trixie

ARG DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BILIDL_DOWNLOAD_DIR=/download \
    BILIDL_DATA_DIR=/app/data \
    BILIDL_PORT=2917 \
    TZ=Asia/Shanghai

WORKDIR /app

# 换源（兼容 bookworm 的 debian.sources 与旧版 sources.list）
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" \
            /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
        sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" \
            /etc/apt/sources.list; \
    fi

# ffmpeg：合并 DASH 音视频 / 音频转码；nodejs：yt-dlp 解析 YouTube 高清格式需要的 JS 运行时
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -i "${PIP_INDEX}" -r requirements.txt

COPY bilidl ./bilidl
COPY web ./web

RUN mkdir -p /app/data /download

VOLUME ["/download"]
EXPOSE 2917

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:2917/api/health', timeout=4)"

CMD ["python", "-m", "bilidl", "--host", "0.0.0.0", "--port", "2917"]
