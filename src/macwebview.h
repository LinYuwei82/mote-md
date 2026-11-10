#ifndef MACWEBVIEW_H
#define MACWEBVIEW_H

#include "webview.h"

// macOS 实现：把 WKWebView 作为原生子视图挂进 Qt 窗口。
// Q_OBJECT 放在 C++ 头文件里，便于 moc 处理；实现文件为 .mm。
class MacWebView : public WebEditor
{
    Q_OBJECT

public:
    explicit MacWebView(QWidget *parent = nullptr);
    ~MacWebView() override;

    void setMarkdown(const QString &text, const QUrl &baseDir) override;
    void newDocument() override;
    void setBaseDir(const QUrl &dir) override;
    void requestSnapshot() override;
    void notifySaved(const QString &text) override;
    void undo() override;
    void redo() override;
    void toggleToc() override;
    void toggleSource() override;
    void zoomBy(int steps) override;
    void resetZoom() override;
    void setTheme(const QString &mode) override;
    void applyFormat(const QString &action) override;
    void requestExportHtml(const QString &title) override;

    // 由 Objective-C++ 的消息处理器调用
    void handleMessage(const QString &json);

    // 由 WKWebView 的拖放回调调用：paths 来自拖放板里的真实文件 URL。
    // .md 发 fileDropRequested 交给外壳打开；图片复制进 assets/ 并插入页面。
    // 返回 true 表示至少处理了一个文件（其余类型交回 WebKit 默认行为）。
    bool handleNativeFileDrop(const QStringList &paths);

protected:
    void showEvent(QShowEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;

private:
    void ensureWebView();
    void loadPage(const QUrl &baseDir);
    void injectMarkdown(const QString &text);
    void runEvalProbe();
    bool saveImageBytes(const QByteArray &bytes, const QString &mime,
                        const QString &hint, bool isPaste);
    bool saveImageFile(const QString &path);
    void insertImage(const QString &rel);
    void applyTheme();

    void *m_webView = nullptr;   // WKWebView *
    void *m_handler = nullptr;   // MoteMessageHandler *
    void *m_navDelegate = nullptr; // MoteNavigationDelegate *（挡住页面自行导航）
    void *m_keyMonitor = nullptr; // NSEvent 本地监视器（撤销/重做按键）
    QUrl m_baseDir;
    QString m_pendingText;
    bool m_hasPending = false;
    bool m_pageLoaded = false;
    bool m_pageReady = false;
    bool m_dropProbeDone = false; // 诊断用 MOTE_DROP 只执行一次
    QString m_pageFile;           // 文档目录下的临时页面文件，退出时删除
    QString m_theme = QStringLiteral("light"); // 页面就绪前先记住，ready 后补发
};

#endif // MACWEBVIEW_H
