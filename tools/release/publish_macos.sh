#!/usr/bin/env bash
# Mote · macOS 在线更新发布（OSS 清单 + Sparkle 安装，更新清单 Schema v2）
#
# 输入：已用 Developer ID 签名并通过公证的 DMG（packaging/package_macos.sh 产出）
# 动作：EdDSA 签名 → 生成 appcast.xml 与 manifest.json（v2）→ 上传 dl.xiaotu.online → 校验线上可读
#
# 两个清单的分工：
#   appcast.xml    给 Sparkle 用：下载地址 + EdDSA 签名，Sparkle 验签后才安装（不在 v2 范围）
#   manifest.json  统一 Schema v2 清单：platforms.macos + Ed25519 签名（见 docs/更新清单Schema-v2.md）
# v1 清单（latest.json / windows.json）已于 2026-11-18 全量删除；
# 本脚本只生成 manifest.json（v2）+ appcast.xml。
#
# 目录约定（与 index.html 现有下载路径同源）：
#   oss://<bucket>/mote/mote-<ver>-macos-arm64.dmg            长缓存 immutable（v2 命名）
#   oss://<bucket>/mote/updates/stable/appcast.xml             60 秒缓存
#   oss://<bucket>/mote/updates/stable/manifest.json           60 秒缓存
#   oss://<bucket>/mote/release-notes-<ver>.html               3600 秒缓存（仓库存在说明页时）
# 对外地址：
#   https://dl.xiaotu.online/mote/updates/stable/appcast.xml    ← Info.plist SUFeedURL
#   https://dl.xiaotu.online/mote/updates/stable/manifest.json  ← 自研检查读取
#   https://dl.xiaotu.online/mote/release-notes-<ver>.html      ← 清单 notes_url
#
# 说明页：未传 NOTES_URL 时自动检测 docs/release-notes-<ver>.html，上传并写进清单；
#         传了 NOTES_URL 则以传入的绝对地址为准（页面需自行保证可访问）。
#
# 依赖：Sparkle 发行包里的 bin/sign_update、python3 + oss2、spctl
#
# 用法：
#   tools/release/publish_macos.sh                    # 完整发布
#   SKIP_UPLOAD=true tools/release/publish_macos.sh   # 只本地生成清单，不碰 OSS
#   DMG_PATH=/path/to/x.dmg tools/release/publish_macos.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(tr -d '[:space:]' < VERSION.txt)"
[ -n "$VERSION" ] || { echo "无法从 VERSION.txt 读取版本号" >&2; exit 1; }

# 构建号：纯数字、单调递增。必须与 package_macos.sh 构建时注入 Info.plist 的值一致，
# 否则客户端 Sparkle 版本比较 / 自研清单 build 比对会出问题。
# 2026-11-20 起：必填（macOS 也要求 build > 0，和 Windows 对齐）。
# 构建号：自动从 gen_build.py 生成（year*10^12 + git_count，单调递增，自动校验 > 线上）。
# 用户显式传 MOTE_BUILD 时优先使用（兼容手动指定场景）。
if [ -n "${MOTE_BUILD:-}" ]; then
  BUILD="$MOTE_BUILD"
  [[ "$BUILD" =~ ^[0-9]+$ ]] || { echo "MOTE_BUILD 必须是纯数字：$BUILD" >&2; exit 1; }
else
  BUILD="$(python3 "$REPO_ROOT/tools/release/gen_build.py" \
    --product mote --repo-root "$REPO_ROOT")" || {
    echo "gen_build.py 失败，无法生成构建号" >&2; exit 1; }
fi
echo "版本/构建号：${VERSION} / ${BUILD}"

DMG_PATH="${DMG_PATH:-$REPO_ROOT/dist/Mote-macOS-native-$VERSION.dmg}"
[ -f "$DMG_PATH" ] || { echo "DMG 不存在：$DMG_PATH" >&2; exit 1; }

SIGN_KEY="${SIGN_KEY:-$HOME/.config/mote-updates/ed25519_seed.b64}"
[ -f "$SIGN_KEY" ] || { echo "更新签名私钥不存在：$SIGN_KEY" >&2; exit 1; }

# Sparkle appcast 签名复用 SIGN_KEY（与 v2 清单共用同一把 Ed25519 key）
# ← 2026-11-20 起合并，对齐小兔方案；之前 manifest + Sparkle 各一把独立密钥已废弃。
SPARKLE_KEY="$SIGN_KEY"

CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in stable|beta) ;; *) echo "CHANNEL 必须是 stable/beta" >&2; exit 2 ;; esac

CDN_DOMAIN="${CDN_DOMAIN:-https://dl.xiaotu.online}"
PRODUCT_DIR="${PRODUCT_DIR:-mote}"
MIN_OS="${MIN_OS:-14.0}"
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
# 未显式指定时，优先找 docs/release-notes-<版本>.html；没有 .html 但有 .md 时
# 自动用 Python markdown 库转成 .html 到 docs/ 目录（客户端浏览器需要 html 渲染）。
# 两个平台的清单都写同一个 <product>/release-notes-<版本>.html 地址。
# 没有说明页则不写 notes_url，避免客户端出现死链。
NOTES_FILE=""
find_notes_file() {
  local ver md_file html_file
  ver="$1"
  md_file="$REPO_ROOT/docs/release-notes-$ver.md"
  html_file="$REPO_ROOT/docs/release-notes-$ver.html"
  # 若 html 不存在，或 html 比 md 旧（用户改了 md 但没删 html），则用 md 重新生成
  if [ ! -f "$html_file" ] || { [ -f "$md_file" ] && [ "$md_file" -nt "$html_file" ]; }; then
    if [ -f "$md_file" ]; then
      if python3 -c 'import markdown' 2>/dev/null; then
        python3 - "$md_file" "$html_file" <<'PYEOF'
import markdown, sys
md_path, html_path = sys.argv[1], sys.argv[2]
css = """
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
     max-width:720px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}
h1{border-bottom:2px solid #eee;padding-bottom:8px}
h2{margin-top:1.5em;color:#111}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}
th{background:#f6f8fa}
code{background:#f0f0f0;padding:1px 6px;border-radius:3px;font-size:.9em}
pre{background:#f6f8fa;padding:12px 16px;border-radius:6px;overflow-x:auto}
pre code{background:none;padding:0}
blockquote{border-left:4px solid #ddd;margin:1em 0;padding:0 16px;color:#666}
"""
md = open(md_path, encoding='utf-8').read()
body = markdown.markdown(md, extensions=['tables','fenced_code'])
full = f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>{css}</style></head><body>{body}</body></html>'
open(html_path, 'w', encoding='utf-8').write(full)
PYEOF
        echo "  (md → html 自动生成 $html_file)"
      else
        echo "⚠️  有 release-notes-$ver.md 但缺 Python markdown 库，跳过转换" >&2
        return 1
      fi
    fi
  fi
  [ -f "$html_file" ] && echo "$html_file"
}
if [ -z "$NOTES_URL" ]; then
  NOTES_FILE="$(find_notes_file "$VERSION" || true)"
  if [ -n "$NOTES_FILE" ]; then
    NOTES_URL="$CDN_DOMAIN/$PRODUCT_DIR/release-notes-$VERSION.html"
  fi
fi

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
# v2 安装包命名：<product>-<version>-<os>-<arch>-<type>.<ext>；本地产物名不变，远端按 v2 命名
V2_DMG_NAME="mote-$VERSION-macos-arm64.dmg"
DMG_URL="$CDN_DOMAIN/$PRODUCT_DIR/$V2_DMG_NAME"
APPCAST_KEY="$PRODUCT_DIR/updates/$CHANNEL/appcast.xml"
APPCAST_URL="$CDN_DOMAIN/$APPCAST_KEY"
MANIFEST_KEY="$PRODUCT_DIR/updates/$CHANNEL/manifest.json"
MANIFEST_URL="$CDN_DOMAIN/$MANIFEST_KEY"
PUB_DATE="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
PUB_ISO="$(LC_ALL=C date -u '+%Y-%m-%dT%H:%M:%SZ')"

echo "===== Mote 发布 · $VERSION / $CHANNEL ====="
echo "DMG：      $DMG_PATH"
echo "远端名（v2）：$V2_DMG_NAME"
echo "大小：     $DMG_SIZE 字节"
echo "SHA256：   $DMG_SHA256"
echo "下载地址： $DMG_URL"
echo "appcast：  $APPCAST_URL"
echo "manifest.json：$MANIFEST_URL"

