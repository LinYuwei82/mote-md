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
    // 返回 false 表示这次导航不该发生（外部站点 / 非编辑器页面），调用方 put_Cancel
    bool onNavigationStarting(const QString &uri);
    // 页面要求开新窗口（target=_blank / window.open）：交回外壳的「打开链接」出口
    void onExternalUrl(const QString &url);
    // 注入回执：ExecuteScript 返回 S_OK 只代表脚本被提交，JS 抛异常或 window.mote
    // 还没就位时它照样是 S_OK。只有脚本显式返回 'ok' 才清 pending。
    // 由 ScriptResultHandler（COM 完成回调）调用，需与其它回调入口同属 public。
    void onInjectResult(long hr, const QString &resultJson, bool chunked);
    // PDF 导出完成（PrintToPdfAsync 的 COM 回调），在 UI 线程调用
    void onPdfExported(bool success);
    // pdfBegin 脚本执行完：此时页面已进入导出态，再启动 PrintToPdfAsync
    void onPdfBeginDone();
    // 导航完成后重绑拖放目标：WebView2 的子窗口可能在导航/重建后被替换，
    // 句柄悬空会导致拖放静默失效。
    void refreshDropTarget();

protected:
    void showEvent(QShowEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;

    void ensureHost() override;
    void evaluateJs(const QString &js) override;
    void loadPage(const QUrl &baseDir) override;
    void injectMarkdown(const QString &text) override;
    void exportPdfNative(const QString &filePath) override;

private:
    void startEnvironment();
    void configureWebView();
    void navigateFor(const QUrl &baseDir);
    void updateBounds();
    void showUnavailable(const QString &reason);

    // 可见失败提示：覆盖层 + errorOccurred（win32 构建没有控制台，stderr 看不见）。
    // 导航失败用它，成功导航前先清掉，避免旧提示盖住新页面。
    void showFailureOverlay(const QString &title, const QString &body);
    void clearFailureOverlay();
    void reportNavigationFailure(const QString &step, long hr);
    // 大文档注入的回落通道：分片 ExecuteScript，每片单独受脚本体积预算约束
    bool injectChunked(const QString &text);

    // 系统级拖放：优先注册到 WebView2 实际命中拖放的子窗口（Chrome_WidgetWin_1 /
    // Chrome_RenderWidgetHostHWND），注册不到时退回宿主窗口；无论挂在哪，
    // 交付逻辑都由共享层的路径判定处理。
    void ensureDropTarget();
    void disableWebViewExternalDrop();

    void *m_environment = nullptr; // ICoreWebView2Environment *
    void *m_controller = nullptr;  // ICoreWebView2Controller *
    void *m_webView = nullptr;     // ICoreWebView2 *
    void *m_loader = nullptr;      // WebView2Loader.dll 模块句柄
    void *m_hostHwnd = nullptr;    // 本控件的原生 HWND
    void *m_dropTarget = nullptr;  // 自建 IDropTarget（见 webview_win_drop.cpp）
    void *m_dropHwnd = nullptr;    // 拖放实际注册到的 HWND（子窗口或宿主）
    qint64 m_messageToken = 0;     // WebMessageReceived 注册令牌
    qint64 m_accelToken = 0;       // AcceleratorKeyPressed 注册令牌
    qint64 m_navToken = 0;         // NavigationStarting 注册令牌
    qint64 m_newWindowToken = 0;   // NewWindowRequested 注册令牌
    qint64 m_navDoneToken = 0;     // NavigationCompleted 注册令牌（用于重绑拖放）

    bool m_initialized = false;
    bool m_controllerReady = false;
    bool m_unavailableShown = false; // WebView2 运行时缺失：覆盖层是终态，只提示一次
    QUrl m_deferredDir;
    bool m_hasDeferredLoad = false;
    QString m_pageFile;            // 文档目录下的临时页面文件，退出/换文档时删除
    QString m_pageUrl;             // 上一次导航用的完整 URL（白名单按它精确放行）
    QString m_pdfPath;             // 进行中的 PDF 导出目标（完成回调据此回报）
    void *m_pdfWeb7 = nullptr;     // ICoreWebView2_7 *（导出期间暂存）
    void *m_pdfSettings = nullptr; // ICoreWebView2PrintSettings *（导出期间暂存）
    QLabel *m_unavailable = nullptr; // 覆盖层（WebView2 缺失 / 导航失败的可见提示）
};

#endif // WEBVIEW_WIN_H
