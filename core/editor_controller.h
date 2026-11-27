#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace mote {

struct ViewState {
    bool toc = false;
    bool source = false;
    double zoom = 1.0;
};

// 平台外壳实现的回调。core 只管状态机与前后端协议，不碰任何平台 API；
// 菜单、对话框、剪贴板、WebView 全部由外壳落到底层。
class EditorHost
{
public:
    virtual ~EditorHost() = default;

    // 必需：执行脚本、加载编辑器页面（baseDir 为空表示未命名文档）
    virtual void evaluateJs(const std::string &script) = 0;
    virtual void loadPage(const std::string &baseDir) = 0;

    // 正文注入：默认拼一条 setMarkdown 脚本；大文档平台可覆盖为消息或分片通道
    virtual void injectDocument(const std::string &text);

    virtual void setClipboard(const std::string &text, const std::string &html)
    {
        (void)text;
        (void)html;
    }
    virtual std::string clipboardText() { return {}; }
    // 剪贴板里的图片：平台解码成 PNG/JPEG 字节后交给 core 落盘，返回 false 表示没有图片
    virtual bool clipboardImage(std::vector<std::uint8_t> *bytes, std::string *mime)
    {
        (void)bytes;
        (void)mime;
        return false;
    }
    virtual void openExternal(const std::string &url) { (void)url; }
    virtual void saveRequested(const std::string &text) { (void)text; }
    virtual void openRequested() {}
    virtual void dropReceived(const std::string &name, const std::string &text)
    {
        (void)name;
        (void)text;
    }
    virtual void exportHtmlReady(const std::string &html) { (void)html; }
    virtual void exportPdfRequested(const std::string &path) { (void)path; }
    virtual void exportPdfFailed(const std::string &message) { (void)message; }
    virtual void fileDropRequested(const std::string &path) { (void)path; }
    virtual void statusMessage(const std::string &message) { (void)message; }
    virtual void errorOccurred(const std::string &message) { (void)message; }
    virtual void ready() {}
    virtual void dirtyChanged(bool dirty) { (void)dirty; }
    virtual void viewStateChanged(const ViewState &state) { (void)state; }
    virtual void statsChanged(int cjk, int words)
    {
        (void)cjk;
        (void)words;
    }
    virtual void logMessage(const std::string &message) { (void)message; }
};

// 文档与页面状态机（自 WebViewBase 抽出，行为保持一致）：
//   - 页面代次在每次换页前自增，旧页消息由平台消息桥按 fragment 丢弃
//   - ready 之前收到的正文先缓存，ready 后连同 <base>、主题一起补发
//   - 换目录必须重载页面（WKWebView/WebView2 的读权限在加载时固定）
class EditorController
{
public:
    explicit EditorController(EditorHost &host) : m_host(host) {}

    void setMarkdown(const std::string &text, const std::string &baseDir);
    void newDocument();
    void setBaseDir(const std::string &dir);
    // 页面读权限授权根（mac=NSHomeDirectory / win=%USERPROFILE%）：壳在创建
    // 控制器后立即设置。baseDir 落在根内时换文档只需改 <base> 并注入正文，
    // 不再重载页面（省掉整份前端脚本的重新解析）；越界目录退回重载兜底。
    // 留空表示不启用（保持「目录变化即重载」的旧行为，作为回滚开关）。
    void setReadAccessRoot(std::string root) { m_readAccessRoot = std::move(root); }
    void requestSnapshot();
    void notifySaved(const std::string &text);
    void undo();
    void redo();
    void clipboardCommand(const std::string &command);
    void toggleToc();
    void toggleSource();
    void zoomBy(int steps);
    void resetZoom();
    void setTheme(const std::string &mode);
    void applyFormat(const std::string &action);
    void requestExportHtml(const std::string &title);
    void requestExportPdf(const std::string &path);

    // 由平台消息桥调用：参数是前端 postMessage 的 JSON 文本
    void handleMessage(std::string_view json);

    // 原生拖放：.md 交给外壳打开；图片复制进 assets/ 并插入页面
    bool acceptsNativeFileDrop(const std::vector<std::string> &paths) const;
    bool handleNativeFileDrop(const std::vector<std::string> &paths);

    std::uint64_t pageGeneration() const { return m_pageGeneration; }
    bool pageReady() const { return m_pageReady; }
    bool dirty() const { return m_dirty; }
    // 页面是否处于「自建跨块选区」状态（Shift+↑/↓ 跨块选区，原型）。
    // 此时原生选区是折叠的，macOS 菜单的复制/剪切必须改走 clipboardCommand。
    bool crossSelection() const { return m_crossSelection; }
    const std::string &baseDir() const { return m_baseDir; }
    const std::string &lastSavedText() const { return m_lastSavedText; }
    const std::string &theme() const { return m_theme; }
    const std::string &pendingPdfPath() const { return m_pendingPdfPath; }

private:
    void injectMarkdown(const std::string &text);
    void applyBaseHref();
    void applyTheme();
    void insertImage(const std::string &relativePath);
    bool saveImageBytes(const std::vector<std::uint8_t> &bytes, const std::string &mime,
                        const std::string &hint, bool isPaste);
    bool saveImageFile(const std::string &path);

    EditorHost &m_host;
    std::string m_baseDir;
    std::string m_pendingText;
    std::string m_lastSavedText; // 最近一次保存的正文，换目录重载时用它恢复
    std::string m_pendingPdfPath; // ready 之前请求的 PDF 导出：页面就绪后再执行
    std::string m_theme = "light"; // 页面就绪前先记住，ready 后补发
    bool m_hasPending = false;
    bool m_pageLoaded = false;
    bool m_pageReady = false;
    bool m_dirty = false;
    bool m_crossSelection = false; // 页面自建跨块选区的开关，随换页复位
    // 换页免重载：授权根由壳设置；m_pageScopedToRoot 记录当前页面实际
    // 获得的读作用域是否为授权根（越界目录的页面只授了该目录本身）。
    std::string m_readAccessRoot;
    bool m_pageScopedToRoot = false;
    std::uint64_t m_pageGeneration = 0;
};

} // namespace mote
