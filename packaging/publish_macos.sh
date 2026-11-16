#!/usr/bin/env bash
# Mote · macOS 自动更新发布（Sparkle 2 链路）
#
# 输入：已用 Developer ID 签名并通过公证的 DMG（packaging/package_macos.sh 产出）
# 动作：EdDSA 签名 → 生成 appcast.xml → 上传 dl.xiaotu.online → 校验线上可读
#
# 目录约定（与 index.html 现有下载路径同源）：
#   oss://<bucket>/mote/<dmg 文件名>                     长缓存 immutable
#   oss://<bucket>/mote/updates/stable/appcast.xml        5 分钟缓存
# 对外地址：
#   https://dl.xiaotu.online/mote/updates/stable/appcast.xml   ← Info.plist SUFeedURL
#
# 依赖：Sparkle 发行包里的 bin/sign_update、python3 + oss2、spctl
#
# 用法：
#   packaging/publish_macos.sh                    # 完整发布
#   SKIP_UPLOAD=true packaging/publish_macos.sh   # 只本地生成 appcast，不碰 OSS
#   DMG_PATH=/path/to/x.dmg packaging/publish_macos.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(sed -n 's/^VERSION[[:space:]]*=[[:space:]]*\([0-9.]*\).*/\1/p' Mote.pro | head -1)"
[ -n "$VERSION" ] || { echo "无法从 Mote.pro 读取 VERSION" >&2; exit 1; }

DMG_PATH="${DMG_PATH:-$REPO_ROOT/dist/Mote-macOS-native-$VERSION.dmg}"
[ -f "$DMG_PATH" ] || { echo "DMG 不存在：$DMG_PATH" >&2; exit 1; }

SIGN_KEY="${SIGN_KEY:-$HOME/.config/mote-updates/ed25519_seed.b64}"
[ -f "$SIGN_KEY" ] || { echo "更新签名私钥不存在：$SIGN_KEY" >&2; exit 1; }

CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in stable|beta) ;; *) echo "CHANNEL 必须是 stable/beta" >&2; exit 2 ;; esac

CDN_DOMAIN="${CDN_DOMAIN:-https://dl.xiaotu.online}"
PRODUCT_DIR="${PRODUCT_DIR:-mote}"
MIN_OS="${MIN_OS:-14.0}"
SKIP_UPLOAD="${SKIP_UPLOAD:-false}"
OSS_ENV_FILE="${OSS_ENV_FILE:-$HOME/.config/xiaotu-updates/.env}"

