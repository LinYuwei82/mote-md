#!/usr/bin/env bash
# 把 mote 的 guard.py / manifest_v2.py / publish_args.py 同步到另外两个仓库，并更新各自的 sha256 校验文件。
#
# 设计：
#   mote 是三仓库共用的单一规则源（"主本"）。三个产物（guard.py / manifest_v2.py /
#   各仓库 .sha256）必须一致——CI 会对每个仓库本地的 .sha256 做校验，单仓库私改会被红。
#   devcard/xiaotu 仓库里曾经有各自的定制代码（如 DEVCARD_BUILD warn 分支），应该
#   回收到 mote 主本里统一实现，而不是在 peer 分支里分叉维护。
#
# 用法：
#   tools/release/sync_guard.sh                 # 默认：同步到同级 xiaotu-inventory + dev_card_cpp
#   PEERS="/path/to/x /path/to/y" ./sync_guard.sh  # 跨机器时覆盖路径
#   tools/release/sync_guard.sh --dry-run        # 只 diff 不实际 cp
#   tools/release/sync_guard.sh --local-only     # 只跑 mote 本地 selftest + 重算 sha256（不 cp）
#   tools/release/sync_guard.sh --check-build-str  # 检查三仓库 BUILD_STR 合规性
#
# 约定：三个仓库是同级的本地目录（mote / xiaotu-inventory / dev_card_cpp）。
# 改完先跑两个自检，再跑本脚本；CI 会校验 *.sha256，防止单仓库漂移。

set -euo pipefail

# ---- 参数解析 ----
DRY_RUN=0
LOCAL_ONLY=0
CHECK_BUILD_STR=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --local-only)   LOCAL_ONLY=1 ;;
    --check-build-str) CHECK_BUILD_STR=1 ;;
    -h|--help)
      sed -n '2,29p' "$0"
      exit 0 ;;
    *) echo "未知参数：${arg}（可用：--dry-run, --local-only, --check-build-str）" >&2; exit 2 ;;
  esac
done

# ---- 路径解析 ----
MOTE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$MOTE_ROOT/tools/release"
SYNC_FILES=(
  "guard.py guard.sha256"
  "manifest_v2.py manifest_v2.sha256"
  "publish_args.py publish_args.sha256"
  "gen_build.py gen_build.sha256"
  "update_compare_vectors.json update_compare_vectors.sha256"
)

# 默认同级目录；可用 PEERS 环境变量覆盖（跨机器开发场景）
DEFAULT_PEERS=("$MOTE_ROOT/../xiaotu-inventory" "$MOTE_ROOT/../dev_card_cpp")
if [ -n "${PEERS:-}" ]; then
  # PEERS 是空格分隔路径
  read -ra PEER_ARRAY <<< "$PEERS"
  PEERS=("${PEER_ARRAY[@]}")
else
  PEERS=("${DEFAULT_PEERS[@]}")
fi

# 校验主本文件
for f in guard.py manifest_v2.py publish_args.py gen_build.py; do
  [ -f "$SRC_DIR/$f" ] || { echo "缺少 $SRC_DIR/$f" >&2; exit 2; }
done
# 校验 peer 目录（local-only 时跳过）
if [ "$LOCAL_ONLY" -eq 0 ]; then
  for repo in "${PEERS[@]}"; do
    [ -d "$repo" ] || { echo "找不到同级仓库：$repo" >&2; exit 2; }
  done
fi

echo "========== sync_guard.sh =========="
echo "主本：$MOTE_ROOT"
echo "PEERS：${PEERS[*]:-（local-only 跳过）}"
echo "模式：$([ "$DRY_RUN" -eq 1 ] && echo 'DRY-RUN（只 diff 不 cp）' ||
           [ "$LOCAL_ONLY" -eq 1 ] && echo 'LOCAL-ONLY（仅 mote 本地）' ||
           echo 'FULL SYNC')"
echo ""

# ---- Step 1: 主本自检 ----
echo "① 主本 selftest"
python3 "$SRC_DIR/guard.py" selftest  > /dev/null
python3 "$SRC_DIR/manifest_v2.py" selftest > /dev/null
python3 "$SRC_DIR/publish_args.py" selftest > /dev/null
python3 "$SRC_DIR/gen_build.py" --help > /dev/null
echo "   ✓ mote selftest 通过"
echo ""

# ---- Step 2: DRY-RUN 模式 — 只 diff ----
if [ "$DRY_RUN" -eq 1 ]; then
  echo "② DRY-RUN diff：mote → peers"
  for repo in "${PEERS[@]}"; do
    echo "--- $repo ---"
    for entry in "${SYNC_FILES[@]}"; do
      f="${entry%% *}"
      if [ -f "$repo/tools/release/$f" ]; then
        if cmp -s "$SRC_DIR/$f" "$repo/tools/release/$f"; then
          echo "  $f  → 一致"
        else
          DIFF_LINES=$(diff "$SRC_DIR/$f" "$repo/tools/release/$f" | grep -c '^[<>]' || true)
          echo "  $f  → 差异 $DIFF_LINES 行（将被覆盖）"
        fi
      else
        echo "  $f  → 目标仓库不存在（将新建）"
      fi
    done
    echo ""
  done
  echo "DRY-RUN 完成，未做任何写入"
  exit 0
