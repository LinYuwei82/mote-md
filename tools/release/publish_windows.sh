#!/usr/bin/env bash
# Mote · Windows 在线更新发布（OSS 清单，更新清单 Schema v2）
#
# 输入：绿色包 zip（必需）+ 安装包 setup.exe（可选）
# 动作：生成 Ed25519 签名的 manifest.json（v2）→ 上传 dl.xiaotu.online → 线上门禁
#
# 与 macOS 的分工：
#   Windows 不用 Sparkle，客户端（platform/win/updater.cpp）自己读 manifest.json、
#   验 Ed25519 签名、下载、校验 SHA256、静默安装 / 提示手动替换。
#   artifacts.setup 存在时优先安装版静默升级；否则回落到 artifacts.portable 绿色包。
#
# 目录约定（v2 命名：<product>-<version>-<os>-<arch>-<type>.<ext>）：
#   oss://<bucket>/mote/mote-<ver>-win64-portable.zip
#   oss://<bucket>/mote/mote-<ver>-win64-setup.exe   （可选）
#   oss://<bucket>/mote/updates/stable/manifest.json
#
# 构建号：v2 清单 windows 平台必须带 build（客户端同版本比对构建号），缺省取
# 触发时刻 UTC（分钟级）；与 GitHub Actions 的构建号约定一致。
#
# 用法：
#   tools/release/publish_windows.sh                          # 从 dist/ 自动找 zip
#   BUILD=202611180930 ZIP_PATH=/path/to/portable.zip \
#   SETUP_PATH=/path/to/setup.exe tools/release/publish_windows.sh
#   NOTES_URL=https://... tools/release/publish_windows.sh    # 附带发布说明链接

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(sed -n 's/^VERSION[[:space:]]*=[[:space:]]*\([0-9.]*\).*/\1/p' Mote.pro | head -1)}"
[ -n "$VERSION" ] || { echo "无法确定 VERSION" >&2; exit 1; }

CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in stable|beta) ;; *) echo "CHANNEL 必须是 stable/beta" >&2; exit 2 ;; esac

BUILD="${BUILD:-$(LC_ALL=C date -u '+%Y%m%d%H%M')}"
[[ "$BUILD" =~ ^[0-9]{4,}$ ]] || { echo "非法构建号：$BUILD（应为纯数字，如 202611180930）" >&2; exit 1; }

CDN_DOMAIN="${CDN_DOMAIN:-https://dl.xiaotu.online}"
PRODUCT_DIR="${PRODUCT_DIR:-mote}"
MIN_OS="${MIN_OS:-10.0}"
KEY_ID="${KEY_ID:-2026-11}"
SKIP_UPLOAD="${SKIP_UPLOAD:-false}"
OSS_ENV_FILE="${OSS_ENV_FILE:-$HOME/.config/xiaotu-updates/.env}"
SIGN_KEY="${SIGN_KEY:-$HOME/.config/mote-updates/ed25519_seed.b64}"
[ -f "$SIGN_KEY" ] || { echo "v2 清单签名种子不存在：$SIGN_KEY" >&2; exit 1; }
NOTES_URL="${NOTES_URL:-}"
# notes_url 会原样写进清单并被客户端打开，必须是绝对 http(s) 地址；
# 相对路径（如 /mote/release-notes-x.html）会让「查看完整更新说明…」打不开
if [ -n "$NOTES_URL" ]; then
  case "$NOTES_URL" in
    http://*|https://*) ;;
    *) echo "NOTES_URL 必须是绝对 http(s) 地址：$NOTES_URL" >&2; exit 2 ;;
  esac
fi
# 未显式指定时，若仓库里有 docs/release-notes-<版本>.html 就自动带上并上传；
# 缺页则不写 notes_url，避免客户端出现死链。
NOTES_FILE=""
if [ -z "$NOTES_URL" ] && [ -f "$REPO_ROOT/docs/release-notes-$VERSION.html" ]; then
  NOTES_FILE="$REPO_ROOT/docs/release-notes-$VERSION.html"
  NOTES_URL="$CDN_DOMAIN/$PRODUCT_DIR/release-notes-$VERSION.html"
fi

# ---- 定位产物 ----
ZIP_PATH="${ZIP_PATH:-$REPO_ROOT/dist/Mote-$VERSION-win64-portable.zip}"
SETUP_PATH="${SETUP_PATH:-}"

