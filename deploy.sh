#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# BiliDL 一键部署脚本（群晖 / 任意 Linux + docker compose）
#
#   sudo ./deploy.sh                     # 检查 → 构建 → 启动 → 等健康检查
#   sudo ./deploy.sh --check             # 只做体检，不动任何东西
#   sudo ./deploy.sh --download-dir /volume1/video/Download
#   sudo ./deploy.sh --test              # 部署完顺手跑一次解析自测
#   sudo ./deploy.sh --down              # 停止并删除容器（下载文件与 data 保留）
#   sudo ./deploy.sh --logs              # 跟踪日志
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

MODE="deploy"
DOWNLOAD_DIR=""
DO_TEST=0
LOG="$(mktemp -t bilidl-build.XXXXXX.log)"
trap 'rm -f "$LOG"' EXIT

info() { printf '\033[36m[i]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[✗]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check)        MODE="check"; shift ;;
        --down)         MODE="down"; shift ;;
        --logs)         MODE="logs"; shift ;;
        --test)         DO_TEST=1; shift ;;
        --download-dir) DOWNLOAD_DIR="${2:-}"; [ -n "$DOWNLOAD_DIR" ] || die "--download-dir 需要参数"; shift 2 ;;
        -h|--help)      usage; exit 0 ;;
        *)              warn "未知参数：$1"; usage; exit 2 ;;
    esac
done

# ---- 读取 .env（不 source，避免路径里的空格/特殊字符被 shell 解释） ----------
load_env() {
    [ -f .env ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; esac
        case "$line" in *=*) ;; *) continue ;; esac
        key="${line%%=*}"
        val="${line#*=}"
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                                          -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
        export "${key}=${val}"
    done < .env
}
load_env
PORT="${BILIDL_PORT:-2197}"
HOST_PATH="${BILIDL_HOST_DOWNLOAD:-}"

# ---- docker compose 探测 ---------------------------------------------------
COMPOSE=""
detect_compose() {
    command -v docker >/dev/null 2>&1 || die "没装 docker。群晖请先在「套件中心 / Container Manager」里安装。
  已经装了但提示这条？用 sudo 运行本脚本。"
    docker info >/dev/null 2>&1 || die "docker 守护进程不可用：请用 sudo 运行，或确认 Container Manager 已启动。"
    if docker compose version >/dev/null 2>&1; then
        COMPOSE="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE="docker-compose"
    else
        die "docker 有了，但缺 compose 插件。群晖请升级 Container Manager，或装 docker-compose。"
    fi
}

# ---- 端口占用检查 ----------------------------------------------------------
port_busy() {
    local p="$1" out=""
    if command -v ss >/dev/null 2>&1; then out="$(ss -tln 2>/dev/null || true)"
    elif command -v netstat >/dev/null 2>&1; then out="$(netstat -tln 2>/dev/null || true)"
    fi
    printf '%s\n' "$out" | grep -qE "[:.]$p[[:space:]]" && return 0
    return 1
}

# ---- 下载目录解析 ----------------------------------------------------------
first_existing_dir() {
    local c
    for c in "$@"; do
        [ -n "$c" ] || continue
        [ -d "$c" ] && { printf '%s' "$c"; return 0; }
    done
    return 1
}

resolve_download_dir() {
    # $1 = "dry" 时只检测、不创建任何目录（体检模式用）
    local dry="${1:-}" found="" homes=()
    # 群晖常见位置：/volume1/homes/*/同步/小视频/Download
    for d in /volume1/homes/*/同步/小视频/Download /volume1/homes/*/Drive/Download; do
        [ -d "$d" ] && homes+=("$d")
    done
    found="$(first_existing_dir \
        "$DOWNLOAD_DIR" \
        "$HOST_PATH" \
        "${homes[@]:-}" \
        /volume1/video/Download \
        /volume1/Download \
        /volume1/downloads \
        /volume1/docker/bili-downloads 2>/dev/null || true)"
    if [ -n "$found" ]; then
        printf '%s' "$found"
        return 0
    fi
    if [ "$dry" = "dry" ]; then
        # 体检模式：不创建，返回 .env/参数里声明的路径（可能尚不存在）
        printf '%s' "${DOWNLOAD_DIR:-${HOST_PATH:-}}"
        return 0
    fi
    # .env / 参数里指定了目录但还不存在：能建就建（父目录存在时）
    for c in "$DOWNLOAD_DIR" "$HOST_PATH"; do
        [ -n "$c" ] || continue
        if mkdir -p "$c" 2>/dev/null; then
            printf '%s' "$c"
            return 0
        fi
    done
    # 兜底：用项目内的 downloads/（本脚本有权限创建，立刻可用）
    mkdir -p "$PROJECT_DIR/downloads"
    printf '%s' "$PROJECT_DIR/downloads"
}

write_env() {
    local dl="$1"
    cat > .env <<EOF
# 由 deploy.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
# 想换下载目录：改这一行，或重新跑 ./deploy.sh --download-dir /新路径
BILIDL_HOST_DOWNLOAD=${dl}
BILIDL_PORT=${PORT}
EOF
    ok "已写入 .env：$dl → /download"
}

