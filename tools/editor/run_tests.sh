#!/usr/bin/env bash
# 在仓库根运行 P0 纯函数测试：优先用 node，macOS 上回退到系统自带 jsc。
set -euo pipefail
cd "$(dirname "$0")/../.."

if command -v node >/dev/null 2>&1; then
  exec node tools/editor/test_pure.js "$@"
fi

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if [ -x "$JSC" ]; then
  exec "$JSC" tools/editor/test_pure.js
fi

echo "需要 node，或 macOS 系统自带的 JavaScriptCore jsc" >&2
exit 2