if [ ! -f "$ZIP_PATH" ]; then
  # 兼容打包脚本的默认产物名 dist/Mote-Windows.zip
  ZIP_PATH="$(find "$REPO_ROOT/dist" -maxdepth 1 -name "Mote*.zip" | head -1 || true)"
fi
[ -n "$ZIP_PATH" ] && [ -f "$ZIP_PATH" ] || { echo "绿色包 zip 不存在：$ZIP_PATH" >&2; exit 1; }

if [ -z "$SETUP_PATH" ] || [ ! -f "$SETUP_PATH" ]; then
  SETUP_PATH="$(find "$REPO_ROOT/dist" -maxdepth 1 -iname "*setup*.exe" | head -1 || true)"
fi

# v2 安装包命名：<product>-<version>-<os>-<arch>-<type>.<ext>；本地产物名不变，远端按 v2 命名
V2_ZIP_NAME="mote-$VERSION-win64-portable.zip"
V2_SETUP_NAME="mote-$VERSION-win64-setup.exe"
ZIP_SIZE="$(stat -f %z "$ZIP_PATH")"
ZIP_SHA256="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
ZIP_URL="$CDN_DOMAIN/$PRODUCT_DIR/$V2_ZIP_NAME"

MANIFEST_KEY="$PRODUCT_DIR/updates/$CHANNEL/manifest.json"
MANIFEST_URL="$CDN_DOMAIN/$MANIFEST_KEY"

echo "===== Mote Windows 发布 · $VERSION / build $BUILD / $CHANNEL ====="
echo "绿色包：    $ZIP_PATH ($ZIP_SIZE B)"
echo "远端名（v2）：$V2_ZIP_NAME"
echo "SHA256：    $ZIP_SHA256"
if [ -n "$SETUP_PATH" ] && [ -f "$SETUP_PATH" ]; then
  SETUP_SIZE="$(stat -f %z "$SETUP_PATH")"
  SETUP_SHA256="$(shasum -a 256 "$SETUP_PATH" | awk '{print $1}')"
  SETUP_URL="$CDN_DOMAIN/$PRODUCT_DIR/$V2_SETUP_NAME"
  echo "安装包：    $SETUP_PATH ($SETUP_SIZE B)"
  echo "Setup SHA256：$SETUP_SHA256"
else
  SETUP_PATH=""; SETUP_SIZE=""; SETUP_SHA256=""; SETUP_URL=""
  echo "安装包：    （未提供，仅发布绿色包）"
fi
echo "清单地址：  $MANIFEST_URL"

MANIFEST_V2_PY="$REPO_ROOT/tools/release/manifest_v2.py"
MANIFEST_LOCAL="$REPO_ROOT/dist/manifest.json"

# ---- ① 生成 manifest.json（v2，Ed25519 签名）----
echo ""
echo "===== ① 生成 manifest.json（v2）"
MANIFEST_ARGS=(
  generate
  --product "$PRODUCT_DIR"
  --channel "$CHANNEL"
  --platform windows
  --version "$VERSION"
  --build "$BUILD"
  --min-os "$MIN_OS"
  --key-id "$KEY_ID"
  --artifact "portable=$ZIP_PATH"
  --key "$SIGN_KEY"
  --out "$MANIFEST_LOCAL"
)
if [ -n "$SETUP_PATH" ] && [ -f "$SETUP_PATH" ]; then
  MANIFEST_ARGS+=(--artifact "setup=$SETUP_PATH")
fi
[ -n "$NOTES_URL" ] && MANIFEST_ARGS+=(--notes-url "$NOTES_URL")
python3 "$MANIFEST_V2_PY" "${MANIFEST_ARGS[@]}"

echo "  已生成：$MANIFEST_LOCAL"
[ -n "$NOTES_URL" ] && echo "  notes_url: $NOTES_URL" || echo "  notes_url: (未设置)"
PUB_HEX="$(python3 "$MANIFEST_V2_PY" pubkey --key "$SIGN_KEY" | sed 's/.*：//')"

# ---- ② 发布门禁（三仓库共用 tools/release/guard.py，v2 规则）----
GUARD_PY="${GUARD_PY:-$REPO_ROOT/tools/release/guard.py}"
GUARD_ARGS=(
  --product "$PRODUCT_DIR" --kind win --channel "$CHANNEL"
  --schema v2 --manifest "$MANIFEST_LOCAL" --pub-hex "$PUB_HEX" --build "$BUILD"
)
if [ -n "$SETUP_PATH" ] && [ -f "$SETUP_PATH" ]; then
  GUARD_ARGS+=(--file "$SETUP_PATH" --name "$V2_SETUP_NAME"
               --zip "$ZIP_PATH" --zip-name "$V2_ZIP_NAME")
