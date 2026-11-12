QT += core gui widgets

TEMPLATE = app
TARGET = Mote
VERSION = 0.3.3

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
    # 放在仓库外；可用 WEBVIEW2_SDK 环境变量覆盖默认位置。
    WEBVIEW2_SDK = $$(WEBVIEW2_SDK)
    isEmpty(WEBVIEW2_SDK): WEBVIEW2_SDK = C:/dev/webview2sdk/pkg
    !exists($$WEBVIEW2_SDK/build/native/include/WebView2.h) {
        error("未找到 WebView2 SDK：请设置 WEBVIEW2_SDK 或放到 C:/dev/webview2sdk/pkg")
    }

    INCLUDEPATH += $$WEBVIEW2_SDK/build/native/include
    SOURCES += src/webview_win.cpp src/webview_win_drop.cpp
    HEADERS += src/webview_win.h src/webview_win_drop.h
    # COM 基础库：CoTaskMemFree / IID_IUnknown；shell32 提供 CF_HDROP 解析
    LIBS += -lole32 -luuid -lshell32

    # 绿色版/开发运行都需要 exe 同级的 WebView2Loader.dll。
    # 工程是 release 单配置，但产物目录随生成器不同（MinGW 在 $$OUT_PWD，
    # MSVC 在 $$OUT_PWD/release）；用 Makefile 里的 DESTDIR 让拷贝跟着实际
    # 产物目录走，不写死 release。
    WEBVIEW2_LOADER = $$WEBVIEW2_SDK/build/native/x64/WebView2Loader.dll
    exists($$WEBVIEW2_LOADER) {
        QMAKE_POST_LINK += $$QMAKE_COPY /Y \"$$shell_path($$WEBVIEW2_LOADER)\" \"$$shell_path($$OUT_PWD)/$(DESTDIR)\"
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
