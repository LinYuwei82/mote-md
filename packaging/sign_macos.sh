#!/usr/bin/env bash
# Mote · macOS DMG 签名（只签名与生成清单，不上传）
#
# 用途：对已经打好的 DMG 生成 Sparkle EdDSA 签名，并在 dist/ 下产出
# appcast.xml（Sparkle 用）。manifest.json（v2）与上传仍交给 tools/release/publish_macos.sh。
#
# 与 publish_macos.sh 的分工：
#   sign_macos.sh     只做签名与清单生成：不联网、不需要 OSS 凭据
#   publish_macos.sh  完整发布：公证门禁 → 签名 → 清单 → 上传 → 线上校验
#
# 本脚本默认不强制公证：检测到未公证只告警并继续（ALLOW_UNNOTARIZED=1 可静默）。
# 这样在还没买 Apple Developer ID 的阶段也能先生成签名清单。
#
# 依赖：Sparkle 发行包里的 bin/sign_update；hdiutil/spctl 可选（用于提示公证状态）
#
# 用法：
#   packaging/sign_macos.sh                              # 默认 dist/Mote-macOS-native-<版本>.dmg
#   packaging/sign_macos.sh path/to/Mote.dmg
#   SPARKLE_BIN=~/Downloads/Sparkle-2.10.1/bin packaging/sign_macos.sh
#   SIGN_KEY=~/keys/ed25519_seed.b64 packaging/sign_macos.sh
#   NOTES_URL=https://dl.xiaotu.online/mote/release-notes-1.0.1.html packaging/sign_macos.sh
#   ALLOW_UNNOTARIZED=1 packaging/sign_macos.sh
#
# 环境变量：
#   SPARKLE_BIN         Sparkle 发行包的 bin 目录（含 sign_update）
#   SIGN_KEY            EdDSA 私钥文件，默认 $HOME/.config/mote-updates/ed25519_seed.b64
#   NOTES_URL           可选，非空时写进 manifest.json 的 notes_url（见 publish_macos.sh）
#   MIN_OS              默认 14.0
#   CHANNEL             stable|beta，默认 stable
#   CDN_DOMAIN          默认 https://dl.xiaotu.online
#   PRODUCT_DIR         默认 mote
#   ALLOW_UNNOTARIZED   设为 1 时未公证不告警中断

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

die() { echo "[失败] $*" >&2; exit 1; }

VERSION="$(tr -d '[:space:]' < VERSION.txt)"
[ -n "$VERSION" ] || die "无法从 VERSION.txt 读取版本号"

DMG_PATH="${1:-${DMG_PATH:-$REPO_ROOT/dist/Mote-macOS-native-$VERSION.dmg}}"
[ -f "$DMG_PATH" ] || die "DMG 不存在：$DMG_PATH"
DMG_PATH="$(cd "$(dirname "$DMG_PATH")" && pwd)/$(basename "$DMG_PATH")"

SIGN_KEY="${SIGN_KEY:-$HOME/.config/mote-updates/ed25519_seed.b64}"
[ -f "$SIGN_KEY" ] || die "更新签名私钥不存在：$SIGN_KEY
首次使用可先在 Mac 上运行 Sparkle 的 generate_keys 生成密钥对：
  \$SPARKLE_BIN/generate_keys
然后把导出的私钥放到 ${SIGN_KEY}（或用 SIGN_KEY 指向它）。
公钥必须与 App 的 Info.plist 里 SUPublicEDKey 一致。"

CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in stable|beta) ;; *) die "CHANNEL 必须是 stable/beta" ;; esac
CDN_DOMAIN="${CDN_DOMAIN:-https://dl.xiaotu.online}"
PRODUCT_DIR="${PRODUCT_DIR:-mote}"
MIN_OS="${MIN_OS:-14.0}"
NOTES_URL="${NOTES_URL:-}"
ALLOW_UNNOTARIZED="${ALLOW_UNNOTARIZED:-0}"

