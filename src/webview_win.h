#ifndef WEBVIEW_WIN_H
#define WEBVIEW_WIN_H

#include "webviewbase.h"

#include <QUrl>
#include <QtGlobal>

class QLabel;

// Windows 实现：把 WebView2 作为原生子 HWND 挂进 Qt 窗口。
// 与 macOS 共用 WebViewBase 的消息协议与图片落盘逻辑；本类只负责
// WebView2 的环境/控制器生命周期、页面加载与快捷键拦截。
// COM 类型不出现在头文件里，成员以 void* 保存，避免 moc 依赖 WebView2.h。
class WebView2Editor : public WebViewBase
{
    Q_OBJECT

public:
    explicit WebView2Editor(QWidget *parent = nullptr);
    ~WebView2Editor() override;

    // 内部回调：由 COM 完成/事件处理器在 UI 线程调用
    void onEnvironmentReady(long hr, void *environment);
    void onControllerReady(long hr, void *controller);
    void onWebMessage(const QString &json);
    bool onAccelerator(int virtualKey);

protected:
    void showEvent(QShowEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;

    void ensureHost() override;
    void evaluateJs(const QString &js) override;
    void loadPage(const QUrl &baseDir) override;
    void injectMarkdown(const QString &text) override;

private:
    void startEnvironment();
    void configureWebView();
    void navigateFor(const QUrl &baseDir);
    void updateBounds();
    void showUnavailable(const QString &reason);

    void *m_environment = nullptr; // ICoreWebView2Environment *
    void *m_controller = nullptr;  // ICoreWebView2Controller *
    void *m_webView = nullptr;     // ICoreWebView2 *
    void *m_loader = nullptr;      // WebView2Loader.dll 模块句柄
    void *m_hostHwnd = nullptr;    // 本控件的原生 HWND
    qint64 m_messageToken = 0;     // WebMessageReceived 注册令牌
    qint64 m_accelToken = 0;       // AcceleratorKeyPressed 注册令牌

    bool m_initialized = false;
    bool m_controllerReady = false;
    bool m_unavailableShown = false;
    QUrl m_deferredDir;
    bool m_hasDeferredLoad = false;
    QString m_pageFile;            // 文档目录下的临时页面文件，退出/换文档时删除
    QLabel *m_unavailable = nullptr;
};

#endif // WEBVIEW_WIN_H
