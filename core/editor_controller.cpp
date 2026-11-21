#include "core/editor_controller.h"

#include "core/base64.h"
#include "core/image_store.h"
#include "core/js_bridge.h"
#include "core/json.h"
#include "core/paths.h"

#include <filesystem>

namespace mote {

void EditorHost::injectDocument(const std::string &text)
{
    evaluateJs(js::setMarkdown(text));
}

void EditorController::setMarkdown(const std::string &text, const std::string &baseDir)
{
    if (!m_pageLoaded || baseDir != m_baseDir) {
        m_baseDir = baseDir;
        m_pendingText = text;
        m_hasPending = true;
        m_pageLoaded = true;
        m_pageReady = false;
        m_crossSelection = false;
        // 新文档以载入的文本为基准：打开/新建后立刻是「未修改」
        if (m_dirty) {
            m_dirty = false;
            m_host.dirtyChanged(false);
        }
        // 换页前推进代次：旧页面迟到的 ready 会带着旧 token，被消息桥丢弃
        ++m_pageGeneration;
        m_host.loadPage(baseDir);
        return;
    }

    m_pendingText = text;
    m_hasPending = true;
    if (m_pageReady)
        injectMarkdown(text);
}

void EditorController::newDocument()
{
    // 未命名文档没有磁盘位置：清掉 baseDir，图片粘贴会走「请先保存」提示。
    // 这里不能走 setBaseDir()（那会重载页面并把上一份正文带回来），只把 <base> 去掉。
    m_baseDir.clear();
    applyBaseHref();
    m_crossSelection = false;
    m_pendingText.clear();
    m_hasPending = false;
    m_host.evaluateJs(js::newDocument());
}

void EditorController::setBaseDir(const std::string &dir)
{
    if (dir == m_baseDir)
        return;
    m_baseDir = dir;
    if (!m_pageReady) {
        // 页面正在换页：接下来那次 loadPage 已经会用新目录
        return;
    }
    // 换目录必须重载页面：WebView 允许读取的目录在加载时固定，只改页内 <base>
    // 时新目录下的图片会被拒绝读取。代价：滚动位置回到顶部、撤销栈重置；
    // 正文用最近一次保存的内容恢复。
    m_pendingText = m_lastSavedText;
    m_hasPending = true;
    m_pageReady = false;
    m_crossSelection = false;
    ++m_pageGeneration;
    m_host.loadPage(dir);
}

void EditorController::applyBaseHref()
{
    // 页面未就绪时先记在 m_baseDir 里，ready 分支会再推一次
    if (!m_pageReady)
        return;
    if (m_baseDir.empty()) {
        m_host.evaluateJs(js::clearBaseHref());
        return;
    }
    m_host.evaluateJs(js::applyBaseHref(fileUrlForDirectory(m_baseDir)));
}

void EditorController::injectMarkdown(const std::string &text)
{
    m_host.injectDocument(text);
    m_hasPending = false;
}

void EditorController::requestSnapshot()
{
    m_host.evaluateJs(js::requestSnapshot());
}

void EditorController::notifySaved(const std::string &text)
{
    m_lastSavedText = text;
    const bool wasDirty = m_dirty;
    m_dirty = false;
    m_host.evaluateJs(js::markSaved(text));
    if (wasDirty)
        m_host.dirtyChanged(false);
}

void EditorController::undo()
{
    m_host.evaluateJs(js::undo());
}

void EditorController::redo()
{
    m_host.evaluateJs(js::redo());
}

void EditorController::clipboardCommand(const std::string &command)
{
    // 页面算内容、原生写剪贴板：复制与剪切共用一条回路，剪切由页面删选区
    if (command == "copy" || command == "cut") {
        m_host.evaluateJs(js::clipboardCopy(command == "cut"));
        return;
    }
    if (command != "paste")
        return;

    // 图片优先，与页面原生粘贴分支同一口径：解码后的字节交给图片落盘逻辑
    std::vector<std::uint8_t> image;
    std::string mime;
    if (m_host.clipboardImage(&image, &mime) && !image.empty()) {
        saveImageBytes(image, mime.empty() ? "image/png" : mime, "paste", true);
        return;
    }

    const std::string text = m_host.clipboardText();
    if (text.empty()) {
        m_host.statusMessage("剪贴板里没有可粘贴的文本");
        return;
    }
    m_host.evaluateJs(js::clipboardPaste(text));
}

void EditorController::toggleToc()
{
    m_host.evaluateJs(js::toggleToc());
}

void EditorController::toggleSource()
{
    m_host.evaluateJs(js::toggleSource());
}

void EditorController::zoomBy(int steps)
{
    m_host.evaluateJs(js::zoomBy(steps));
}

void EditorController::resetZoom()
{
    m_host.evaluateJs(js::resetZoom());
}

void EditorController::setTheme(const std::string &mode)
{
    m_theme = mode == "dark" ? "dark" : "light";
    applyTheme();
}

void EditorController::applyTheme()
{
    // 只切 CSS 变量，不重排正文；页面未就绪时先记住，ready 后由这里补发
    if (!m_pageReady)
        return;
    m_host.evaluateJs(js::setTheme(m_theme));
}

void EditorController::applyFormat(const std::string &action)
{
    // 格式动作名由前端 formatAction 统一解释，菜单、斜杠、右键三个入口共用
    m_host.evaluateJs(js::format(action));
}

void EditorController::requestExportHtml(const std::string &title)
{
    // 前端把整篇渲染结果拼成自包含 HTML 后经消息回传
    m_host.evaluateJs(js::exportHtml(title));
}

void EditorController::requestExportPdf(const std::string &path)
{
    if (path.empty()) {
        m_host.exportPdfFailed("导出失败：没有指定保存位置");
        return;
    }
    // 另存为会换目录并重载页面；保存完成立刻导出时页面还没 ready。
    // 这里先记下目标，等 ready 后再交给平台执行（平台自行等待图片/字体稳定）。
    if (!m_pageReady) {
        m_pendingPdfPath = path;
        return;
    }
    m_host.exportPdfRequested(path);
}

void EditorController::insertImage(const std::string &relativePath)
{
    m_host.evaluateJs(js::insertImage(relativePath));
}

bool EditorController::saveImageBytes(const std::vector<std::uint8_t> &bytes,
                                      const std::string &mime, const std::string &hint,
                                      bool isPaste)
{
    const StoredImage stored = storeImage(m_baseDir, bytes, mime, hint, isPaste);
    if (!stored.ok) {
        m_host.statusMessage(stored.error);
        return false;
    }
    insertImage(stored.relativePath);
    m_host.statusMessage("已保存图片：" + stored.relativePath);
    return true;
}

bool EditorController::saveImageFile(const std::string &path)
{
    bool ok = false;
    const std::vector<std::uint8_t> bytes = readFileBytes(path, &ok);
    if (!ok) {
        m_host.statusMessage("图片未插入：无法读取 " + fileNameOf(path));
        return false;
    }
    return saveImageBytes(bytes, std::string(), fileNameOf(path), false);
}

bool EditorController::acceptsNativeFileDrop(const std::vector<std::string> &paths) const
{
    for (const std::string &path : paths) {
        if (isMarkdownPath(path) || isImagePath(path))
            return true;
    }
    return false;
}

bool EditorController::handleNativeFileDrop(const std::vector<std::string> &paths)
{
    bool recognized = false;
    for (const std::string &path : paths) {
        if (isMarkdownPath(path)) {
            recognized = true;
            std::error_code error;
            const std::string absolute =
                std::filesystem::absolute(path, error).lexically_normal().string();
            m_host.fileDropRequested(error ? path : absolute);
            return true;
        }
    }
    for (const std::string &path : paths) {
        if (isImagePath(path)) {
            recognized = true;
            saveImageFile(path);
        }
    }
    return recognized;
}

void EditorController::handleMessage(std::string_view json)
{
    JsonValue message;
    if (!parseJson(json, message) || !message.isObject())
        return;
    const std::string type = message.stringAt("type");

    if (type == "ready") {
        m_pageReady = true;
        // 先把 <base> 与待注入正文推到当前页，再对外发 ready：
        // 顺序反了会让正文里的相对图片按旧目录解析。
        applyBaseHref();
        if (m_hasPending)
            injectMarkdown(m_pendingText);
        applyTheme();
        m_host.ready();
        // 另存为后立刻导出：页面刚重载完，等图片与字体稳定由平台负责
        if (!m_pendingPdfPath.empty()) {
            const std::string pending = m_pendingPdfPath;
            m_pendingPdfPath.clear();
            m_host.exportPdfRequested(pending);
        }
        return;
    }
    if (type == "view") {
        ViewState state;
        state.toc = message.boolAt("toc");
        state.source = message.boolAt("source");
        state.zoom = message.numberAt("zoom", 1.0);
        m_host.viewStateChanged(state);
        return;
    }
    if (type == "dirty") {
        m_dirty = message.boolAt("value");
        m_host.dirtyChanged(m_dirty);
        return;
    }
    if (type == "stats") {
        m_host.statsChanged(static_cast<int>(message.numberAt("cjk")),
                            static_cast<int>(message.numberAt("words")));
        return;
    }
    if (type == "save") {
        m_host.saveRequested(message.stringAt("text"));
        return;
    }
    if (type == "open") {
        m_host.openRequested();
        return;
    }
    if (type == "drop") {
        m_host.dropReceived(message.stringAt("name"), message.stringAt("text"));
        return;
    }
    if (type == "image") {
        const std::vector<std::uint8_t> data = base64Decode(message.stringAt("data"));
        if (data.empty()) {
            m_host.statusMessage("图片未插入：剪贴板内容为空");
            return;
        }
        const std::string source = message.stringAt("source");
        saveImageBytes(data, message.stringAt("mime"), message.stringAt("name"),
                       source != "drop");
        return;
    }
    if (type == "crossSelection") {
        // 页面自建跨块选区（原型）：只影响菜单复制/剪切的路由，不改正文
        m_crossSelection = message.boolAt("active");
        return;
    }
    if (type == "editCommand") {
        // 页面（右键菜单）把编辑命令交回宿主，与编辑菜单、快捷键同一条路径
        clipboardCommand(message.stringAt("command"));
        return;
    }
    if (type == "clipboardWrite") {
        // 页面算好的内容落到系统剪贴板（复制/剪切共用这一条回路）。
        // html 是可选字段：不带就只写纯文本。
        m_host.setClipboard(message.stringAt("text"), message.stringAt("html"));
        return;
    }
    if (type == "openLink") {
        m_host.openExternal(message.stringAt("href"));
        return;
    }
    if (type == "export") {
        m_host.exportHtmlReady(message.stringAt("html"));
        return;
    }
    if (type == "status") {
        m_host.statusMessage(message.stringAt("message"));
        return;
    }
    if (type == "error") {
        m_host.errorOccurred(message.stringAt("message"));
        return;
    }
    if (type == "log") {
        m_host.logMessage(message.stringAt("message"));
        return;
    }
}

} // namespace mote