else
  GUARD_ARGS+=(--file "$ZIP_PATH" --name "$V2_ZIP_NAME")
fi
[ "$SKIP_UPLOAD" = "true" ] && GUARD_ARGS+=(--offline)
echo ""
echo "===== ② 发布门禁"
python3 "$GUARD_PY" preflight "${GUARD_ARGS[@]}"

# ---- ③ 上传 OSS ----
oss_upload() {
  local LP="$1" OK="$2" CC="$3" CT="$4"
  "$OSS_PY" - "$OSS_BUCKET" "$OSS_REGION" "$OSS_ACCESS_KEY_ID" "$OSS_ACCESS_KEY_SECRET" \
    "$LP" "$OK" "$CC" "$CT" <<'PY_EOF'
import sys, oss2
bucket, region, ak, sk, lp, ok, cc, ct = sys.argv[1:]
endpoint = f"https://oss-{region}.aliyuncs.com"
bkt = oss2.Bucket(oss2.Auth(ak, sk), endpoint, bucket)
with open(lp, "rb") as f:
    bkt.put_object(ok, f, headers={"Cache-Control": cc, "Content-Type": ct})
print(f"  ✓ {ok}  ({ct}, {cc})")
PY_EOF
}

if [ "$SKIP_UPLOAD" = "true" ]; then
  echo ""
  echo "===== ③ [SKIP_UPLOAD] 跳过上传"
else
  echo ""
  echo "===== ③ 上传"
  [ -f "$OSS_ENV_FILE" ] || { echo "缺少 OSS 凭据文件：$OSS_ENV_FILE" >&2; exit 1; }
  set -a; . "$OSS_ENV_FILE"; set +a
  for v in OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_BUCKET OSS_REGION; do
    eval "[ -n \"\${$v:-}\" ]" || { echo "缺少环境变量 $v" >&2; exit 1; }
  done
  OSS_PY="${OSS_PY:-$HOME/.venv-oss/bin/python}"
  [ -x "$OSS_PY" ] || { echo "缺少 oss2 环境：$OSS_PY" >&2; exit 1; }
  oss_upload "$ZIP_PATH" "$PRODUCT_DIR/$V2_ZIP_NAME" \
    "public, max-age=31536000, immutable" "application/zip"
  if [ -n "$SETUP_PATH" ] && [ -f "$SETUP_PATH" ]; then
    oss_upload "$SETUP_PATH" "$PRODUCT_DIR/$V2_SETUP_NAME" \
      "public, max-age=31536000, immutable" "application/octet-stream"
  fi
  if [ -n "$NOTES_FILE" ]; then
    oss_upload "$NOTES_FILE" "$PRODUCT_DIR/release-notes-$VERSION.html" \
      "public, max-age=3600" "text/html; charset=utf-8"
  fi
  oss_upload "$MANIFEST_LOCAL" "$MANIFEST_KEY" \
    "no-cache, max-age=60" "application/json"
fi

# ---- ④ 线上校验 ----
echo ""
echo "===== ④ 线上校验"
if [ "$SKIP_UPLOAD" = "true" ]; then
  echo "  （跳过）本地清单：$MANIFEST_LOCAL"
else
  CODE="$(curl -s -o /tmp/mote-win-manifest-check.json -w '%{http_code}' "$MANIFEST_URL")"
  echo "  GET $MANIFEST_URL → HTTP $CODE"
  if [ "$CODE" = "200" ] \
    && grep -q "\"version\":[[:space:]]*\"$VERSION\"" /tmp/mote-win-manifest-check.json \
    && grep -q "\"sha256\":[[:space:]]*\"$ZIP_SHA256\"" /tmp/mote-win-manifest-check.json; then
    echo "  ✓ 线上 manifest.json 版本与 SHA256 均与产物一致"
  else
    echo "  ✗ 线上 manifest.json 异常，请检查 CDN 缓存或上传结果"
  fi
  rm -f /tmp/mote-win-manifest-check.json
  echo "  -- 统一门禁 verify-live --"
  python3 "$GUARD_PY" verify-live "${GUARD_ARGS[@]}"
fi

echo ""
echo "================ 完成 ================"
echo "版本 / build： $VERSION / $BUILD"
echo "绿色包：    $ZIP_URL"
echo "安装包：    ${SETUP_URL:-（无）}"
echo "SHA256：    $ZIP_SHA256"
echo "manifest.json：$MANIFEST_URL"