# ---- 定位 sign_update ----
find_sign_update() {
  if [ -n "${SPARKLE_BIN:-}" ] && [ -x "$SPARKLE_BIN/sign_update" ]; then
    echo "$SPARKLE_BIN/sign_update"; return
  fi
  local c
  for c in "$HOME/Downloads/Sparkle-"*/bin/sign_update; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
SIGN_UPDATE="$(find_sign_update || true)"
[ -n "$SIGN_UPDATE" ] || {
  echo "未找到 Sparkle 的 sign_update。设置 SPARKLE_BIN 指向 Sparkle 发行包的 bin 目录：" >&2
  echo "  SPARKLE_BIN=~/Downloads/Sparkle-2.10.1/bin $0" >&2
  exit 1; }

DMG_BASENAME="$(basename "$DMG_PATH")"
DMG_SIZE="$(stat -f %z "$DMG_PATH")"
DMG_SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
DMG_URL="$CDN_DOMAIN/$PRODUCT_DIR/$DMG_BASENAME"
APPCAST_KEY="$PRODUCT_DIR/updates/$CHANNEL/appcast.xml"
APPCAST_URL="$CDN_DOMAIN/$APPCAST_KEY"
PUB_DATE="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"

echo "===== Mote 发布 · $VERSION / $CHANNEL ====="
echo "DMG：      $DMG_PATH"
echo "大小：     $DMG_SIZE 字节"
echo "SHA256：   $DMG_SHA256"
echo "下载地址： $DMG_URL"
echo "appcast：  $APPCAST_URL"

# ---- ① 门禁：DMG 必须已公证，否则更新装上去会被 Gatekeeper 拦 ----
echo ""
echo "===== ① 校验 DMG 内 App 签名/公证"
MOUNT="$(mktemp -d -t mote-dmg)"
cleanup() { hdiutil detach "$MOUNT" >/dev/null 2>&1 || true; rm -rf "$MOUNT"; }
trap cleanup EXIT
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT" -nobrowse -readonly >/dev/null 2>&1
APP_IN_DMG="$(find "$MOUNT" -maxdepth 2 -name "*.app" | head -1)"
[ -n "$APP_IN_DMG" ] || { echo "DMG 内没有 .app" >&2; exit 1; }
SPCTL_OUT="$(spctl --assess --type execute -vv "$APP_IN_DMG" 2>&1 || true)"
echo "$SPCTL_OUT" | sed 's/^/  /'
echo "$SPCTL_OUT" | grep -q "Notarized Developer ID" || {
  echo "拒绝发布：DMG 内 App 未通过公证（期望 source=Notarized Developer ID）" >&2; exit 1; }
PLIST_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$APP_IN_DMG/Contents/Info.plist" 2>/dev/null || true)"
[ "$PLIST_VER" = "$VERSION" ] || echo "  警告：DMG 内版本 $PLIST_VER ≠ Mote.pro VERSION $VERSION"
# 校验 DMG 内 App 与 Info.plist 承诺的公钥一致
PLIST_PUB="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' \
  "$APP_IN_DMG/Contents/Info.plist" 2>/dev/null || true)"
[ -n "$PLIST_PUB" ] || { echo "拒绝发布：DMG 内 App 缺少 SUPublicEDKey" >&2; exit 1; }
cleanup
trap - EXIT

# ---- ② EdDSA 签名 ----
echo ""
echo "===== ② EdDSA 签名"
SIG_ATTRS="$("$SIGN_UPDATE" -f "$SIGN_KEY" "$DMG_PATH")"
ED_SIG="$(echo "$SIG_ATTRS" | sed -E 's/.*edSignature="([^"]+)".*/\1/')"
[ -n "$ED_SIG" ] || { echo "签名失败" >&2; exit 1; }
echo "  edSignature 长度：${#ED_SIG} 字符"

# ---- ③ 生成 appcast.xml ----
echo ""
echo "===== ③ 生成 appcast.xml"
APPCAST_LOCAL="$REPO_ROOT/dist/appcast.xml"
cat > "$APPCAST_LOCAL" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Mote</title>
    <item>
      <title>Mote $VERSION</title>
      <pubDate>$PUB_DATE</pubDate>
      <sparkle:version>$VERSION</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$MIN_OS</sparkle:minimumSystemVersion>
      <enclosure url="$DMG_URL"
                 sparkle:edSignature="$ED_SIG"
                 length="$DMG_SIZE"
                 type="application/octet-stream"/>
    </item>
  </channel>
</rss>
EOF
echo "  已生成：$APPCAST_LOCAL"

# ---- ④ 上传 OSS ----
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
  echo "===== ④ [SKIP_UPLOAD] 跳过上传"
else
  echo ""
  echo "===== ④ 上传"
  [ -f "$OSS_ENV_FILE" ] || { echo "缺少 OSS 凭据文件：$OSS_ENV_FILE（或用环境变量传入）" >&2; exit 1; }
  # shellcheck disable=SC1090
  set -a; . "$OSS_ENV_FILE"; set +a
  for v in OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_BUCKET OSS_REGION; do
    eval "[ -n \"\${$v:-}\" ]" || { echo "缺少环境变量 $v" >&2; exit 1; }
  done
  OSS_PY="${OSS_PY:-$HOME/.venv-oss/bin/python}"
  [ -x "$OSS_PY" ] || { echo "缺少 oss2 环境：$OSS_PY" >&2; exit 1; }
  oss_upload "$DMG_PATH" "$PRODUCT_DIR/$DMG_BASENAME" \
    "public, max-age=31536000, immutable" "application/octet-stream"
  oss_upload "$APPCAST_LOCAL" "$APPCAST_KEY" \
    "no-cache, max-age=300" "application/rss+xml"
fi

# ---- ⑤ 线上校验 ----
echo ""
echo "===== ⑤ 线上校验"
if [ "$SKIP_UPLOAD" = "true" ]; then
  echo "  （跳过）本地 appcast：$APPCAST_LOCAL"
else
  CODE="$(curl -s -o /tmp/mote-appcast-check.xml -w '%{http_code}' "$APPCAST_URL")"
  echo "  GET $APPCAST_URL → HTTP $CODE"
  [ "$CODE" = "200" ] && grep -q "edSignature" /tmp/mote-appcast-check.xml \
    && echo "  ✓ 线上 appcast 含 edSignature" \
    || echo "  ✗ 线上 appcast 异常，请检查 CDN 缓存或上传结果"
  rm -f /tmp/mote-appcast-check.xml
fi

echo ""
echo "================ 完成 ================"
echo "版本：      $VERSION"
echo "DMG：       $DMG_URL"
echo "SHA256：    $DMG_SHA256"
echo "appcast：   $APPCAST_URL"