fi

# ---- Step 3: 正式同步 ----
sync_repo() {
  local repo="$1"
  local label
  label="$(basename "$repo")"
  mkdir -p "$repo/tools/release"

  # git worktree 保护：如果 repo 有未提交改动，先 stash，同步完 pop
  local HAD_STASH=0 STASH_MSG=""
  if [ -d "$repo/.git" ]; then
    if ! git -C "$repo" diff --quiet 2>/dev/null || \
       ! git -C "$repo" diff --cached --quiet 2>/dev/null; then
      STASH_MSG="sync_guard.sh auto-stash before syncing guard/manifest_v2 from mote"
      echo "   ⚠ $label 有未提交改动，先 stash..."
      git -C "$repo" stash push -m "$STASH_MSG" >/dev/null 2>&1 || true
      HAD_STASH=1
    fi
  fi

  # stash pop 先于 hash 重算——pop 后 guard.py 才是包含未提交改动的最新版本
  # （mote 主本自己就有未提交改动，pop 后 hash 才正确）
  if [ "$HAD_STASH" -eq 1 ]; then
    echo "   恢复 $label 的 stash..."
    git -C "$repo" stash pop >/dev/null 2>&1 || true
  fi

  for entry in "${SYNC_FILES[@]}"; do
    local f="${entry%% *}"
    local hash_file="${entry##* }"
    # 只对 peer 仓库 cp（mote 就是主本自己，不用自覆盖）
    if [ "$repo" != "$MOTE_ROOT" ]; then
      cp "$SRC_DIR/$f" "$repo/tools/release/$f"
    fi
    # 两仓库都重算 sha256
    local hash
    hash=$(shasum -a 256 "$repo/tools/release/$f" | awk '{print $1}')
    printf '%s  tools/release/%s\n' "$hash" "$f" > "$repo/tools/release/$hash_file"
  done

  # selftest 确保同步后 peer 仍能跑
  python3 "$repo/tools/release/guard.py" selftest  > /dev/null
  python3 "$repo/tools/release/manifest_v2.py" selftest > /dev/null
  python3 "$repo/tools/release/publish_args.py" selftest > /dev/null
  python3 "$repo/tools/release/gen_build.py" --help > /dev/null

  echo "   ✓ $label"
}

echo "② 重算 mote 主本 sha256"
sync_repo "$MOTE_ROOT"
echo ""

if [ "$LOCAL_ONLY" -eq 0 ]; then
  echo "③ 同步到 peer 仓库"
  for repo in "${PEERS[@]}"; do
    sync_repo "$repo"
  done
  echo ""
fi

echo "========== 完成 =========="
echo "guard.py / manifest_v2.py / publish_args.py / gen_build.py 已同步，三个仓库 selftest 全部通过。"
echo ""
echo "下一步建议（需要你手动做）："
echo "  cd $MOTE_ROOT && git add tools/release/guard.py tools/release/guard.sha256 \\"
echo "    tools/release/manifest_v2.py tools/release/manifest_v2.sha256 \\"
echo "    tools/release/publish_args.py tools/release/publish_args.sha256 \
    tools/release/gen_build.py tools/release/gen_build.sha256"
echo "  cd $MOTE_ROOT/../xiaotu-inventory && git add tools/release/guard.py tools/release/guard.sha256 \\"
echo "    tools/release/manifest_v2.py tools/release/manifest_v2.sha256 \\"
echo "    tools/release/publish_args.py tools/release/publish_args.sha256 \
    tools/release/gen_build.py tools/release/gen_build.sha256"
echo "  cd $MOTE_ROOT/../dev_card_cpp && git add tools/release/guard.py tools/release/guard.sha256 \\"
echo "    tools/release/manifest_v2.py tools/release/manifest_v2.sha256 \\"
echo "    tools/release/publish_args.py tools/release/publish_args.sha256 \\
    tools/release/gen_build.py tools/release/gen_build.sha256"
exit 0

