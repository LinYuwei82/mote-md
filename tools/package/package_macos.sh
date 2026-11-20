#!/bin/bash
# macOS 打包脚本：编译 -> 检查依赖 -> 清理扩展属性 -> Developer ID 签名 -> 公证 -> 打 zip/DMG
# 用法：
#   bash tools/package/package_macos.sh                 # AppKit + CMake 构建 + Developer ID 签名 + 公证
#   bash tools/package/package_macos.sh --dmg           # 额外出 dist/Mote-macOS-native-<版本>.dmg（拖拽安装）+ DMG 公证
#   bash tools/package/package_macos.sh --clean-dist    # 先清空 dist/（默认保留其它旧产物）
#
# 硬门禁（2026-11-20 起生效）：签名 + 公证是发布硬性前提，不满足直接 exit 1。
#   - 钥匙串里必须有 Developer ID Application 证书，否则 fail
#   - notarytool keychain profile 必须配置（默认 "mote-notary"，可用 MOTE_NOTARY_PROFILE 覆盖），否则 fail
#   - 已移除 --skip-sign / --skip-notarize 参数（旁路后门已删除）
#
# 签名证书：自动从钥匙串查找 "Developer ID Application: ..."
# 公证凭据：xcrun notarytool store-credentials "mote-notary" --apple-id <id> --team-id <team> --password <app-specific>
set -euo pipefail

WITH_DMG=0
CLEAN_DIST=0
for arg in "$@"; do
    case "$arg" in
        --dmg) WITH_DMG=1 ;;
        --clean-dist) CLEAN_DIST=1 ;;
        -h|--help)
            echo "用法: bash tools/package/package_macos.sh [--dmg] [--clean-dist]"
            echo "  --dmg         在 zip 之外再产出一个拖拽安装式 DMG（卷标 Mote，UDZO 压缩）"
            echo "  --clean-dist  先清空 dist/（默认只覆盖同名产物，保留 dist 里的其它文件）"
            echo ""
            echo "硬性前提：必须具备 Developer ID Application 签名证书 + notarytool 公证 profile。"
            echo "不满足时脚本会直接 exit 1，无旁路。"
            exit 0 ;;
        *) echo "未知参数：${arg}（可用：--dmg, --clean-dist）"; exit 2 ;;
    esac
done

# ===== 硬门禁前置：签名证书 + 公证 profile 必须同时满足 =====
# --- 签名证书 ---
find_developer_id_sign() {
    security find-identity -v -p codesigning 2>&1 \
        | sed -n 's/.*"Developer ID Application: \(.*\)".*/\1/p' | head -1
}
SIGN_IDENTITY="$(find_developer_id_sign)"
if [ -z "$SIGN_IDENTITY" ]; then
    echo "硬性前提检查失败：钥匙串里找不到 Developer ID Application 证书" >&2
    echo "  security find-identity -v -p codesigning" >&2
    echo "  需要在 Apple Developer 后台申请并安装到登录钥匙串" >&2
    exit 1
fi
echo "签名证书：Developer ID Application: ${SIGN_IDENTITY} ✓"

# --- 公证 profile ---
NOTARY_PROFILE="${MOTE_NOTARY_PROFILE:-mote-notary}"
if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" 2>&1 | head -1 | grep -qi "error"; then
    echo "硬性前提检查失败：notarytool keychain profile '$NOTARY_PROFILE' 不存在" >&2
    echo "  需要先运行：" >&2
    echo "    xcrun notarytool store-credentials '$NOTARY_PROFILE' \\" >&2
    echo "      --apple-id <your@appleid.com> --team-id BMCUC4B6XX --password <app-specific-password>" >&2
    echo "  或者用 MOTE_NOTARY_PROFILE 环境变量指定已存在的 profile 名" >&2
    exit 1
fi
echo "公证 profile：${NOTARY_PROFILE} ✓"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="Mote"
# 构建/签名放在非同步目录：工程若位于 iCloud“文稿”等 FileProvider 目录，
# 系统会反复给 .app 加 FinderInfo 扩展属性，导致 codesign 失败。
BUILD_DIR="${TMPDIR:-/tmp}/mote-build-native"
DIST_DIR="$ROOT/dist"
# 产物名沿用历史命名（Mote-macOS-native），避免已发布的清单与下载链接失配
PKG_NAME="${APP_NAME}-macOS-native"
ZIP_PATH="$DIST_DIR/${PKG_NAME}.zip"

# 进度总数：签名证书 + 公证 profile 已前置检查，这里走满流程
# 基础 7 步 + 公证 4 步（提交 + stapler/spctl + zip 验证 + 拷 DMG）= 11
TOTAL=11

