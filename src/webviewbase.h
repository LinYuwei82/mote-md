#ifndef WEBVIEWBASE_H
#define WEBVIEWBASE_H

#include "webview.h"

#include <QString>
#include <QStringList>
#include <QUrl>

// 共享的拖放路径判定：macOS 的 NSView 拖放与 Windows 的 OLE IDropTarget 共用，
// 保证两端「哪些文件可以拖入」的口径一致。
bool moteIsMarkdownPath(const QString &path);
bool moteIsImagePath(const QString &path);

// macOS / Windows 宿主的公共实现：消息协议分发、图片落盘、原生拖放，
// 以及「页面就绪前缓存待注入文档」的状态机。平台子类只提供三个钩子：
// ensureHost（创建原生 WebView）、evaluateJs（执行脚本）、loadPage（加载页面）。
//
// 本类只做搬运：从 macwebview.mm 抽出的逻辑保持原有行为，
// Windows 宿主复用同一套 JSON 协议。
class WebViewBase : public WebEditor
{
    Q_OBJECT

public:
    explicit WebViewBase(QWidget *parent = nullptr) : WebEditor(parent) {}

    void setMarkdown(const QString &text, const QUrl &baseDir) override;
    void newDocument() override;
    void setBaseDir(const QUrl &dir) override;
    void requestSnapshot() override;
    void notifySaved(const QString &text) override;
    void undo() override;
    void redo() override;
    void clipboardCommand(const QString &command) override;
    void toggleToc() override;
    void toggleSource() override;
    void zoomBy(int steps) override;
    void resetZoom() override;
    void setTheme(const QString &mode) override;
    void applyFormat(const QString &action) override;
    void requestExportHtml(const QString &title) override;
    void requestExportPdf(const QString &filePath) override;

    // 由平台消息桥调用：参数是前端 postMessage 的 JSON 文本
    void handleMessage(const QString &json);

    // 当前页面代次：每次 loadPage 递增。macOS 把它写进页面 URL 的 fragment，
    // 消息桥据此丢弃上一个页面迟到的 ready（跨页竞态的防线）。
    quint64 pageGeneration() const { return m_pageGeneration; }

    // 由原生拖放回调调用：paths 是拖放板里的真实文件路径。
    // .md 发 fileDropRequested 交给外壳打开；图片复制进 assets/ 并插入页面。
    // 返回 true 表示至少处理了一个文件。
    bool handleNativeFileDrop(const QStringList &paths);

    // 拖放能否接受：只要含一个可识别的 .md 或图片就返回 true。
    // 供原生拖放层在 DragEnter/DragOver 阶段决定光标效果。
    bool acceptsNativeFileDrop(const QStringList &paths) const;

protected:
    // 创建原生 WebView（可重复调用，内部自行判重）
    virtual void ensureHost() = 0;
    // 把脚本送进页面；页面未就绪时由调用方保证脚本本身可安全空转
    virtual void evaluateJs(const QString &js) = 0;
    // 加载编辑器页面；baseDir 为空表示未命名的内置示例
    virtual void loadPage(const QUrl &baseDir) = 0;
    // 页面首次 ready 后的平台附加动作（诊断钩子等）
    virtual void pageReady() {}
    // Windows 可用 PostWebMessageAsJson 走大文档通道，macOS 保持脚本注入
    virtual void injectMarkdown(const QString &text);
    // 平台打印钩子：把渲染态整篇正文写成 A4 PDF 到 filePath。
    // 异步的平台（WebView2 的 PrintToPdfAsync）在完成时自行发信号；
    // 同步的平台（WKWebView 的打印操作）返回后立即发信号。
    virtual void exportPdfNative(const QString &filePath) = 0;

    void applyTheme();
    void applyBaseHref();
    void insertImage(const QString &rel);
    bool saveImageBytes(const QByteArray &bytes, const QString &mime,
                        const QString &hint, bool isPaste);
    bool saveImageFile(const QString &path);

    QUrl m_baseDir;
    QString m_pendingText;
    QString m_lastSavedText; // 最近一次保存的正文，换目录重载时用它恢复
    bool m_hasPending = false;
    bool m_pageLoaded = false;
    bool m_pageReady = false;
    quint64 m_pageGeneration = 0; // 见 pageGeneration()
    QString m_theme = QStringLiteral("light"); // 页面就绪前先记住，ready 后补发
    QString m_pendingPdfPath; // ready 之前请求的 PDF 导出：页面就绪后再执行
};

#endif // WEBVIEWBASE_H
