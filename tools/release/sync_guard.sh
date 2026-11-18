#!/usr/bin/env bash
# 把 mote 的 guard.py 同步到另外两个仓库，并更新各自的 guard.sha256。
#
# 用法：tools/release/sync_guard.sh
# 约定：三个仓库是同级的本地目录（mote / xiaotu-inventory / dev_card_cpp）。
# 改完 guard.py 先跑自检，再跑本脚本；CI 会校验 guard.sha256，防止单仓库漂移。

set -euo pipefail

MOTE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$MOTE_ROOT/tools/release/guard.py"
[ -f "$SRC" ] || { echo "缺少 $SRC" >&2; exit 2; }

PEERS=("$MOTE_ROOT/../xiaotu-inventory" "$MOTE_ROOT/../dev_card_cpp")
for repo in "${PEERS[@]}"; do
  [ -d "$repo" ] || { echo "找不到同级仓库：$repo" >&2; exit 2; }
done

python3 "$SRC" selftest >/dev/null

HASH="$(shasum -a 256 "$SRC" | awk '{print $1}')"
for repo in "$MOTE_ROOT" "${PEERS[@]}"; do
  mkdir -p "$repo/tools/release"
  if [ "$repo" != "$MOTE_ROOT" ]; then
    cp "$SRC" "$repo/tools/release/guard.py"
  fi
  printf '%s  tools/release/guard.py\n' "$HASH" > "$repo/tools/release/guard.sha256"
  python3 "$repo/tools/release/guard.py" selftest >/dev/null
  echo "✓ $repo"
done
echo "guard.py 已同步（sha256 ${HASH}），三个仓库自检通过"
