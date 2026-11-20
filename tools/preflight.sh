#!/usr/bin/env bash
# 本机自检（macOS）：仓库状态 → 独立目录构建 → 启动冒烟
#
# 用法：
#   bash tools/preflight.sh              # 原生构建（CMake/AppKit）+ 启动冒烟
#   bash tools/preflight.sh --no-smoke   # 只构建
#   MOTE_PREFLIGHT_DIR=/tmp/xxx bash tools/preflight.sh
#
# 退出码：0 通过，1 构建/冒烟失败，2 参数错误

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${MOTE_PREFLIGHT_DIR:-/tmp/mote-preflight}"
SMOKE=1

for arg in "$@"; do
    case "$arg" in
        --no-smoke) SMOKE=0 ;;
        -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) printf '未知参数：%s（可用：--no-smoke）\n' "$arg" >&2; exit 2 ;;
    esac
done

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '%s\n' "$*"; }

cd "$ROOT" || { red "无法进入仓库根目录：$ROOT"; exit 1; }

info "== 1. 仓库状态 =="
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || BRANCH=""
if [ -z "$BRANCH" ]; then
    red "读取分支失败：确认当前目录是 git 仓库"
    exit 1
fi
info "分支：$BRANCH"
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
    red "有未提交/未跟踪改动（不阻塞构建，但换机器前必须处理）："
    printf '%s\n' "$DIRTY"
else
    green "工作区干净"
fi

info "== 2. 构建工具 =="
if ! command -v cmake >/dev/null 2>&1; then
    red "找不到 cmake：先安装 CMake 后重试"
    exit 1
fi
info "使用原生构建（native/，AppKit + WKWebView）"

info "== 3. 独立目录构建 =="
info "构建目录：$BUILD_DIR"
rm -rf "$BUILD_DIR" || { red "无法清理 $BUILD_DIR"; exit 1; }
mkdir -p "$BUILD_DIR" || { red "无法创建 $BUILD_DIR"; exit 1; }

LOG="$BUILD_DIR/build.log"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
(
    # -DMOTE_RELEASE_BUILD=ON：Sparkle.framework 缺失时 FATAL_ERROR，
    # 防止残缺产物（2026-11-19 mote 1.0.4 即因此重发）
    cmake -S "$ROOT/native" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release -DMOTE_RELEASE_BUILD=ON \
        && cmake --build "$BUILD_DIR" --config Release -j"$JOBS"
) > "$LOG" 2>&1

if [ $? -ne 0 ]; then
    red "构建失败，第一条错误："
    FIRST="$(grep -m 1 -E 'error:' "$LOG")"
    if [ -n "$FIRST" ]; then
        red "  $FIRST"
    else
        tail -20 "$LOG" | sed 's/^/  /'
    fi
    red "完整日志：$LOG"
    exit 1
fi

APP="$BUILD_DIR/Mote.app/Contents/MacOS/Mote"
if [ ! -x "$APP" ]; then
    red "构建返回成功但找不到可执行文件：$APP"
    exit 1
fi
green "构建通过：$APP"

if [ "$SMOKE" -ne 1 ]; then
    info "已跳过启动冒烟（--no-smoke）"
    exit 0
fi

info "== 4. 启动冒烟 =="
SMOKE_LOG="$BUILD_DIR/smoke.log"
WAIT_SECONDS="${MOTE_SMOKE_SECONDS:-10}"
# 只是表达式，结尾不能带分号：平台层会把它包成 var r=(...)
PROBE='(function(){var b=document.body||{};return JSON.stringify({title:document.title,textLen:(b.innerText||"").length,blocks:document.querySelectorAll("h1,h2,h3,h4,p,li,pre,table,blockquote").length,imgs:document.querySelectorAll("img").length,moteApi:!!(window.mote)})})()'

MOTE_KEYLOG=1 MOTE_EVAL="$PROBE" "$APP" > "$SMOKE_LOG" 2>&1 &
PID=$!

elapsed=0
while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
    if grep -q 'JSLOG EVAL' "$SMOKE_LOG" 2>/dev/null; then
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null

METRICS="$(grep -m 1 'JSLOG EVAL' "$SMOKE_LOG" | sed 's/^.*JSLOG EVAL //')"
if [ -z "$METRICS" ]; then
    red "冒烟失败：${WAIT_SECONDS}s 内没有拿到页面指标"
    tail -20 "$SMOKE_LOG" | sed 's/^/  /'
    red "完整日志：$SMOKE_LOG"
    exit 1
fi

green "冒烟通过：$METRICS"
info "全部检查通过（构建目录：${BUILD_DIR}）"
