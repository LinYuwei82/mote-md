#!/usr/bin/env bash
# 把 mote 的 guard.py 与 manifest_v2.py 同步到另外两个仓库，并更新各自的 sha256 校验文件。
#
# 用法：tools/release/sync_guard.sh
# 约定：三个仓库是同级的本地目录（mote / xiaotu-inventory / dev_card_cpp）。
# 改完先跑两个自检，再跑本脚本；CI 会校验 *.sha256，防止单仓库漂移。

set -euo pipefail

MOTE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$MOTE_ROOT/tools/release"
# (文件名, 校验文件名)：guard 校验文件沿用旧名 guard.sha256，CI 在用
SYNC_FILES=(
  "guard.py guard.sha256"
  "manifest_v2.py manifest_v2.sha256"
)
for f in guard.py manifest_v2.py; do
  [ -f "$SRC_DIR/$f" ] || { echo "缺少 $SRC_DIR/$f" >&2; exit 2; }
done

PEERS=("$MOTE_ROOT/../xiaotu-inventory" "$MOTE_ROOT/../dev_card_cpp")
for repo in "${PEERS[@]}"; do
  [ -d "$repo" ] || { echo "找不到同级仓库：$repo" >&2; exit 2; }
done

python3 "$SRC_DIR/guard.py" selftest >/dev/null
python3 "$SRC_DIR/manifest_v2.py" selftest >/dev/null

for repo in "$MOTE_ROOT" "${PEERS[@]}"; do
  mkdir -p "$repo/tools/release"
  for entry in "${SYNC_FILES[@]}"; do
    f="${entry%% *}"; hash_file="${entry##* }"
    if [ "$repo" != "$MOTE_ROOT" ]; then
      cp "$SRC_DIR/$f" "$repo/tools/release/$f"
    fi
    HASH="$(shasum -a 256 "$repo/tools/release/$f" | awk '{print $1}')"
    printf '%s  tools/release/%s\n' "$HASH" "$f" > "$repo/tools/release/$hash_file"
  done
  python3 "$repo/tools/release/guard.py" selftest >/dev/null
  python3 "$repo/tools/release/manifest_v2.py" selftest >/dev/null
  echo "✓ $repo"
done
echo "guard.py / manifest_v2.py 已同步，三个仓库自检通过"