# ============================================================================
# --check-build-str：检查三仓库 BUILD_STR 合规性
# ============================================================================
if [ "$CHECK_BUILD_STR" -eq 1 ]; then
  check_build_str_compliance() {
    local repo="$1" name="$2" product_prefix="$3" cmake_path="$4" shell_src="$5"
    local ok=1
    local label
    label="$(basename "$repo")"

    echo "--- ${name}（${label}）---"

    # 1) CMakeLists.txt 里有 XXX_BUILD_STR / XXX_BUILD_STAMP / 构建号注入函数
    if [ -f "$repo/$cmake_path" ]; then
      if grep -q "${product_prefix}_BUILD_STR" "$repo/$cmake_path" 2>/dev/null \
         || grep -q "${product_prefix}_BUILD_STAMP" "$repo/$cmake_path" 2>/dev/null \
         || grep -qiE "${product_prefix,}_add_build_stamp|build_stamp|BUILD_STR" "$repo/$cmake_path" 2>/dev/null; then
        echo "  ✓ CMakeLists.txt 含 ${product_prefix}_BUILD_STR / ${product_prefix}_BUILD_STAMP 宏或构建号注入函数"
      else
        echo "  ✗ CMakeLists.txt 缺少 ${product_prefix}_BUILD_STR / ${product_prefix}_BUILD_STAMP 宏或构建号注入函数"
        ok=0
      fi
    else
      echo "  ! CMakeLists.txt 不存在（跳过）"
    fi

    # 2) 壳源码里有 kBuildStamp 静态字符串（三产品统一 pattern：kBuildStamp[]）
    if [ -n "$shell_src" ] && [ -f "$repo/$shell_src" ]; then
      if grep -q "kBuildStamp\[\]" "$repo/$shell_src"; then
        echo "  ✓ 壳源码含 kBuildStamp"
      elif grep -qE "constexpr.*_BUILD(_STAMP)?=" "$repo/$shell_src"; then
        echo "  ✓ 壳源码含 BUILD stamp 字符串"
      else
        echo "  ✗ 壳源码缺少 kBuildStamp / BUILD stamp 标记"
        ok=0
      fi
    elif [ -n "$shell_src" ]; then
      echo "  ! 壳源码不存在（跳过）"
    else
      echo "  · 无独立壳源码"
    fi

    # 3) guard.py 的 _BUILD_STAMP_PREFIX 映射应该与实现一致
    #    key 是小写产品名（mote / xiaotu / devcard），不是大写前缀
    local lower_label
    lower_label="$(echo "$label" | sed 's/_/-/g; y/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz/')"
    # dev_card_cpp → devcard（映射简化名）
    case "$lower_label" in
      dev-card-cpp) lower_label="devcard" ;;
      mote-md)      lower_label="mote" ;;
      xiaotu-inventory) lower_label="xiaotu" ;;
    esac
    local guard_has_prefix
    guard_has_prefix=$(grep "_BUILD_STAMP_PREFIX" "$repo/tools/release/guard.py" 2>/dev/null \
                       | grep -c "\"$lower_label\":")
    if [ "$guard_has_prefix" -gt 0 ]; then
      echo "  ✓ guard.py _BUILD_STAMP_PREFIX 含 \"$lower_label\""
    else
      echo "  ! guard.py 未找到 \"$lower_label\" 映射（源码可能用别的名字，需确认）"
    fi
    echo ""
    [ "$ok" -eq 1 ]
  }

  echo "========== BUILD_STR 合规检查 =========="
  echo "主本：$MOTE_ROOT"
  echo ""

  local any_fail=0

  # Mote：native/CMakeLists.txt + platform/win/updater.cpp
  check_build_str_compliance "$MOTE_ROOT" "Mote" "MOTE" \
    "native/CMakeLists.txt" "platform/win/updater.cpp" || any_fail=1

  # Xiaotu：shell/win/CMakeLists.txt + shell/win/updater_win.cpp
  if [ -d "$MOTE_ROOT/../xiaotu-inventory" ]; then
    check_build_str_compliance "$MOTE_ROOT/../xiaotu-inventory" "小兔进销存" "XIAOTU" \
      "shell/win/CMakeLists.txt" "shell/win/updater_win.cpp" || any_fail=1
  else
    echo "! 找不到 xiaotu-inventory 仓库，跳过"
  fi

  # DevCard：shell/win/main.cpp 有 kBuildStamp（"DEVCARD_BUILD_STAMP=<digits>"），
  # 双宏由 cmake/devcard_version.cmake 的 devcard_add_build_stamp() 函数注入
  # （DEVCARD_BUILD_STAMP=<int> + DEVCARD_BUILD_STAMP_STR="<int>"）。
  if [ -d "$MOTE_ROOT/../dev_card_cpp" ]; then
    check_build_str_compliance "$MOTE_ROOT/../dev_card_cpp" "DevCard" "DEVCARD" \
      "cmake/devcard_version.cmake" "shell/win/main.cpp" || any_fail=1
  else
    echo "! 找不到 dev_card_cpp 仓库，跳过"
  fi

  echo "========== BUILD_STR 合规检查完成 =========="
  if [ "$any_fail" -eq 1 ]; then
    echo "存在缺失项，请按 ✗ 标记补齐"
    exit 1
  else
    echo "三仓库 BUILD_STR 机制合规"
    exit 0
  fi
fi