# ---- ① 门禁：DMG 必须已公证，否则更新装上去会被 Gatekeeper 拦 ----
echo ""
echo "===== ① 校验 DMG 内 App 签名/公证"
MOUNT="$(mktemp -d -t mote-dmg)"
cleanup() { hdiutil detach "$MOUNT" >/dev/null 2>&1 || true; rm -rf "$MOUNT"; }
trap cleanup EXIT
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT" -nobrowse -readonly >/dev/null 2>&1
APP_IN_DMG="$(find "$MOUNT" -maxdepth 2 -name "*.app" | head -1)"
[ -n "$APP_IN_DMG" ] || { echo "DMG 内没有 .app" >&2; exit 1; }
# Sparkle.framework 必须在 DMG 内 App 里，否则自动更新退化为浏览器下载
# （2026-11-19 mote 1.0.4 即因此重发——CMakeLists.txt 检测到缺失只 WARNING 继续构建）
SPARKLE_IN_DMG="$APP_IN_DMG/Contents/Frameworks/Sparkle.framework"
if [ ! -d "$SPARKLE_IN_DMG" ]; then
  echo "拒绝发布：DMG 内 App 缺少 Sparkle.framework！" >&2
  echo "  自动更新将退化为打开浏览器下载（2026-11-19 mote 1.0.4 即因此重发）" >&2
  exit 1
fi
APP_IN_DMG_SIZE_KB=$(du -sk "$APP_IN_DMG" | awk '{print $1}')
if [ "$APP_IN_DMG_SIZE_KB" -lt 1024 ]; then
  echo "拒绝发布：DMG 内 App 体积过小（${APP_IN_DMG_SIZE_KB} KB，含 Sparkle.framework 应 > 1024 KB）" >&2
  exit 1
fi
SPCTL_OUT="$(spctl --assess --type execute -vv "$APP_IN_DMG" 2>&1 || true)"
echo "$SPCTL_OUT" | sed 's/^/  /'
echo "$SPCTL_OUT" | grep -q "Notarized Developer ID" || {
  echo "拒绝发布：DMG 内 App 未通过公证（期望 source=Notarized Developer ID）" >&2; exit 1; }
PLIST_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$APP_IN_DMG/Contents/Info.plist" 2>/dev/null || true)"
[ "$PLIST_VER" = "$VERSION" ] || echo "  警告：DMG 内版本 $PLIST_VER ≠ VERSION $VERSION"
# 校验 DMG 内 App 与 Info.plist 承诺的公钥一致
PLIST_PUB="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' \
  "$APP_IN_DMG/Contents/Info.plist" 2>/dev/null || true)"
[ -n "$PLIST_PUB" ] || { echo "拒绝发布：DMG 内 App 缺少 SUPublicEDKey" >&2; exit 1; }
# feed 地址写死在包内，发错就永远检查不到更新（旧包曾指向已下线的 /mote/appcast.xml）。
PLIST_FEED="$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' \
  "$APP_IN_DMG/Contents/Info.plist" 2>/dev/null || true)"
[ "$PLIST_FEED" = "$APPCAST_URL" ] || {
  echo "拒绝发布：DMG 内 SUFeedURL（${PLIST_FEED:-空}）与发布地址 $APPCAST_URL 不一致" >&2
  echo "  --skip-build 复用旧产物时尤其容易出现；请完整重建后再发布。" >&2
  exit 1; }
echo "  SUFeedURL 与发布地址一致：$PLIST_FEED"
cleanup
trap - EXIT

# ---- ② EdDSA 签名 ----
echo ""
echo "===== ② EdDSA 签名"
SIG_ATTRS="$("$SIGN_UPDATE" -f "$SPARKLE_KEY" "$DMG_PATH")"
# 只取含 edSignature="..." 的那一行；忽略工具可能附带的调试行（历史事故：
# 调试行被拼进 appcast.xml，Sparkle 验签失败，应用内更新报「此更新未正确签名」）
ED_SIG="$(printf '%s\n' "$SIG_ATTRS" | sed -n 's/.*edSignature="\([^"]*\)".*/\1/p' | tail -1)"
[ -n "$ED_SIG" ] || { echo "签名失败：sign_update 输出中未找到 edSignature" >&2; exit 1; }
# Ed25519 签名固定 64 字节 → base64 固定 88 字符；不是 88 说明解析到了脏数据
case "${#ED_SIG}" in
  88) ;;
  *) echo "签名长度异常：${#ED_SIG} 字符（应为 88），拒绝继续" >&2; exit 1 ;;
