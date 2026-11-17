#!/usr/bin/env bash
# Mote · Windows 在线更新发布（OSS 清单）
#
# 输入：绿色包 zip（必需）+ 安装包 setup.exe（可选）
# 动作：算 SHA256 → 生成 windows.json → 上传 dl.xiaotu.online → 校验线上可读
#
# 与 macOS 的分工：
#   Windows 不用 Sparkle，客户端（platform/win/updater.cpp）自己读 windows.json、
#   下载、校验 SHA256、静默安装 / 提示手动替换。
#   setup_url 非空时优先安装版静默升级；缺失则回落到绿色包 zip。
#
# 目录约定：
#   oss://<bucket>/mote/<zip 文件名>
#   oss://<bucket>/mote/<setup 文件名>       （可选）
#   oss://<bucket>/mote/updates/stable/windows.json
#
# 用法：
#   packaging/publish_windows.sh                          # 从 dist/ 自动找 zip
#   ZIP_PATH=/path/to/portable.zip \
#   SETUP_PATH=/path/to/setup.exe \
#   packaging/publish_windows.sh
#   NOTES_URL=https://... packaging/publish_windows.sh    # 附带发布说明链接

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(sed -n 's/^VERSION[[:space:]]*=[[:space:]]*\([0-9.]*\).*/\1/p' Mote.pro | head -1)}"
[ -n "$VERSION" ] || { echo "无法确定 VERSION" >&2; exit 1; }

CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in stable|beta) ;; *) echo "CHANNEL 必须是 stable/beta" >&2; exit 2 ;; esac

CDN_DOMAIN="${CDN_DOMAIN:-https://dl.xiaotu.online}"
PRODUCT_DIR="${PRODUCT_DIR:-mote}"
MIN_OS="${MIN_OS:-10.0}"
SKIP_UPLOAD="${SKIP_UPLOAD:-false}"
OSS_ENV_FILE="${OSS_ENV_FILE:-$HOME/.config/xiaotu-updates/.env}"
NOTES_URL="${NOTES_URL:-}"
# notes_url 会原样写进清单并被客户端打开，必须是绝对 http(s) 地址；
# 相对路径（如 /mote/release-notes-x.html）会让「查看完整更新说明…」打不开
if [ -n "$NOTES_URL" ]; then
  case "$NOTES_URL" in
    http://*|https://*) ;;
    *) echo "NOTES_URL 必须是绝对 http(s) 地址：$NOTES_URL" >&2; exit 2 ;;
  esac
fi

# ---- 定位产物 ----
ZIP_PATH="${ZIP_PATH:-$REPO_ROOT/dist/Mote-$VERSION-win64-portable.zip}"
SETUP_PATH="${SETUP_PATH:-}"

if [ ! -f "$ZIP_PATH" ]; then
  # dist/ 下找任何 Mote*-win64*.zip
  ZIP_PATH="$(find "$REPO_ROOT/dist" -maxdepth 1 -name "Mote*-win64*.zip" | head -1 || true)"
fi
[ -n "$ZIP_PATH" ] && [ -f "$ZIP_PATH" ] || { echo "绿色包 zip 不存在：$ZIP_PATH" >&2; exit 1; }

if [ -z "$SETUP_PATH" ] || [ ! -f "$SETUP_PATH" ]; then
  SETUP_PATH="$(find "$REPO_ROOT/dist" -maxdepth 1 -iname "*setup*.exe" | head -1 || true)"
fi

ZIP_BASENAME="$(basename "$ZIP_PATH")"
ZIP_SIZE="$(stat -f %z "$ZIP_PATH")"
ZIP_SHA256="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
ZIP_URL="$CDN_DOMAIN/$PRODUCT_DIR/$ZIP_BASENAME"

MANIFEST_KEY="$PRODUCT_DIR/updates/$CHANNEL/windows.json"
MANIFEST_URL="$CDN_DOMAIN/$MANIFEST_KEY"
PUB_ISO="$(LC_ALL=C date -u '+%Y-%m-%dT%H:%M:%SZ')"

echo "===== Mote Windows 发布 · $VERSION / $CHANNEL ====="
echo "绿色包：    $ZIP_PATH ($ZIP_SIZE B)"
echo "SHA256：    $ZIP_SHA256"
if [ -n "$SETUP_PATH" ] && [ -f "$SETUP_PATH" ]; then
  SETUP_BASENAME="$(basename "$SETUP_PATH")"
  SETUP_SIZE="$(stat -f %z "$SETUP_PATH")"
  SETUP_SHA256="$(shasum -a 256 "$SETUP_PATH" | awk '{print $1}')"
  SETUP_URL="$CDN_DOMAIN/$PRODUCT_DIR/$SETUP_BASENAME"
  echo "安装包：    $SETUP_PATH ($SETUP_SIZE B)"
  echo "Setup SHA256：$SETUP_SHA256"
else
  SETUP_BASENAME=""; SETUP_SIZE=""; SETUP_SHA256=""; SETUP_URL=""
  echo "安装包：    （未提供，仅发布绿色包）"
