#!/usr/bin/env bash
# 把 mote 的 modules/win_encoding 同步到另外两个仓库，并写入各自的 SHA256SUMS。
#
# 设计与 sync_guard.sh 一致：mote 是三仓库共用的单一源（主本），三个副本必须逐字节一致；
# 单仓库私改会在 --check（以及后续 CI 校验 SHA256SUMS）里变红。
#
# 用法：
#   tools/release/sync_win_encoding.sh              # 同步到同级 xiaotu-inventory + dev_card_cpp
#   tools/release/sync_win_encoding.sh --check      # 只校验是否一致，不改文件（不一致 exit 1）
#   tools/release/sync_win_encoding.sh --dry-run    # 只打印将要覆盖/删除的文件
#   PEERS="/path/a /path/b" tools/release/sync_win_encoding.sh
#
# 约定：三个仓库是同级的本地目录；跨机器时用 PEERS 覆盖，脚本本身不含绝对路径。

set -euo pipefail

MOTE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$MOTE_ROOT/modules/win_encoding"
MODULE_REL="modules/win_encoding"

MODE=sync
for arg in "$@"; do
  case "$arg" in
    --check)   MODE=check ;;
    --dry-run) MODE=dry ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：${arg}（可用：--check, --dry-run）" >&2; exit 2 ;;
  esac
done

if [ -n "${PEERS:-}" ]; then
  # shellcheck disable=SC2206
  TARGET_REPOS=(${PEERS})
else
  TARGET_REPOS=("$MOTE_ROOT/../xiaotu-inventory" "$MOTE_ROOT/../dev_card_cpp")
fi

file_hash() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# 模块内文件的相对路径（不含 SHA256SUMS 自身），按字节序排序。
list_module_files() {
  local dir="$1"
  ( cd "$dir" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | sed 's|^\./||' )
}

# 生成 "hash  relpath" 清单，用于跨仓库逐字节比对。
manifest_of() {
  local dir="$1" rel
  while IFS= read -r rel; do
    printf '%s  %s\n' "$(file_hash "$dir/$rel")" "$rel"
  done < <(list_module_files "$dir")
}

write_sums() {
  local dir="$1" rel
  {
    while IFS= read -r rel; do
      printf '%s  %s\n' "$(file_hash "$dir/$rel")" "$rel"
    done < <(list_module_files "$dir")
  } > "$dir/SHA256SUMS"
}

[ -d "$SRC_DIR" ] || { echo "✗ 找不到主本：$SRC_DIR" >&2; exit 1; }

if [ "$MODE" != "check" ]; then
  write_sums "$SRC_DIR"
fi

SRC_MANIFEST="$(manifest_of "$SRC_DIR")"
FAILED=0

for repo in "${TARGET_REPOS[@]}"; do
  dst="$repo/$MODULE_REL"
  name="$(basename "$repo")"

  if [ ! -d "$repo" ]; then
    echo "✗ [$name] 仓库目录不存在：$repo" >&2
    FAILED=1
    continue
  fi

  if [ "$MODE" = "check" ]; then
    if [ ! -d "$dst" ]; then
      echo "✗ [$name] 缺少模块目录：$dst" >&2
      FAILED=1
      continue
    fi
    dst_manifest="$(manifest_of "$dst")"
    if [ "$SRC_MANIFEST" = "$dst_manifest" ]; then
      echo "✓ [$name] modules/win_encoding 与主本一致"
    else
      echo "✗ [$name] modules/win_encoding 与主本不一致：" >&2
      diff <(printf '%s\n' "$SRC_MANIFEST") <(printf '%s\n' "$dst_manifest") >&2 || true
      FAILED=1
    fi
    continue
  fi

  # 按主本清单逐个覆盖，并删除目标里的多余文件（保证文件集合也一致）。
  while IFS= read -r rel; do
    mkdir -p "$dst/$(dirname "$rel")" 2>/dev/null || true
    if [ "$MODE" = "dry" ]; then
      echo "[dry] $name: $rel"
    else
      cp "$SRC_DIR/$rel" "$dst/$rel"
    fi
  done < <(list_module_files "$SRC_DIR")

  while IFS= read -r rel; do
    if [ ! -f "$SRC_DIR/$rel" ]; then
      if [ "$MODE" = "dry" ]; then
        echo "[dry] $name: 删除多余文件 $rel"
      else
        rm -f "$dst/$rel"
      fi
    fi
  done < <(list_module_files "$dst" 2>/dev/null || true)

  if [ "$MODE" = "dry" ]; then
    echo "[dry] $name: 将写入 $MODULE_REL/SHA256SUMS"
  else
    write_sums "$dst"
    echo "✓ [$name] 已同步 modules/win_encoding 并写入 SHA256SUMS"
  fi
done

if [ "$MODE" = "check" ] && [ "$FAILED" -ne 0 ]; then
  echo "" >&2
  echo "存在漂移。以 mote 为准重新同步：tools/release/sync_win_encoding.sh" >&2
  exit 1
fi

exit 0