esac
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

# ---- ④ 生成 manifest.json（统一 Schema v2，Ed25519 签名）----
echo ""
echo "===== ④ 生成 manifest.json（v2）"
MANIFEST_LOCAL="$REPO_ROOT/dist/manifest.json"
# 另一平台段可能已在线上：先取线上清单，--prev 合并后整体重签，避免覆盖另一平台段
if [ ! -s "$MANIFEST_LOCAL" ]; then
  curl -fsSL "$MANIFEST_URL" -o "$MANIFEST_LOCAL" 2>/dev/null || rm -f "$MANIFEST_LOCAL"
fi
MANIFEST_ARGS=(
  generate
  --product "$PRODUCT_DIR"
  --channel "$CHANNEL"
  --platform macos
  --version "$VERSION"
  --build "$BUILD"
  --min-os "$MIN_OS"
  --artifact "dmg=$DMG_PATH"
  --key "$SIGN_KEY"
  --out "$MANIFEST_LOCAL"
)
[ -n "$NOTES_URL" ] && MANIFEST_ARGS+=(--notes-url "$NOTES_URL")
[ -s "$MANIFEST_LOCAL" ] && MANIFEST_ARGS+=(--prev "$MANIFEST_LOCAL")
python3 "$REPO_ROOT/tools/release/manifest_v2.py" "${MANIFEST_ARGS[@]}"

echo "  已生成：$MANIFEST_LOCAL"
[ -n "$NOTES_URL" ] && echo "  notes_url: $NOTES_URL" || echo "  notes_url: (未设置)"
PUB_HEX="$(python3 "$REPO_ROOT/tools/release/manifest_v2.py" pubkey --key "$SIGN_KEY" | sed 's/.*：//')"

# ---- ⑤ 上传 OSS ----
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

# ---- ④b 发布门禁（三仓库共用 tools/release/guard.py，v2 规则）----
GUARD_PY="${GUARD_PY:-$REPO_ROOT/tools/release/guard.py}"
GUARD_ARGS=(
  --product "$PRODUCT_DIR" --kind mac --channel "$CHANNEL"
  --file "$DMG_PATH" --name "$V2_DMG_NAME"
  --manifest "$MANIFEST_LOCAL" --pub-hex "$PUB_HEX"
# 注：guard.py 已移除 --schema 参数（argparse 无此选项），强制 v2
)
[ "$SKIP_UPLOAD" = "true" ] && GUARD_ARGS+=(--offline)
echo ""
echo "===== ④b 发布门禁"
python3 "$GUARD_PY" preflight "${GUARD_ARGS[@]}"

if [ "$SKIP_UPLOAD" = "true" ]; then
  echo ""
  echo "===== ⑤ [SKIP_UPLOAD] 跳过上传"
else
  echo ""
  echo "===== ⑤ 上传"
  [ -f "$OSS_ENV_FILE" ] || { echo "缺少 OSS 凭据文件：${OSS_ENV_FILE}（或用环境变量传入）" >&2; exit 1; }
  # shellcheck disable=SC1090
  set -a; . "$OSS_ENV_FILE"; set +a
  for v in OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_BUCKET OSS_REGION; do
    eval "[ -n \"\${$v:-}\" ]" || { echo "缺少环境变量 $v" >&2; exit 1; }
  done
  OSS_PY="${OSS_PY:-$HOME/.venv-oss/bin/python}"
  [ -x "$OSS_PY" ] || { echo "缺少 oss2 环境：$OSS_PY" >&2; exit 1; }
  oss_upload "$DMG_PATH" "$PRODUCT_DIR/$V2_DMG_NAME" \
    "public, max-age=31536000, immutable" "application/octet-stream"
  oss_upload "$APPCAST_LOCAL" "$APPCAST_KEY" \
    "no-cache, max-age=60" "application/rss+xml"
  if [ -n "$NOTES_FILE" ]; then
    oss_upload "$NOTES_FILE" "$PRODUCT_DIR/release-notes-$VERSION.html" \
      "public, max-age=3600" "text/html; charset=utf-8"
  fi
  oss_upload "$MANIFEST_LOCAL" "$MANIFEST_KEY" \
    "no-cache, max-age=60" "application/json"
fi