echo "==> 1/${TOTAL} 清理并创建影子构建目录"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
# dist/ 里可能有上一次的产物（甚至手工保留的 DMG）。默认只覆盖本次产出的同名文件，
# 要全清得显式加 --clean-dist——否则只打一次 zip 就会把 DMG 一起删掉。
if [ "$CLEAN_DIST" -eq 1 ]; then
    echo "    清理 ${DIST_DIR}（--clean-dist）"
    rm -rf "$DIST_DIR"
fi
mkdir -p "$DIST_DIR"

echo "==> 2/${TOTAL} cmake + build (Release)"
# 构建号：纯数字、单调递增。CMake 接收 -DMOTE_BUILD，注入 Info.plist CFBundleVersion，
# 与 CFBundleShortVersionString（= VERSION.txt）分离——符合 Sparkle 2.7+ 规范。
# 2026-11-20 起与小兔 / DevCard 一致：显式 MOTE_BUILD 优先，未给则用 gen_build.py 自动生成。
BUILD_NUMBER="${MOTE_BUILD:-}"
BUILD_SOURCE="MOTE_BUILD 环境变量"
if [ -z "$BUILD_NUMBER" ]; then
  BUILD_NUMBER="$(python3 "$ROOT/tools/release/gen_build.py" \
    --product mote --repo-root "$ROOT")" \
    || { echo "gen_build.py 失败，无法生成构建号" >&2; exit 1; }
  BUILD_SOURCE="gen_build.py"
fi
case "$BUILD_NUMBER" in
  *[!0-9]*|"") echo "错误：MOTE_BUILD 必须是纯数字：$BUILD_NUMBER" >&2; exit 1 ;;
esac
echo "构建号：${BUILD_NUMBER}（来源 ${BUILD_SOURCE}）"

# MOTE_RELEASE_BUILD=ON：发布构建门禁——MOTE_BUILD 不能是占位值，且
# resources/Sparkle.framework 缺失时 FATAL_ERROR，防止最终 DMG 缺自动更新 framework
# 退化为浏览器下载（2026-11-19 mote 1.0.4 即因此重发）
cmake -S "$ROOT/native" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DMOTE_BUILD="$BUILD_NUMBER" \
  -DMOTE_RELEASE_BUILD=ON
cmake --build "$BUILD_DIR" --config Release -j"$(sysctl -n hw.ncpu)"
APP_PATH="$BUILD_DIR/${APP_NAME}.app"
[ -d "$APP_PATH" ] || { echo "错误：构建失败，未生成 $APP_PATH"; exit 1; }

# DMG 文件名带版本号：版本直接读构建产物里的 Info.plist（CMake 已按仓库根
# VERSION.txt 填好），脚本里不再另存一份版本号。
APP_VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP_PATH/Contents/Info.plist")"
[ -n "$APP_VERSION" ] || { echo "错误：无法从 $APP_PATH 读取版本号"; exit 1; }
DMG_PATH="$DIST_DIR/${PKG_NAME}-${APP_VERSION}.dmg"

echo "==> 3/${TOTAL} 检查依赖：不应链接 Qt"
EXE="$APP_PATH/Contents/MacOS/${APP_NAME}"
if otool -L "$EXE" | grep -q "Qt"; then
    echo "错误：原生构建仍然链接了 Qt" >&2
    exit 1
fi

echo "==> 4/${TOTAL} 去掉开发机 rpath、strip、清理扩展属性"
strip -x "$EXE" 2>/dev/null || true
find "$APP_PATH" -maxdepth 4 -name "*.dSYM" -exec rm -rf {} + 2>/dev/null || true
find "$APP_PATH" -maxdepth 4 -name ".DS_Store" -delete 2>/dev/null || true

# 去掉包内 Mach-O 上残留的开发机绝对 rpath（Homebrew Cellar）。
find "$APP_PATH/Contents" -type f \( -name "*.dylib" -o -perm -111 \) -print0 \
    | while IFS= read -r -d '' f; do
        file "$f" | grep -q "Mach-O" || continue
        rpaths="$(otool -l "$f" 2>/dev/null \
                  | awk '/LC_RPATH/{getline; getline; print $2}' \
                  | grep -E "^/(opt|usr/local)/" || true)"
        [ -n "$rpaths" ] || continue
        while IFS= read -r rp; do
            if install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null; then
                echo "  去掉 rpath: $(basename "$f"): $rp"
            fi
        done <<< "$rpaths"
    done

