#!/bin/bash
# macOS 打包脚本：编译 -> macdeployqt -> 清理冗余插件/框架 -> 清理扩展属性 -> 临时签名 -> 打 zip
# 用法：
#   bash packaging/package_macos.sh           # 只出 dist/Mote-macOS.zip（原有流程）
#   bash packaging/package_macos.sh --dmg     # 额外出 dist/Mote-macOS-<版本>.dmg（拖拽安装）
#   bash packaging/package_macos.sh --clean-dist   # 先清空 dist/（默认保留其它旧产物）
set -euo pipefail

WITH_DMG=0
CLEAN_DIST=0
for arg in "$@"; do
    case "$arg" in
        --dmg) WITH_DMG=1 ;;
        --clean-dist) CLEAN_DIST=1 ;;
        -h|--help)
            echo "用法: bash packaging/package_macos.sh [--dmg] [--clean-dist]"
            echo "  --dmg         在 zip 之外再产出一个拖拽安装式 DMG（卷标 Mote，UDZO 压缩）"
            echo "  --clean-dist  先清空 dist/（默认只覆盖同名产物，保留 dist 里的其它文件）"
            exit 0 ;;
        *) echo "未知参数：${arg}（可用：--dmg, --clean-dist）"; exit 2 ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Mote"
# 构建/签名放在非同步目录：工程若位于 iCloud“文稿”等 FileProvider 目录，
# 系统会反复给 .app 加 FinderInfo 扩展属性，导致 codesign 失败。
BUILD_DIR="${TMPDIR:-/tmp}/mote-build"
DIST_DIR="$ROOT/dist"
PKG_NAME="${APP_NAME}-macOS"
ZIP_PATH="$DIST_DIR/${PKG_NAME}.zip"
# 进度编号随是否产出 DMG 变化
TOTAL=7
[ "$WITH_DMG" -eq 1 ] && TOTAL=8

QT_BIN="$(qmake6 -query QT_INSTALL_BINS)"
QT_LIB="$(qmake6 -query QT_INSTALL_LIBS)"
MACDEPLOYQT="$QT_BIN/macdeployqt"
[ -x "$MACDEPLOYQT" ] || { echo "错误：找不到 macdeployqt（$MACDEPLOYQT）"; exit 1; }

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

echo "==> 2/${TOTAL} qmake + make (Release)"
cd "$BUILD_DIR"
qmake6 "$ROOT/Mote.pro"
make -j"$(sysctl -n hw.ncpu)"

APP_PATH="$BUILD_DIR/${APP_NAME}.app"
[ -d "$APP_PATH" ] || { echo "错误：构建失败，未生成 $APP_PATH"; exit 1; }

# DMG 文件名带版本号：版本直接读构建产物里的 Info.plist（qmake 已按 Mote.pro 的
# VERSION 填好 @FULL_VERSION@），脚本里不再另存一份版本号。
APP_VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP_PATH/Contents/Info.plist")"
[ -n "$APP_VERSION" ] || { echo "错误：无法从 $APP_PATH 读取版本号"; exit 1; }
DMG_PATH="$DIST_DIR/${PKG_NAME}-${APP_VERSION}.dmg"

echo "==> 3/${TOTAL} macdeployqt 部署 Qt 框架与插件"
"$MACDEPLOYQT" "$APP_PATH" -always-overwrite -no-codesign -libpath="$QT_LIB"

echo "==> 4/${TOTAL} 删除用不到的插件与被牵连的大依赖（虚拟键盘/QML/PDF/SVG）"
PLUGINS="$APP_PATH/Contents/PlugIns"
FRAMEWORKS="$APP_PATH/Contents/Frameworks"
rm -rf "$PLUGINS/platforminputcontexts" "$PLUGINS/iconengines"
rm -f "$PLUGINS/imageformats/libqpdf.dylib"
rm -rf "$FRAMEWORKS/QtVirtualKeyboard.framework" \
       "$FRAMEWORKS/QtPdf.framework" \
       "$FRAMEWORKS/QtSvg.framework"
rm -rf "$FRAMEWORKS"/QtQml*.framework "$FRAMEWORKS"/QtQuick*.framework

echo "==> 5/${TOTAL} 修正体外的绝对库路径、去掉开发机 rpath、strip、清理扩展属性"
EXE="$APP_PATH/Contents/MacOS/${APP_NAME}"