# ---- ⑥ 线上校验 ----
echo ""
echo "===== ⑥ 线上校验"
if [ "$SKIP_UPLOAD" = "true" ]; then
  echo "  （跳过）本地 appcast：$APPCAST_LOCAL"
  echo "  （跳过）本地清单：$MANIFEST_LOCAL"
else
  CODE="$(curl -s -o /tmp/mote-appcast-check.xml -w '%{http_code}' "$APPCAST_URL")"
  echo "  GET $APPCAST_URL → HTTP $CODE"
  [ "$CODE" = "200" ] && grep -q "edSignature" /tmp/mote-appcast-check.xml \
    && echo "  ✓ 线上 appcast 含 edSignature" \
    || echo "  ✗ 线上 appcast 异常，请检查上传结果（OSS 直连无 CDN，源站即时生效）"
  rm -f /tmp/mote-appcast-check.xml

  CODE="$(curl -s -o /tmp/mote-manifest-check.json -w '%{http_code}' "$MANIFEST_URL")"
  echo "  GET $MANIFEST_URL → HTTP $CODE"
  if [ "$CODE" = "200" ] \
    && grep -q "\"version\":[[:space:]]*\"$VERSION\"" /tmp/mote-manifest-check.json \
    && grep -q "\"sha256\":[[:space:]]*\"$DMG_SHA256\"" /tmp/mote-manifest-check.json; then
    echo "  ✓ 线上 manifest.json 版本与 SHA256 均与产物一致"
  else
    echo "  ✗ 线上 manifest.json 异常，请检查上传结果（OSS 直连无 CDN，源站即时生效）"
  fi
  rm -f /tmp/mote-manifest-check.json

  if [ -n "$NOTES_URL" ]; then
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -I "$NOTES_URL")"
    echo "  GET $NOTES_URL → HTTP $CODE"
    [ "$CODE" = "200" ] && echo "  ✓ 线上发布说明可访问" \
      || echo "  ✗ 线上发布说明不可访问，请检查上传结果"
  fi
  echo "  -- 统一门禁 verify-live --"
  python3 "$GUARD_PY" verify-live "${GUARD_ARGS[@]}"
fi

# ---- ⑦ docs 自检：包体实测 + 实现状态巡检 ----
# 教训：设计文档会随时间漂移——包体数值偏离实际、实现状态写着「未实现」但代码早已完成。
echo ""
echo "===== ⑦ docs 自检（包体实测 + 实现状态）"
DOCS_ROOT="$REPO_ROOT/docs"
if [ -d "$DOCS_ROOT" ]; then
  DMG_SIZE=$(stat -f%z "$DMG_PATH" 2>/dev/null || stat -c%s "$DMG_PATH" 2>/dev/null || echo "?")
  DMG_MIB=$(python3 -c "print(f'{int($DMG_SIZE)/1024/1024:.2f}')" 2>/dev/null || echo "?")
  TODAY=$(date '+%Y-%m-%d')
  echo "  📦 包体实测（版本 $VERSION / ${TODAY}）"
  echo "     DMG: ${DMG_SIZE}B (${DMG_MIB} MiB)"

  WATCH_WORDS="未实现|待补|待处理|TODO|FIXME|缺口|缺失|尚未|计划实现"
  HITS=$(grep -rnE "$WATCH_WORDS" "$DOCS_ROOT" --include="*.md" -l 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    echo ""
    echo "  🔍 实现状态巡检（docs/ 中含「未实现/待补/TODO」等字样）"
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      COUNT=$(grep -cE "$WATCH_WORDS" "$f" 2>/dev/null || echo 0)
      REL="${f#$REPO_ROOT/}"
      echo "     $REL ($COUNT 处)"
      grep -nE "$WATCH_WORDS" "$f" 2>/dev/null | head -2 | sed 's/^/       L/'
    done <<< "$HITS"
    echo ""
    echo "     → 发布前核对这些条目的代码现状；已实现的及时改掉。"
  else
    echo ""
    echo "  🔍 实现状态巡检：docs/ 未发现待补标记 ✓"
  fi
fi

echo ""
echo "================ 完成 ================"
echo "版本：      $VERSION"
GIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
echo "commit：    $GIT_HASH"
echo "DMG：       $DMG_URL"
echo "SHA256：    $DMG_SHA256"
echo "appcast：   $APPCAST_URL"
echo "manifest.json：$MANIFEST_URL"