xattr -cr "$APP_PATH"
# 位于 iCloud/FileProvider 目录（如“文稿”）时，.app 目录会被打上 FinderInfo，
# 导致 codesign 报 "resource fork, Finder information ... not allowed"，签名前需去掉
xattr -d com.apple.FinderInfo "$APP_PATH" 2>/dev/null || true
xattr -d "com.apple.fileprovider.fpfs#P" "$APP_PATH" 2>/dev/null || true

# 出包前自检：包内每个 Mach-O 的依赖（otool -L）与 install id（otool -D）都不允许指向
# 开发机绝对路径。mode=fail 发现问题立即以非零码退出；mode=report 只打印统计。
scan_external_paths() {
    local mode="$1"
    local macho=0 bad=0
    local l_hb=0 l_ul=0 l_user=0 d_hb=0 d_ul=0 d_user=0 q_hits=0
    local f deps ids hit
    while IFS= read -r -d '' f; do
        file "$f" | grep -q "Mach-O" || continue
        macho=$((macho + 1))
        deps="$(otool -L "$f" 2>/dev/null || true)"
        ids="$(otool -D "$f" 2>/dev/null || true)"
        l_hb=$((l_hb + $(printf '%s\n' "$deps" | grep -c '/opt/homebrew' || true)))
        l_ul=$((l_ul + $(printf '%s\n' "$deps" | grep -c '/usr/local' || true)))
        l_user=$((l_user + $(printf '%s\n' "$deps" | grep -c '/Users/' || true)))
        d_hb=$((d_hb + $(printf '%s\n' "$ids" | grep -c '/opt/homebrew' || true)))
        d_ul=$((d_ul + $(printf '%s\n' "$ids" | grep -c '/usr/local' || true)))
        d_user=$((d_user + $(printf '%s\n' "$ids" | grep -c '/Users/' || true)))
        q_hits=$((q_hits + $(printf '%s\n' "$deps" | grep -c 'Qt' || true)))
        while IFS= read -r hit; do
            echo "  [外部路径·依赖] ${f#"$APP_PATH"/}: $hit" >&2
            bad=1
        done < <(printf '%s\n' "$deps" | grep -E '/opt/homebrew|/usr/local|/Users/' || true)
        while IFS= read -r hit; do
            echo "  [外部路径·install id] ${f#"$APP_PATH"/}: $hit" >&2
            bad=1
        done < <(printf '%s\n' "$ids" | grep -E '/opt/homebrew|/usr/local|/Users/' || true)
    done < <(find "$APP_PATH/Contents" -type f -print0)
    # 原生构建不该出现任何 Qt 链接
    if [ "$q_hits" -ne 0 ]; then
        echo "错误：包内仍有 $q_hits 行 Qt 链接" >&2
        bad=1
    fi
    if [ "$mode" = "fail" ] && [ "$bad" -ne 0 ]; then
        echo "错误：包内仍有指向开发机绝对路径或 Qt 的 Mach-O，停止出包" >&2
        exit 1
    fi
    if [ "$mode" = "report" ]; then
        echo "依赖 / install id 自检（包内全部 Mach-O，各项应为 0）："
        echo "  Mach-O 文件数：$macho"
        echo "  otool -L：/opt/homebrew $l_hb 行，/usr/local $l_ul 行，/Users/ $l_user 行"
        echo "  otool -D：/opt/homebrew $d_hb 行，/usr/local $d_ul 行，/Users/ $d_user 行"
        echo "  Qt 链接：$q_hits 行（应为 0）"
        if [ "$bad" -eq 0 ]; then
            echo "  结果：通过"
        else
            echo "  结果：仍有外部路径"
        fi
    fi
}

echo "==> 5/${TOTAL} Developer ID 签名：${SIGN_IDENTITY}"
# entitlements：禁用 sandbox（Sparkle 自动更新要求 bundle 可写）
ENTITLEMENTS="$ROOT/packaging/entitlements.plist"
if [ ! -f "$ENTITLEMENTS" ]; then
    echo "错误：entitlements plist 不存在 $ENTITLEMENTS" >&2
    exit 1
fi
# 签名前再清一次扩展属性（install_name_tool 可能引入新的 xattr）
xattr -cr "$APP_PATH"
xattr -d com.apple.FinderInfo "$APP_PATH" 2>/dev/null || true
xattr -d "com.apple.fileprovider.fpfs#P" "$APP_PATH" 2>/dev/null || true

