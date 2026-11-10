QT += core gui widgets

TEMPLATE = app
TARGET = Mote

CONFIG += c++20 warn_on
CONFIG -= debug_and_release
CONFIG += release

SOURCES += \
    src/main.cpp \
    src/mainwindow.cpp \
    src/previewview.cpp \
    src/codehighlighter.cpp \
    src/webwindow.cpp \
    src/webview_stub.cpp

HEADERS += \
    src/mainwindow.h \
    src/previewview.h \
    src/codehighlighter.h \
    src/webwindow.h \
    src/webview.h

RESOURCES += resources/resources.qrc

# 运行时图标、样式、示例文档都通过 .qrc 打进二进制，不依赖外部路径
# 前端编辑器（HTML/CSS/JS）同样编进 qrc，经 :/web/ 读取后内联成单页加载

win32 {
    RC_FILE = resources/win/app.rc
    # 关闭控制台窗口（Windows 下双击不弹黑框）
    CONFIG -= console
}

macx {
    ICON = resources/icons/app.icns
    QMAKE_INFO_PLIST = packaging/macos/Info.plist

    # 系统 WKWebView：不引入 QtWebEngine，也不增加包体（WebKit 为系统框架）
    OBJECTIVE_SOURCES += src/macwebview.mm
    HEADERS += src/macwebview.h
    LIBS += -framework WebKit
}
