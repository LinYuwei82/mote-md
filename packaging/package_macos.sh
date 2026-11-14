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

# Qt 来源可用 QMAKE 指定。Homebrew 的 Qt 链接 ICU，会多带约 37MB（DMG 因此约 34MB）；
# 官方安装器的 macOS 二进制不依赖 ICU，同一个工程打出来 DMG 约 24MB。代码不用改。
QMAKE="${QMAKE:-qmake6}"
QT_BIN="$("$QMAKE" -query QT_INSTALL_BINS)"
QT_LIB="$("$QMAKE" -query QT_INSTALL_LIBS)"
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
"$QMAKE" "$ROOT/Mote.pro"
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

# 提示 Qt 来源带来的体积差：Homebrew Qt 链接 ICU，包内会多出约 37MB。
ICU_BYTES="$(find "$APP_PATH/Contents/Frameworks" -name 'libicu*.dylib' -print0 2>/dev/null \
    | xargs -0 stat -f%z 2>/dev/null | awk '{s += $1} END {print s + 0}')"
if [ "${ICU_BYTES:-0}" -gt 0 ]; then
    echo "    提示：本包 Qt 自带 ICU，约 $((ICU_BYTES / 1048576)) MB。"
    echo "          改用官方 Qt 可去掉它：QMAKE=~/Qt/6.11.1/macos/bin/qmake6 $0 ..."
fi

# macdeployqt 不带 Qt 翻译。QMessageBox 的「保存/不保存/取消」等标准按钮文案来自
# qtbase_zh_CN.qm。app 包内 QLibraryInfo::path(TranslationsPath) 解析到
# Contents/translations（不是 Contents/Resources/translations，已实测），缺文件直接失败。
QT_TRANSLATIONS="$("$QMAKE" -query QT_INSTALL_TRANSLATIONS)"
if [ -f "$QT_TRANSLATIONS/qtbase_zh_CN.qm" ]; then
    mkdir -p "$APP_PATH/Contents/translations"
    cp "$QT_TRANSLATIONS/qtbase_zh_CN.qm" "$APP_PATH/Contents/translations/"
else
    echo "错误：找不到 $QT_TRANSLATIONS/qtbase_zh_CN.qm，标准按钮会显示英文" >&2
    exit 1
fi

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

# macdeployqt 偶尔漏改某些传递依赖（如 Homebrew 的 libbrotlicommon），这里统一改写为包内路径。
# 依赖有两种形态：独立 dylib（取 basename）与 framework 内的二进制
# （/opt/.../X.framework/Versions/A/X，要保留 X.framework/Versions/A/X 这段相对路径）。
rewrite_external_deps() {
    local target="$1" dep rel base deps
    deps="$(otool -L "$target" 2>/dev/null | tail -n +2 | awk '{print $1}' \
            | grep -E "^/(opt|usr/local|Users)/" || true)"
    [ -n "$deps" ] || return 0
    while IFS= read -r dep; do
        case "$dep" in
            *.framework/Versions/*)
                rel="$(printf '%s' "$dep" | sed -n 's|.*/\([^/]*\.framework/Versions/.*\)$|\1|p')"
                if [ -n "$rel" ] && [ -e "$FRAMEWORKS/$rel" ]; then
                    install_name_tool -change "$dep" "@executable_path/../Frameworks/$rel" "$target" 2>/dev/null || true
                    echo "  重写 $(basename "$target"): $dep -> @executable_path/../Frameworks/$rel"
                    continue
                fi
                ;;
        esac
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

# 包内所有 framework 二进制与独立 dylib 的自有 install name 也必须是包内路径。
# 逐个按真实文件判断（framework 的二进制名不一定等于目录名，如 QtDBus.framework/Versions/A/QtDBus），
# 不用目录名猜；改完 install id 后续统一 ad-hoc 重签。
find "$FRAMEWORKS" -type f -print0 \
    | while IFS= read -r -d '' f; do
        file "$f" | grep -q "Mach-O" || continue
        current_id="$(otool -D "$f" 2>/dev/null | tail -n +2 | head -n 1)"
        case "$current_id" in
            /opt/*|/usr/local/*|/Users/*) ;;
            *) continue ;;
        esac
        rel="${f#"$FRAMEWORKS"/}"
        install_name_tool -id "@executable_path/../Frameworks/$rel" "$f" 2>/dev/null || true
        echo "  修正 install id: ${rel}：${current_id} -> @executable_path/../Frameworks/${rel}"
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

# 出包前自检：包内每个 Mach-O 的依赖（otool -L）与 install id（otool -D）都不允许指向
# 开发机绝对路径。mode=fail 发现问题立即以非零码退出；mode=report 只打印统计。
scan_external_paths() {
    local mode="$1"
    local macho=0 bad=0
    local l_hb=0 l_ul=0 l_user=0 d_hb=0 d_ul=0 d_user=0
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
        while IFS= read -r hit; do
            echo "  [外部路径·依赖] ${f#"$APP_PATH"/}: $hit" >&2
            bad=1
        done < <(printf '%s\n' "$deps" | grep -E '/opt/homebrew|/usr/local|/Users/' || true)
        while IFS= read -r hit; do
            echo "  [外部路径·install id] ${f#"$APP_PATH"/}: $hit" >&2
            bad=1
        done < <(printf '%s\n' "$ids" | grep -E '/opt/homebrew|/usr/local|/Users/' || true)
    done < <(find "$APP_PATH/Contents" -type f -print0)
    if [ "$mode" = "fail" ] && [ "$bad" -ne 0 ]; then
        echo "错误：包内仍有指向开发机绝对路径的 Mach-O，停止出包" >&2
        exit 1
    fi
    if [ "$mode" = "report" ]; then
        echo "依赖 / install id 自检（包内全部 Mach-O，各项应为 0）："
        echo "  Mach-O 文件数：$macho"
        echo "  otool -L：/opt/homebrew $l_hb 行，/usr/local $l_ul 行，/Users/ $l_user 行"
        echo "  otool -D：/opt/homebrew $d_hb 行，/usr/local $d_ul 行，/Users/ $d_user 行"
        if [ "$bad" -eq 0 ]; then
            echo "  结果：通过"
        else
            echo "  结果：仍有外部路径"
        fi
    fi
}

echo "==> 6/${TOTAL} Ad-hoc 签名"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
# install_name_tool 会破坏签名，这里重签后立刻全包扫描；有残留就停，不出包
scan_external_paths fail

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
scan_external_paths report