# 新版 codesign：分步嵌套签名（先签子 framework 内部所有嵌套 bundle，再签 .app 主体）
# Sparkle.framework 内含 Updater.app、XPCServices 等多个嵌套 bundle，--deep 一次签完
SIGN_NAME="Developer ID Application: ${SIGN_IDENTITY}"
SPARKLE_FW="$APP_PATH/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
    echo "    签 Sparkle.framework（--deep 覆盖 Updater.app + XPCServices）..."
    codesign --force --sign "$SIGN_NAME" --options runtime --timestamp \
        --entitlements "$ENTITLEMENTS" --deep "$SPARKLE_FW"
    codesign --verify --deep --strict "$SPARKLE_FW" || { echo "Sparkle.framework 签名验证失败"; exit 1; }
fi
echo "    签 .app 主体..."
codesign --force --sign "$SIGN_NAME" --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"

# 签名后检查 Gatekeeper 兼容性（runtime + 证书）
codesign -dvv "$APP_PATH" 2>&1 | grep -E "Authority|flags=" | head -5

# install_name_tool 会破坏签名，这里重签后立刻全包扫描；有残留就停，不出包
scan_external_paths fail

# ---- 产物完整性门禁：Sparkle.framework 必须存在 ----
# 历史踩坑：CMakeLists.txt 检测不到 resources/Sparkle.framework 时只 WARNING 继续构建，
# 最终 DMG 缺 framework → 自动更新退化为打开浏览器下载（2026-11-19 mote 1.0.4 即因此重发）。
# 出包前在此处硬性拦截，避免把残缺产物带进公证流程浪费 Apple 队列。
SPARKLE_FW="$APP_PATH/Contents/Frameworks/Sparkle.framework"
if [ ! -d "$SPARKLE_FW" ]; then
    echo "拒绝打包：$SPARKLE_FW 不存在！" >&2
    echo "  CMake 应该在 resources/Sparkle.framework 缺失时已经报 WARNING，请检查构建目录" >&2
    exit 1
fi
APP_SIZE_KB=$(du -sk "$APP_PATH" | awk '{print $1}')
if [ "$APP_SIZE_KB" -lt 1024 ]; then
    echo "拒绝打包：.app 体积过小（${APP_SIZE_KB} KB，含 Sparkle.framework 的 mote .app 应 > 1024 KB）" >&2
    exit 1
fi
echo "  Sparkle.framework 存在：✓    .app 体积：${APP_SIZE_KB} KB"

echo "==> 6/${TOTAL} 公证流程前：先做 DMG（提交 DMG 给 Apple，最终分发也是 DMG）"
NOTARY_STAGE="${TMPDIR:-/tmp}/mote-notary"
rm -rf "$NOTARY_STAGE"
mkdir -p "$NOTARY_STAGE"
NOTARY_DMG="$NOTARY_STAGE/${PKG_NAME}-${APP_VERSION}.dmg"
NOTARY_DMG_STAGE="$NOTARY_STAGE/dmg-build"
rm -rf "$NOTARY_DMG_STAGE"
mkdir -p "$NOTARY_DMG_STAGE"
ditto "$APP_PATH" "$NOTARY_DMG_STAGE/${APP_NAME}.app"
ln -s /Applications "$NOTARY_DMG_STAGE/Applications"
find "$NOTARY_DMG_STAGE" -name ".DS_Store" -delete 2>/dev/null || true
hdiutil create -volname "$APP_NAME" -srcfolder "$NOTARY_DMG_STAGE" \
    -ov -format UDZO -fs HFS+ "$NOTARY_DMG" >/dev/null
hdiutil verify "$NOTARY_DMG" >/dev/null

# DMG 签名（Developer ID 签名的 DMG 让 mount 更顺畅，公证也更稳）
codesign --force --sign "Developer ID Application: ${SIGN_IDENTITY}" --timestamp "$NOTARY_DMG"

echo "==> 7/${TOTAL} 提交 DMG 公证（xcrun notarytool submit --wait）..."
echo "    凭据钥匙串配置：${NOTARY_PROFILE}（已前置检查）"
echo "    提交文件：$NOTARY_DMG"

NOTARY_LOG="$NOTARY_STAGE/notary.log"
xcrun notarytool submit "$NOTARY_DMG" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait --timeout 900 2>&1 | tee "$NOTARY_LOG"
echo

# notarytool 的进度行是 "Current status: In Progress..."，会淹没最终结论；
# 只取结尾那段 "  status: Accepted"，并把进度里的 \r 折成换行再匹配
NOTARY_STATUS="$(tr '\r' '\n' < "$NOTARY_LOG" \
    | awk -F': *' '/^[[:space:]]*status: /{v=$2} END{print v}')"
if [ "$NOTARY_STATUS" != "Accepted" ]; then
    echo "错误：公证状态为 '$NOTARY_STATUS'，请查看完整日志：$NOTARY_LOG"
    echo "       常见原因：缺少 --options runtime、签名时没有 Developer ID、Info.plist 问题"
    exit 1
