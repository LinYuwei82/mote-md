QT += core gui widgets

TEMPLATE = app
TARGET = Mote
VERSION = 0.3.6

CONFIG += c++20 warn_on
CONFIG -= debug_and_release
CONFIG += release

# 版本号唯一来源是上面的 VERSION：
#   - macOS：Info.plist 里用 @FULL_VERSION@ 占位，qmake 生成 bundle 时替换
#   - 程序内：main.cpp 用 MOTE_VERSION 设置 applicationVersion()
# Windows 的 app.rc 由 rc.exe 直接编译，qmake 不替换其内容，需手工同步
# （见 resources/win/app.rc 顶部注释）。
DEFINES += MOTE_VERSION=\\\"$$VERSION\\\"

SOURCES += \
    src/main.cpp \
    src/mainwindow.cpp \
    src/previewview.cpp \
    src/codehighlighter.cpp \
    src/webwindow.cpp \
    src/webpage.cpp \
    src/webviewbase.cpp \
    src/webview_stub.cpp

HEADERS += \
    src/mainwindow.h \
    src/previewview.h \
    src/codehighlighter.h \
    src/webwindow.h \
    src/webview.h \
    src/webpage.h \
    src/webviewbase.h

RESOURCES += resources/resources.qrc

# 运行时图标、样式、示例文档都通过 .qrc 打进二进制，不依赖外部路径
# 前端编辑器（HTML/CSS/JS）同样编进 qrc，经 :/web/ 读取后内联成单页加载

