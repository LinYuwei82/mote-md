#ifndef WEBVIEW_H
#define WEBVIEW_H

#include <QUrl>
#include <QWidget>

// 与平台无关的 WebView 编辑器接口。macOS 由 WKWebView 实现，
// Windows 由 WebView2 实现（src/webview_win.*），其余平台由 webview_stub.cpp 占位。
// Qt 外壳只依赖该接口，负责文件读写、未保存提示与窗口标题。
class WebEditor : public QWidget
{
    Q_OBJECT

public:
    explicit WebEditor(QWidget *parent = nullptr) : QWidget(parent) {}
    ~WebEditor() override = default;

    // 注入整篇 Markdown；baseDir 用于解析图片等相对路径
    virtual void setMarkdown(const QString &text, const QUrl &baseDir) = 0;
    // 新建空白文档：清空块与查找、目录、缩放状态，光标落进空块可直接输入
    virtual void newDocument() = 0;
    // 另存为后同步图片落盘目录（不重载页面）
    virtual void setBaseDir(const QUrl &dir) = 0;
    // 请求前端把当前源文本通过 saveRequested 回传
    virtual void requestSnapshot() = 0;
    // 写盘成功后回填「已保存」基准，供前端判断未保存标记（撤销回保存点时圆点消失）
    virtual void notifySaved(const QString &text) = 0;
    // 供原生菜单直接驱动前端的自建历史栈（不依赖页面是否收到 keydown）
    virtual void undo() = 0;
    virtual void redo() = 0;
    // 基础编辑：剪切 / 复制 / 粘贴，command 取 "cut" / "copy" / "paste"。
    // 系统 WebView 没有给宿主的可编程编辑命令接口（WKWebView 的 cut:/copy:/paste:
    // 只经由菜单响应链生效，WebView2 只有自带加速键），因此统一由页面实现：
    // 复制/剪切把纯文本回传宿主写系统剪贴板，粘贴把剪贴板内容送回页面插入。
    virtual void clipboardCommand(const QString &command) = 0;
    // 视图控制：目录侧栏、源码模式、缩放（前端实现，Qt 只负责下发与同步状态）
    virtual void toggleToc() = 0;
    virtual void toggleSource() = 0;
    virtual void zoomBy(int steps) = 0;
    virtual void resetZoom() = 0;
    // 主题：'light' / 'dark'（由外壳决定；跟随系统时由外壳监听系统配色后下发）
    virtual void setTheme(const QString &mode) = 0;
    // 格式动作（粗体/标题/列表/代码块…）：前端与斜杠菜单、右键「转为」共用同一实现
    virtual void applyFormat(const QString &action) = 0;
    // 导出自包含 HTML：前端渲染好整篇 HTML 后经 exportHtmlReady 回传，由外壳写盘
    virtual void requestExportHtml(const QString &title) = 0;
    // 导出 PDF：渲染态整篇正文，A4、无页眉页脚。各平台异步完成，
    // 成功发 pdfExportFinished，失败发 pdfExportFailed（含可读原因）。
    virtual void requestExportPdf(const QString &filePath) = 0;

signals:
    void ready();
    void viewStateChanged(bool tocOn, bool sourceOn, qreal zoom);
    void dirtyChanged(bool dirty);
    // 字数统计：CJK 字符数 + 英文单词数（口径见前端 countText，README/PACKAGING 同步说明）
    void statsChanged(int cjkChars, int words);
    void saveRequested(const QString &text);
    void openRequested();
    void dropReceived(const QString &name, const QString &text);
    // 原生拖放接住了带真实路径的文件：.md 交给外壳打开，图片由原生落盘后回调页面
    void fileDropRequested(const QString &path);
    // 原生层的提示（图片落盘成功/失败等），由外壳显示在状态栏
    void statusMessage(const QString &text);
    void errorOccurred(const QString &message);
    // 渲染态 Cmd+Click 链接：href 原样交给外壳（相对 .md / 外部 URL / 锚点分别处理）
    void openLinkRequested(const QString &href);
    // 导出的自包含 HTML（图片仍是原文里的相对路径，由外壳读盘替换成 base64）
    void exportHtmlReady(const QString &html);
    // PDF 导出结果：成功带回最终路径，失败带回可读原因
    void pdfExportFinished(const QString &filePath);
    void pdfExportFailed(const QString &message);
};

// 平台工厂：macOS 返回 WKWebView 实现，Windows 返回 WebView2 实现；
// 既非 macOS 也非 Windows 的平台返回 nullptr（由外壳显示占位提示）
WebEditor *createWebEditor(QWidget *parent);

#endif // WEBVIEW_H