# ---- 体检 ------------------------------------------------------------------
run_checks() {
    local rc=0
    info "项目目录：$PROJECT_DIR"
    [ -f docker-compose.yml ] || { warn "缺少 docker-compose.yml"; rc=1; }
    [ -d bilidl ] && [ -d web ] || { warn "缺少 bilidl/ 或 web/（build 会失败）"; rc=1; }
    [ -f docker/Dockerfile ] || { warn "缺少 docker/Dockerfile"; rc=1; }
    [ -f requirements.txt ] || { warn "缺少 requirements.txt"; rc=1; }
    ok "项目文件齐全"

    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        detect_compose
        ok "docker 可用：$($COMPOSE version --short 2>/dev/null || echo "$COMPOSE")"
    else
        warn "docker 不可用（没装 / 没用 sudo / Container Manager 未启动）"
        rc=1
    fi

    local dl
    dl="$(resolve_download_dir dry)"
    if [ -n "${HOST_PATH:-}" ] && [ ! -d "$HOST_PATH" ]; then
        warn ".env 里的 BILIDL_HOST_DOWNLOAD=$HOST_PATH 不存在（deploy 会尝试创建；建不了就退回项目内 downloads/）"
    fi
    if [ -d "$dl" ]; then
        ok "宿主机下载目录：$dl"
        [ -w "$dl" ] && ok "下载目录可写" || { warn "下载目录不可写：$dl"; rc=1; }
    else
        warn "宿主机下载目录还不存在：$dl（deploy 会自动创建）"
    fi

    if port_busy "$PORT"; then
        if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"version"'; then
            ok "端口 $PORT 上已经有 BiliDL 在跑（健康检查通过，本次会重建并重启它）"
        else
            warn "端口 $PORT 被别的程序占用，改 .env 的 BILIDL_PORT 或先释放"
            rc=1
        fi
    else
        ok "端口 $PORT 空闲"
    fi

    if [ -f .env ]; then ok ".env 存在"; else warn ".env 不存在（deploy 会自动生成）"; fi
    printf '   构建上下文大小：%s\n' "$(du -sh --exclude=.venv --exclude=dist --exclude=downloads . 2>/dev/null | cut -f1)"
    return $rc
}

case "$MODE" in
    check)
        if run_checks; then ok "体检通过，可以执行：sudo ./deploy.sh"; exit 0
        else die "体检发现问题，先按上面的提示修"; fi
        ;;
    logs)
        detect_compose; exec $COMPOSE logs -f --tail=200 bilidl ;;
    down)
        detect_compose; $COMPOSE down; ok "已停止（下载文件与 ./data 都还在）"; exit 0 ;;
esac

# ---- 部署 ------------------------------------------------------------------
detect_compose
run_checks || die "体检没通过，已中止（修好后重跑，或先 --check 看细节）"

DL="$(resolve_download_dir)"
mkdir -p "$DL" 2>/dev/null || true
[ -d "$DL" ] || die "下载目录不存在且创建失败：$DL"
chmod 777 "$DL" 2>/dev/null || warn "无法 chmod 777 $DL（不影响使用，只是别的 DSM 用户可能看不到文件）"
write_env "$DL"

info "开始构建镜像（首次可能要 1~3 分钟）…"
if ! $COMPOSE build 2>&1 | tee "$LOG"; then
    if grep -qi "requires BuildKit\|--mount option" "$LOG"; then
        warn "检测到 docker 不支持 BuildKit 缓存挂载，回退到 Dockerfile.plain"
        docker build -f docker/Dockerfile.plain -t bilidl:1.0.0 . || die "docker build 失败，见上面的输出"
    else
        die "构建失败，日志在上方（也保存在 $LOG）"
    fi
fi
ok "镜像构建完成"

info "启动容器…"
$COMPOSE up -d

info "等待健康检查（最多 90 秒）…"
healthy=0
for _ in $(seq 1 45); do
    body="$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"ok"'; then healthy=1; break; fi
    sleep 2
done

if [ "$healthy" = "1" ]; then
    ok "服务已就绪"
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -n "${ip:-}" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    printf '\n  WebUI：  \033[1;35mhttp://%s:%s\033[0m\n' "${ip:-NAS_IP}" "$PORT"
    printf '  本地：    http://127.0.0.1:%s\n' "$PORT"
    printf '  下载到：  %s （容器内 /download）\n' "$DL"
    printf '  配置：    %s/data/settings.json\n\n' "$PROJECT_DIR"
    if printf '%s' "$body" | grep -qE '"ffmpeg": ?(true|True)'; then
        ok "ffmpeg 就绪，支持 DASH 高清合并"
    else
        warn "镜像内没检测到 ffmpeg，1080P60 会退回 720P（请检查 Dockerfile）"
    fi
    if [ "$DO_TEST" = "1" ]; then
        info "自测：解析 BV1ppvFeDERi …"
        curl -fsS -m 30 -X POST "http://127.0.0.1:${PORT}/api/parse" \
            -H 'Content-Type: application/json' \
            -d '{"text":"https://www.bilibili.com/video/BV1ppvFeDERi/"}' \
            | head -c 300; echo
        ok "自测完成（任务去 WebUI 的任务队列看）"
    fi
else
    warn "90 秒内没等到健康状态，看日志：sudo ./deploy.sh --logs"
    $COMPOSE ps || true
    exit 1
fi