fi
echo "    公证通过 ✓"

echo "==> 8/${TOTAL} stapler staple DMG + spctl 验证"
xcrun stapler staple "$NOTARY_DMG"
xcrun stapler validate "$NOTARY_DMG"
echo "    DMG stapled ✓"

# stapler 也 staple 一下 .app，这样 zip 里的 .app 也自带 ticket
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
echo "    .app 也 stapled ✓"

# mount DMG → spctl 评估里面的 .app（模拟用户挂载 DMG 后的 Gatekeeper 检查）
echo "    mount DMG → spctl 验证..."
MOUNT_POINT="/Volumes/${APP_NAME}"
[ -d "$MOUNT_POINT" ] && hdiutil detach "$MOUNT_POINT" 2>/dev/null || true
hdiutil attach "$NOTARY_DMG" -nobrowse -mountpoint "$MOUNT_POINT" >/dev/null 2>&1 || true
DMG_APP="$MOUNT_POINT/${APP_NAME}.app"
DMG_SPCTL="$(spctl --assess --type execute -vv "$DMG_APP" 2>&1 || true)"
hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
echo "    $DMG_SPCTL"
echo "$DMG_SPCTL" | grep -q "accepted" || {
    echo "错误：DMG 内 .app 未通过 spctl"
    exit 1
}
echo "    DMG 内 .app 通过 spctl ✓"

echo
echo "==> 9/${TOTAL} 组装最终发布目录（zip）"
STAGE="${TMPDIR:-/tmp}/mote-stage"
rm -rf "$STAGE"
PKG_DIR="$STAGE/$PKG_NAME"
mkdir -p "$PKG_DIR"
ditto "$APP_PATH" "$PKG_DIR/${APP_NAME}.app"
xattr -cr "$PKG_DIR/${APP_NAME}.app"
xattr -d com.apple.FinderInfo "$PKG_DIR/${APP_NAME}.app" 2>/dev/null || true
mkdir -p "$PKG_DIR/samples"
cp "$ROOT/resources/samples/welcome.md" "$PKG_DIR/samples/"
cp "$ROOT/resources/samples/sample-diagram.png" "$PKG_DIR/samples/"
mkdir -p "$PKG_DIR/licenses"
cp "$ROOT/resources/fonts/OFL.txt" "$PKG_DIR/licenses/JetBrainsMono-OFL.txt"
cp "$ROOT/LICENSE" "$PKG_DIR/licenses/LICENSE-AGPL-3.0.txt"
mkdir -p "$DIST_DIR"

ditto -c -k --sequesterRsrc --keepParent "$PKG_DIR" "$STAGE/${PKG_NAME}.zip"
mv -f "$STAGE/${PKG_NAME}.zip" "$ZIP_PATH"
rm -rf "$STAGE"

# ---- 拷贝已 stapled 的 DMG ----
echo "==> 10/${TOTAL} 拷贝最终 DMG"
cp "$NOTARY_DMG" "$DMG_PATH"
hdiutil verify "$DMG_PATH"
rm -rf "$NOTARY_STAGE"
echo "    DMG：$DMG_PATH"

# 最终验证：解压 zip → spctl 确认
echo
echo "==> 11/${TOTAL} 最终 zip 解压 spctl 验证"
FINAL_CHECK="/tmp/mote-final-check"
rm -rf "$FINAL_CHECK"
mkdir -p "$FINAL_CHECK"
cd "$FINAL_CHECK" && ditto -x -k "$ZIP_PATH" .
FINAL_APP="$FINAL_CHECK/$PKG_NAME/${APP_NAME}.app"
FINAL_SPCTL="$(spctl --assess --type execute -vv "$FINAL_APP" 2>&1 || true)"
echo "    $FINAL_SPCTL"
echo "$FINAL_SPCTL" | grep -q "accepted" || {
    echo "错误：zip 解压后的 app 未通过 spctl"
    exit 1
}
echo "    zip 解压后 .app 通过 spctl ✓"

echo
echo "完成：$ZIP_PATH"
echo "包体大小：$(du -sh "$ZIP_PATH" | cut -f1)"
echo "解压后 .app 大小：$(du -sh "$APP_PATH" | cut -f1)"
echo "DMG：$DMG_PATH"
echo "DMG 字节数：$(stat -f%z "$DMG_PATH")"
echo "DMG SHA256：$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
echo "（DMG 内含卷 UUID 与时间戳，每次重建哈希都会变，这是正常的）"
echo
scan_external_paths report