fi
echo "清单地址：  $MANIFEST_URL"

# ---- ① 生成 windows.json ----
echo ""
echo "===== ① 生成 windows.json"
MANIFEST_LOCAL="$REPO_ROOT/dist/windows.json"

json_escape() {
  # 把字符串转义成 JSON 安全值（处理 \ 和 "）
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

ZIP_URL_ESC="$(json_escape "$ZIP_URL")"
ZIP_SHA256_ESC="$(json_escape "$ZIP_SHA256")"
PUB_ISO_ESC="$(json_escape "$PUB_ISO")"
MIN_OS_ESC="$(json_escape "$MIN_OS")"

{
  printf '{\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "url": "%s",\n' "$ZIP_URL_ESC"
  printf '  "size": %s,\n' "$ZIP_SIZE"
  printf '  "sha256": "%s",\n' "$ZIP_SHA256_ESC"
  printf '  "min_os": "%s",\n' "$MIN_OS_ESC"
  printf '  "published_at": "%s"' "$PUB_ISO_ESC"
  if [ -n "$SETUP_URL" ]; then
    SETUP_URL_ESC="$(json_escape "$SETUP_URL")"
    SETUP_SHA256_ESC="$(json_escape "$SETUP_SHA256")"
    printf ',\n  "setup_url": "%s",\n' "$SETUP_URL_ESC"
    printf '  "setup_size": %s,\n' "$SETUP_SIZE"
    printf '  "setup_sha256": "%s"' "$SETUP_SHA256_ESC"
  fi
  if [ -n "$NOTES_URL" ]; then
    NOTES_URL_ESC="$(json_escape "$NOTES_URL")"
    printf ',\n  "notes_url": "%s"' "$NOTES_URL_ESC"
  fi
  printf '\n}\n'
} > "$MANIFEST_LOCAL"

echo "  已生成：$MANIFEST_LOCAL"
[ -n "$NOTES_URL" ] && echo "  notes_url: $NOTES_URL" || echo "  notes_url: (未设置)"
python3 -c "import json; json.load(open('$MANIFEST_LOCAL'))" 2>/dev/null \
  && echo "  ✓ JSON 格式校验通过" \
  || { echo "  ✗ JSON 格式错误" >&2; exit 1; }

# ---- ② 上传 OSS ----
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
  echo "===== ② [SKIP_UPLOAD] 跳过上传"
else
  echo ""
  echo "===== ② 上传"
  [ -f "$OSS_ENV_FILE" ] || { echo "缺少 OSS 凭据文件：$OSS_ENV_FILE" >&2; exit 1; }
  set -a; . "$OSS_ENV_FILE"; set +a
  for v in OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_BUCKET OSS_REGION; do
    eval "[ -n \"\${$v:-}\" ]" || { echo "缺少环境变量 $v" >&2; exit 1; }
  done
  OSS_PY="${OSS_PY:-$HOME/.venv-oss/bin/python}"
  [ -x "$OSS_PY" ] || { echo "缺少 oss2 环境：$OSS_PY" >&2; exit 1; }
  oss_upload "$ZIP_PATH" "$PRODUCT_DIR/$ZIP_BASENAME" \
    "public, max-age=31536000, immutable" "application/zip"
  if [ -n "$SETUP_URL" ]; then
    oss_upload "$SETUP_PATH" "$PRODUCT_DIR/$SETUP_BASENAME" \
      "public, max-age=31536000, immutable" "application/octet-stream"
  fi
  oss_upload "$MANIFEST_LOCAL" "$MANIFEST_KEY" \
    "no-cache, max-age=300" "application/json"
fi

# ---- ③ 线上校验 ----
echo ""
echo "===== ③ 线上校验"
if [ "$SKIP_UPLOAD" = "true" ]; then
  echo "  （跳过）本地清单：$MANIFEST_LOCAL"
else
  CODE="$(curl -s -o /tmp/mote-win-manifest-check.json -w '%{http_code}' "$MANIFEST_URL")"
  echo "  GET $MANIFEST_URL → HTTP $CODE"
  if [ "$CODE" = "200" ] \
    && grep -q "\"version\":[[:space:]]*\"$VERSION\"" /tmp/mote-win-manifest-check.json \
    && grep -q "\"sha256\":[[:space:]]*\"$ZIP_SHA256\"" /tmp/mote-win-manifest-check.json; then
    echo "  ✓ 线上 windows.json 版本与 SHA256 均与产物一致"
  else
    echo "  ✗ 线上 windows.json 异常，请检查 CDN 缓存或上传结果"
  fi
  rm -f /tmp/mote-win-manifest-check.json
fi

echo ""
echo "================ 完成 ================"
echo "版本：      $VERSION"
echo "绿色包：    $ZIP_URL"
echo "安装包：    ${SETUP_URL:-（无）}"
echo "SHA256：    $ZIP_SHA256"
echo "windows.json：$MANIFEST_URL"
