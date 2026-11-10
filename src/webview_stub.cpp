#include "webview.h"

#if !defined(Q_OS_MACOS) && !defined(Q_OS_WIN)

// Linux 等其它平台占位：尚未实现原生 WebView 宿主。
// 外壳检测到 nullptr 时会显示提示，不会崩溃。
WebEditor *createWebEditor(QWidget *parent)
{
    Q_UNUSED(parent)
    return nullptr;
}

#endif // !Q_OS_MACOS && !Q_OS_WIN
