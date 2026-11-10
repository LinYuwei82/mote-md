#include "webview.h"

#ifndef Q_OS_MACOS

// Windows / Linux 占位：WebView2 实现尚未开始（本机无 Windows 环境，未验证）。
// 外壳检测到 nullptr 时会显示提示，不会崩溃。
WebEditor *createWebEditor(QWidget *parent)
{
    Q_UNUSED(parent)
    return nullptr;
}

#endif // !Q_OS_MACOS