# ---- 定位 sign_update ----
find_sign_update() {
  if [ -n "${SPARKLE_BIN:-}" ] && [ -x "$SPARKLE_BIN/sign_update" ]; then
    echo "$SPARKLE_BIN/sign_update"; return 0
  fi
  local c
  for c in "$HOME/Downloads/Sparkle-"*/bin/sign_update \
           "$REPO_ROOT"/third_party/Sparkle*/bin/sign_update; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
SIGN_UPDATE="$(find_sign_update || true)"
[ -n "$SIGN_UPDATE" ] || die "未找到 Sparkle 的 sign_update。
设置 SPARKLE_BIN 指向 Sparkle 发行包的 bin 目录：
  SPARKLE_BIN=~/Downloads/Sparkle-2.10.1/bin $0"

DMG_BASENAME="$(basename "$DMG_PATH")"
DMG_SIZE="$(stat -f %z "$DMG_PATH")"
DMG_SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
DMG_URL="$CDN_DOMAIN/$PRODUCT_DIR/$DMG_BASENAME"
PUB_DATE="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
PUB_ISO="$(LC_ALL=C date -u '+%Y-%m-%dT%H:%M:%SZ')"

echo "===== Mote macOS 签名 · $VERSION / $CHANNEL ====="
echo "  DMG      : $DMG_PATH"
echo "  大小     : $DMG_SIZE 字节"
echo "  SHA256   : $DMG_SHA256"
echo "  下载地址 : $DMG_URL"

# ---- ① 公证状态（只提示，不阻断）----
echo ""
echo "===== ① 公证状态"
MOUNT=""
cleanup() {
  if [ -n "$MOUNT" ]; then
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
    rm -rf "$MOUNT"
  fi
}
trap cleanup EXIT
if command -v hdiutil >/dev/null 2>&1; then
  MOUNT="$(mktemp -d -t mote-sign)"
  if hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT" -nobrowse -readonly >/dev/null 2>&1; then
    APP_IN_DMG="$(find "$MOUNT" -maxdepth 2 -name "*.app" | head -1)"
    if [ -n "$APP_IN_DMG" ]; then
      PLIST_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
        "$APP_IN_DMG/Contents/Info.plist" 2>/dev/null || true)"
      [ -n "$PLIST_VER" ] && [ "$PLIST_VER" != "$VERSION" ] && \
        echo "  警告：DMG 内 App 版本 $PLIST_VER ≠ VERSION.txt 版本 $VERSION"
      if command -v spctl >/dev/null 2>&1; then
        SPCTL_OUT="$(spctl --assess --type execute -vv "$APP_IN_DMG" 2>&1 || true)"
        case "$SPCTL_OUT" in
          *"Notarized Developer ID"*)
            echo "  已公证（Notarized Developer ID）" ;;
          *)
            if [ "$ALLOW_UNNOTARIZED" = "1" ]; then
              echo "  未公证：按 ALLOW_UNNOTARIZED=1 继续（更新安装时 Gatekeeper 可能拦截）"
            else
              echo "  未公证：签名与清单仍会生成，但用户安装时 Gatekeeper 可能拦截。"
              echo "  确认要继续请加 ALLOW_UNNOTARIZED=1。"
              exit 3
            fi ;;
        esac
      fi
    else
      echo "  提示：DMG 内没找到 .app，跳过公证检查"
    fi
  else
    echo "  提示：无法挂载 DMG，跳过公证检查"
  fi
fi
cleanup
trap - EXIT

# ---- ② EdDSA 签名 ----
echo ""
echo "===== ② EdDSA 签名"
SIG_ATTRS="$("$SIGN_UPDATE" -f "$SIGN_KEY" "$DMG_PATH")"
ED_SIG="$(echo "$SIG_ATTRS" | sed -E 's/.*edSignature="([^"]+)".*/\1/')"
[ -n "$ED_SIG" ] && [ "$ED_SIG" != "$SIG_ATTRS" ] || die "签名失败，sign_update 输出：$SIG_ATTRS"
echo "  edSignature 长度：${#ED_SIG} 字符"

# ---- ③ 生成 appcast.xml ----
echo ""
echo "===== ③ 生成 appcast.xml"
mkdir -p "$REPO_ROOT/dist"
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

# ---- ④ 清单 ----
# v2 起清单为 manifest.json（Ed25519 签名），由 tools/release/publish_macos.sh
# 与 appcast 一起生成上传；本脚本只做 Sparkle 签名，不再生成 latest.json。

echo ""
echo "===== 完成"
cat <<EOF
  edSignature : $ED_SIG
  下一步：
    1) 把 $DMG_BASENAME 上传到 oss://<bucket>/$PRODUCT_DIR/mote-$VERSION-macos-arm64.dmg
       （v2 命名；或直接运行 tools/release/publish_macos.sh 走完整发布，会重做签名与校验）
    2) 上传 dist/appcast.xml 到 oss://<bucket>/$PRODUCT_DIR/updates/$CHANNEL/
    3) manifest.json 由 publish_macos.sh 生成并上传
EOF
