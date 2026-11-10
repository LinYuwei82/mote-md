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
    src/codehighlighter.cpp

HEADERS += \
    src/mainwindow.h \
    src/previewview.h \
    src/codehighlighter.h

RESOURCES += resources/resources.qrc

# 运行时图标、样式、示例文档都通过 .qrc 打进二进制，不依赖外部路径

win32 {
    RC_FILE = resources/win/app.rc
    # 关闭控制台窗口（Windows 下双击不弹黑框）
    CONFIG -= console
}

macx {
    ICON = resources/icons/app.icns
    QMAKE_INFO_PLIST = packaging/macos/Info.plist
}