# macdeployqt 偶尔漏改某些传递依赖（如 Homebrew 的 libbrotlicommon），这里统一改写为包内路径
rewrite_external_deps() {
    local target="$1" dep base deps
    deps="$(otool -L "$target" 2>/dev/null | tail -n +2 | awk '{print $1}' \
            | grep -E "^/(opt|usr/local)/" || true)"
    [ -n "$deps" ] || return 0
    while IFS= read -r dep; do
        base="$(basename "$dep")"
        if [ -e "$FRAMEWORKS/$base" ]; then
            install_name_tool -change "$dep" "@executable_path/../Frameworks/$base" "$target" 2>/dev/null || true
            echo "  重写 $(basename "$target"): $dep -> @executable_path/../Frameworks/$base"
        else
            echo "  警告：$(basename "$target") 依赖包外的 $dep"
        fi
    done <<< "$deps"
}
find "$APP_PATH/Contents" -type f \( -name "*.dylib" -o -perm -111 \) -print0 \
    | while IFS= read -r -d '' f; do
        if file "$f" | grep -q "Mach-O"; then
            rewrite_external_deps "$f"
        fi
    done

# 个别库以开发机绝对路径作为自身 install name，统一改成 @rpath
find "$FRAMEWORKS" -maxdepth 1 -name "*.dylib" -print0 \
    | while IFS= read -r -d '' f; do
        current_id="$(otool -D "$f" | tail -n +2)"
        case "$current_id" in
            /opt/*|/usr/local/*)
                install_name_tool -id "@rpath/$(basename "$f")" "$f" 2>/dev/null || true
                echo "  修正 install id: $(basename "$f")"
                ;;
        esac
    done

while install_name_tool -delete_rpath "$QT_LIB" "$EXE" 2>/dev/null; do :; done
strip -x "$EXE" 2>/dev/null || true
find "$APP_PATH" -maxdepth 4 -name "*.dSYM" -exec rm -rf {} + 2>/dev/null || true
find "$APP_PATH" -maxdepth 4 -name ".DS_Store" -delete 2>/dev/null || true

# 去掉包内 Mach-O 上残留的开发机绝对 rpath（Homebrew Cellar）。
# 这些库的依赖已经全部改成 @executable_path/../Frameworks，rpath 本身不再需要；
# 但留着会让装了同版本 Homebrew 库的机器优先加载系统里的副本而不是包内副本。
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

echo "==> 6/${TOTAL} Ad-hoc 签名"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"

echo "==> 7/${TOTAL} 组装发布目录并压缩"
# 暂存目录同样放在非同步目录，避免 FinderInfo 被写进 zip 导致解压后签名校验失败
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
# 随包附带内嵌代码字体的 OFL 授权文件（SIL Open Font License 要求随分发提供）
mkdir -p "$PKG_DIR/licenses"
cp "$ROOT/resources/fonts/OFL.txt" "$PKG_DIR/licenses/JetBrainsMono-OFL.txt"
# 项目自身的 AGPL-3.0 全文本同样随包分发
cp "$ROOT/LICENSE" "$PKG_DIR/licenses/LICENSE-AGPL-3.0.txt"
mkdir -p "$DIST_DIR"

ditto -c -k --sequesterRsrc --keepParent "$PKG_DIR" "$STAGE/${PKG_NAME}.zip"
mv -f "$STAGE/${PKG_NAME}.zip" "$ZIP_PATH"
rm -rf "$STAGE"

if [ "$WITH_DMG" -eq 1 ]; then
    echo "==> 8/${TOTAL} 制作 DMG（拖拽安装）"
    # 卷内只放两个可见项：Mote.app 与指向 /Applications 的符号链接。
    # 不跑 Finder AppleScript 摆图标：那需要 GUI 会话与自动化授权，换台机器就不可复现；
    # 图标位置交给 Finder 默认网格，脚本本身完全可重复执行。
    DMG_STAGE="${TMPDIR:-/tmp}/mote-dmg"
    rm -rf "$DMG_STAGE"
    mkdir -p "$DMG_STAGE"
    ditto "$APP_PATH" "$DMG_STAGE/${APP_NAME}.app"
    xattr -cr "$DMG_STAGE/${APP_NAME}.app"
    xattr -d com.apple.FinderInfo "$DMG_STAGE/${APP_NAME}.app" 2>/dev/null || true
    ln -s /Applications "$DMG_STAGE/Applications"
    find "$DMG_STAGE" -name ".DS_Store" -delete 2>/dev/null || true

    rm -f "$DMG_PATH"
    hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_STAGE" \
        -ov -format UDZO -fs HFS+ "$DMG_PATH"
    hdiutil verify "$DMG_PATH"
    rm -rf "$DMG_STAGE"
fi

echo
echo "完成：$ZIP_PATH"
echo "包体大小：$(du -sh "$ZIP_PATH" | cut -f1)"
echo "解压后 .app 大小：$(du -sh "$APP_PATH" | cut -f1)"
if [ "$WITH_DMG" -eq 1 ]; then
    echo "DMG：$DMG_PATH"
    echo "DMG 字节数：$(stat -f%z "$DMG_PATH")"
    echo "DMG SHA256：$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
    echo "（DMG 内含卷 UUID 与时间戳，每次重建哈希都会变，这是正常的）"
fi
echo
echo "依赖检查（主程序，应只出现 @rpath / 系统框架）："
otool -L "$EXE" | sed 's/^/  /'
