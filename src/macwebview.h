#ifndef MACWEBVIEW_H
#define MACWEBVIEW_H

#include "webviewbase.h"

// macOS 实现：把 WKWebView 作为原生子视图挂进 Qt 窗口。
// Q_OBJECT 放在 C++ 头文件里，便于 moc 处理；实现文件为 .mm。
// 消息分发、图片落盘、拖放等公共逻辑在 WebViewBase 中（macOS / Windows 共用）。
class MacWebView : public WebViewBase
{
    Q_OBJECT

public:
    explicit MacWebView(QWidget *parent = nullptr);
    ~MacWebView() override;

    void clipboardCommand(const QString &command) override;

protected:
    void showEvent(QShowEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;

    void ensureHost() override;
    void evaluateJs(const QString &js) override;
    void loadPage(const QUrl &baseDir) override;
    void pageReady() override;
    void exportPdfNative(const QString &filePath) override;

private:
    void ensureWebView();
    void runEvalProbe();

    void *m_webView = nullptr;   // WKWebView *
    void *m_handler = nullptr;   // MoteMessageHandler *
    void *m_navDelegate = nullptr; // MoteNavigationDelegate *（挡住页面自行导航）
    void *m_keyMonitor = nullptr; // NSEvent 本地监视器（撤销/重做按键）
    bool m_dropProbeDone = false; // 诊断用 MOTE_DROP 只执行一次
    QString m_pageFile;           // 文档目录下的临时页面文件，退出时删除
};

#endif // MACWEBVIEW_H