win32 {
    RC_FILE = resources/win/app.rc
    # 关闭控制台窗口（Windows 下双击不弹黑框）
    CONFIG -= console

    # 系统 WebView2（Evergreen Runtime）：不引入 QtWebEngine，也不分发浏览器内核。
    # SDK 为 NuGet 包 Microsoft.Web.WebView2 1.0.2903.40（仅头文件 + Loader），
    # 放在仓库外，按以下顺序定位（前一个不存在才看后一个）：
    #   1) 环境变量 WEBVIEW2_SDK
    #   2) 默认约定目录 C:/dev/webview2sdk/pkg
    #   3) NuGet 全局缓存：<USERPROFILE>/.nuget/packages/microsoft.web.webview2/<版本>/
    WEBVIEW2_SDK = $$(WEBVIEW2_SDK)
    isEmpty(WEBVIEW2_SDK): WEBVIEW2_SDK = C:/dev/webview2sdk/pkg

    !exists($$WEBVIEW2_SDK/build/native/include/WebView2.h) {
        # 注意：qmake 没有 list() 函数，两个候选根目录用空格分隔成列表
        NUGET_ROOTS = $$(USERPROFILE)/.nuget/packages/microsoft.web.webview2 $$(NUGET_PACKAGES)/microsoft.web.webview2
        for(nugetRoot, NUGET_ROOTS) {
            isEmpty(WEBVIEW2_SDK_AUTO) {
                # files() 只支持最后一段通配，且路径里的 \ 会让通配失效，先归一成 /
                nugetRoot = $$replace(nugetRoot, \\\\, /)
                # for() 的列表不能直接写函数调用，必须先落到变量
                NUGET_VERSIONS = $$files($$nugetRoot/*)
                for(nugetVersion, NUGET_VERSIONS) {
                    exists($$nugetVersion/build/native/include/WebView2.h) {
                        isEmpty(WEBVIEW2_SDK_AUTO): WEBVIEW2_SDK_AUTO = $$nugetVersion
                    }
                }
            }
        }
        !isEmpty(WEBVIEW2_SDK_AUTO) {
            WEBVIEW2_SDK = $$WEBVIEW2_SDK_AUTO
            message("WebView2 SDK：从 NuGet 缓存自动发现 $$WEBVIEW2_SDK")
        }
    }

    !exists($$WEBVIEW2_SDK/build/native/include/WebView2.h) {
        message("未找到 WebView2 SDK，无法构建 Windows 目标。获取方式：")
        message("  1) 下载 NuGet 包：https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2903.40")
        message("  2) 把下载到的 .nupkg 当 zip 解压，得到这样的目录结构：")
        message("       pkg/build/native/include/WebView2.h")
        message("       pkg/build/native/x64/WebView2Loader.dll")
        message("  3) 放到 C:/dev/webview2sdk/pkg，或设置环境变量 WEBVIEW2_SDK=<该 pkg 目录>")
        message("  4) 也可以先装进 NuGet 全局缓存（<USERPROFILE>/.nuget/packages/microsoft.web.webview2/1.0.2903.40），本工程会自动发现")
        error("WebView2 SDK 缺失（缺少 build/native/include/WebView2.h）")
    }

    INCLUDEPATH += $$WEBVIEW2_SDK/build/native/include
    SOURCES += src/webview_win.cpp src/webview_win_drop.cpp
    HEADERS += src/webview_win.h src/webview_win_drop.h
    # COM 基础库：CoTaskMemFree / IID_IUnknown；shell32 提供 CF_HDROP 解析；
    # user32 提供 IsWindow / IsWindowVisible / GetKeyState / EnumChildWindows 等
    # （MinGW 默认隐式链接 user32，MSVC 不链，显式写出让两条工具链一致）
    LIBS += -lole32 -luuid -lshell32 -luser32

    # 绿色版/开发运行都需要 exe 同级的 WebView2Loader.dll。
    # 工程强制单配置 release（CONFIG -= debug_and_release），两个生成器的
    # DESTDIR 都是空串、Mote.exe 就落在 $$OUT_PWD。
    #
    # 两条工具链各用各的原生方式：
    #   - MSVC：$$QMAKE_COPY 是 cmd 内建的 copy /y（不是外部程序，无查找问题）
    #   - MinGW：$$QMAKE_COPY 是 cp -f，但 make 用 Git 的 sh 执行命令，有两处坑：
    #       1) sh 的 PATH 不保证能找到 cp（本机被 PATH 里的 \\?\ 条目截断），
    #          所以用 Windows 自带 xcopy 的绝对路径；
    #       2) MSYS 会把 /Y、/Q 这种开关当成路径改写（变成 Y:/ 之类），必须用
    #          MSYS_NO_PATHCONV=1 关掉参数转换。
    # 之前写成「$$QMAKE_COPY /Y」由调用方硬拼开关：MSVC 变成 copy /y /Y，
    # MinGW 变成 cp -f /Y，后者直接失败。
    WEBVIEW2_LOADER = $$WEBVIEW2_SDK/build/native/x64/WebView2Loader.dll
    exists($$WEBVIEW2_LOADER) {
        SYSROOT = $$(SYSTEMROOT)
        isEmpty(SYSROOT): SYSROOT = C:/Windows
        msvc {
            QMAKE_POST_LINK += $$QMAKE_COPY \"$$shell_path($$WEBVIEW2_LOADER)\" \"$$shell_path($$OUT_PWD)/$(DESTDIR)\"
        } else {
            QMAKE_POST_LINK += MSYS_NO_PATHCONV=1 \"$$system_path($$SYSROOT/System32/xcopy.exe)\" /Y /Q \"$$system_path($$WEBVIEW2_LOADER)\" \"$$system_path($$OUT_PWD)\"
        }
    } else {
        warning("WebView2 SDK 缺少 build/native/x64/WebView2Loader.dll：构建可以继续，但运行时需要把它放到 Mote.exe 同目录")
    }
}

macx {
    ICON = resources/icons/app.icns
    QMAKE_INFO_PLIST = packaging/macos/Info.plist

    # 系统 WKWebView：不引入 QtWebEngine，也不增加包体（WebKit 为系统框架）
    OBJECTIVE_SOURCES += src/macwebview.mm
    HEADERS += src/macwebview.h
    LIBS += -framework WebKit
}
