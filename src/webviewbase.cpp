#include "webviewbase.h"

#include "webpage.h"

#include <QBuffer>
#include <QClipboard>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMimeData>
#include <QRegularExpression>

#include <cstdio>

namespace {

bool keyLogEnabled()
{
    return qEnvironmentVariableIsSet("MOTE_KEYLOG");
}

// ---- 图片落盘命名 ----
// 扩展名优先取原文件名，其次按 MIME；都没命中就按 PNG。
QString imageExtension(const QString &mime, const QString &name)
{
    QString suffix = QFileInfo(name).suffix().toLower();
    if (suffix == QLatin1String("jpeg"))
        suffix = QStringLiteral("jpg");
    if (!suffix.isEmpty())
        return suffix;
    if (mime.contains(QLatin1String("jpeg")))
        return QStringLiteral("jpg");
    if (mime.contains(QLatin1String("gif")))
        return QStringLiteral("gif");
    if (mime.contains(QLatin1String("webp")))
        return QStringLiteral("webp");
    if (mime.contains(QLatin1String("tiff")))
        return QStringLiteral("tiff");
    return QStringLiteral("png");
}

// 只保留安全字符；为空时退回 image
QString sanitizedBase(const QString &name)
{
    QString base = QFileInfo(name).completeBaseName();
    base.replace(QRegularExpression(QStringLiteral("[^A-Za-z0-9._-]+")), QStringLiteral("-"));
    base.remove(QRegularExpression(QStringLiteral("^[-.]+")));
    if (base.isEmpty())
        base = QStringLiteral("image");
    return base;
}

// 重名不覆盖：已存在就依次试 -2、-3……
QString uniqueAssetName(const QString &dir, const QString &base, const QString &extension)
{
    QDir assets(dir);
    QString candidate = base + QLatin1Char('.') + extension;
    int serial = 2;
    while (assets.exists(candidate))
        candidate = base + QLatin1Char('-') + QString::number(serial++) + QLatin1Char('.') + extension;
    return candidate;
}

} // namespace

bool moteIsMarkdownPath(const QString &path)
{
    const QString suffix = QFileInfo(path).suffix().toLower();
    return suffix == QLatin1String("md") || suffix == QLatin1String("markdown")
        || suffix == QLatin1String("mdown") || suffix == QLatin1String("mkd")
        || suffix == QLatin1String("txt");
}

bool moteIsImagePath(const QString &path)
{
    static const QStringList extensions = {
        QStringLiteral("png"), QStringLiteral("jpg"), QStringLiteral("jpeg"),
        QStringLiteral("gif"), QStringLiteral("webp"), QStringLiteral("heic"),
        QStringLiteral("tif"), QStringLiteral("tiff"), QStringLiteral("bmp")
    };
    return extensions.contains(QFileInfo(path).suffix().toLower());
}

void WebViewBase::setMarkdown(const QString &text, const QUrl &baseDir)
{
    ensureHost();

    if (!m_pageLoaded || baseDir != m_baseDir) {
        m_baseDir = baseDir;
        m_pendingText = text;
        m_hasPending = true;
        m_pageLoaded = true;
        m_pageReady = false;
        // 换页前推进代次：旧页面迟到的 ready 会带着旧 token，被消息桥丢弃
        ++m_pageGeneration;
        loadPage(baseDir);
        return;
    }

    m_pendingText = text;
    m_hasPending = true;
    if (m_pageReady)
        injectMarkdown(text);
}

void WebViewBase::newDocument()
{
    // 未命名文档没有磁盘位置：清掉 baseDir，图片粘贴会走「请先保存」提示。
    // 这里不能走 setBaseDir()（那会重载页面并把上一份正文带回来），只把 <base> 去掉。
    m_baseDir = QUrl();
    applyBaseHref();
    m_pendingText.clear();
    m_hasPending = false;
    evaluateJs(QStringLiteral("window.mote && window.mote.newDocument();"));
}

void WebViewBase::setBaseDir(const QUrl &dir)
{
    if (dir == m_baseDir)
        return;
    m_baseDir = dir;
    if (!m_pageReady) {
        // 页面正在换页：接下来那次 loadPage 已经会用新目录
        return;
    }
    // 换目录必须重载页面：WKWebView 允许读取的目录在 load 时固定，
    // 只改页内 <base> 时新目录下的图片会被拒绝读取（实测 naturalWidth=0）。
    // 代价：滚动位置回到顶部、撤销栈与编辑态重置；正文用最近一次保存的内容恢复。
    m_pendingText = m_lastSavedText;
    m_hasPending = true;
    m_pageReady = false;
    ++m_pageGeneration;
    loadPage(dir);
}

void WebViewBase::applyBaseHref()
{
    // 页面未就绪时先记在 m_baseDir 里，ready 分支会再推一次
    if (!m_pageReady)
        return;
    QString local = m_baseDir.toLocalFile();
    if (local.isEmpty()) {
        evaluateJs(QStringLiteral(
            "(function(){var b=document.querySelector('base');"
            "if(b&&b.parentNode)b.parentNode.removeChild(b);})();"));
        return;
    }
    while (local.endsWith(QLatin1Char('/')))
        local.chop(1);
    const QString href = QUrl::fromLocalFile(local + QLatin1Char('/')).toString();
    evaluateJs(QStringLiteral(
        "(function(){var h=document.head;if(!h)return;var b=h.querySelector('base');"
        "if(!b){b=document.createElement('base');h.insertBefore(b,h.firstChild);}"
        "b.href=%1;})();")
        .arg(moteJsonLiteral(href)));
}

void WebViewBase::injectMarkdown(const QString &text)
{
    evaluateJs(QStringLiteral("window.mote && window.mote.setMarkdown(%1);")
                   .arg(moteJsonLiteral(text)));
    m_hasPending = false;
}

void WebViewBase::requestSnapshot()
{
    evaluateJs(QStringLiteral("window.mote && window.mote.requestSnapshot();"));
}

void WebViewBase::notifySaved(const QString &text)
{
    m_lastSavedText = text;
    evaluateJs(QStringLiteral("window.mote && window.mote.markSaved(%1);")
                   .arg(moteJsonLiteral(text)));
}

void WebViewBase::undo()
{
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS undo\n");
    evaluateJs(QStringLiteral("window.mote && window.mote.undo();"));
}

void WebViewBase::redo()
{
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS redo\n");
    evaluateJs(QStringLiteral("window.mote && window.mote.redo();"));
}

void WebViewBase::clipboardCommand(const QString &command)
{
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS clipboard %s\n", command.toUtf8().constData());

    // 默认实现供 Windows 宿主使用：WebView2 没有给宿主的编辑命令接口，菜单与
    // 快捷键怎么算都只能落到页面。macOS 在 MacWebView 里覆盖为 AppKit 响应链。
    if (command == QLatin1String("copy") || command == QLatin1String("cut")) {
        // 页面算出纯文本后经 clipboardWrite 回传，由这里写进系统剪贴板；
        // 剪切由页面在同一步里删掉选区，两端都走自建历史栈。
        evaluateJs(QStringLiteral("window.mote && window.mote.clipboardCopy(%1);")
                       .arg(command == QLatin1String("cut") ? QStringLiteral("true")
                                                           : QStringLiteral("false")));
        return;
    }
    if (command != QLatin1String("paste"))
        return;

    const QMimeData *data = QGuiApplication::clipboard()->mimeData();
    if (!data) {
        emit statusMessage(tr("剪贴板里没有可粘贴的文本"));
        return;
    }
    // 图片优先：与页面原生粘贴分支同口径，落盘与插入仍走 saveImageBytes
    if (data->hasImage()) {
        const QImage image = qvariant_cast<QImage>(data->imageData());
        if (!image.isNull()) {
            QByteArray bytes;
            QBuffer buffer(&bytes);
            buffer.open(QIODevice::WriteOnly);
            if (image.save(&buffer, "PNG")) {
                saveImageBytes(bytes, QStringLiteral("image/png"),
                               QStringLiteral("paste"), true);
                return;
            }
        }
    }
    const QString text = data->text();
    if (text.isEmpty()) {
        emit statusMessage(tr("剪贴板里没有可粘贴的文本"));
        return;
    }
    evaluateJs(QStringLiteral("window.mote && window.mote.clipboardPaste(%1);")
                   .arg(moteJsonLiteral(text)));
}

void WebViewBase::toggleToc()
{
    evaluateJs(QStringLiteral("window.mote && window.mote.toggleToc();"));
}

void WebViewBase::toggleSource()
{
    evaluateJs(QStringLiteral("window.mote && window.mote.toggleSource();"));
}

void WebViewBase::zoomBy(int steps)
{
    evaluateJs(QStringLiteral("window.mote && window.mote.zoomBy(%1);").arg(steps));
}

void WebViewBase::resetZoom()
{
    evaluateJs(QStringLiteral("window.mote && window.mote.resetZoom();"));
}

void WebViewBase::setTheme(const QString &mode)
{
    m_theme = (mode == QLatin1String("dark")) ? QStringLiteral("dark") : QStringLiteral("light");
    applyTheme();
}

void WebViewBase::applyTheme()
{
    // 只切 CSS 变量，不重排正文；页面未就绪时先记住，ready 后由这里补发
    if (!m_pageReady)
        return;
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS theme %s\n", m_theme.toUtf8().constData());
    evaluateJs(QStringLiteral("window.mote && window.mote.setTheme(%1);")
                   .arg(moteJsonLiteral(m_theme)));
}

void WebViewBase::applyFormat(const QString &action)
{
    // 格式动作名由 JS 的 formatAction 统一解释，三个入口（菜单快捷键、斜杠、右键）共用
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS format %s\n", action.toUtf8().constData());
    evaluateJs(QStringLiteral("window.mote && window.mote.format(%1);")
                   .arg(moteJsonLiteral(action)));
}

void WebViewBase::requestExportHtml(const QString &title)
{
    // 前端把整篇渲染结果拼成自包含 HTML 后经消息回传（图片路径由外壳再做 base64）
    evaluateJs(QStringLiteral("window.mote && window.mote.exportHtml(%1);")
                   .arg(moteJsonLiteral(title)));
}

void WebViewBase::insertImage(const QString &rel)
{
    evaluateJs(QStringLiteral("window.mote && window.mote.insertImage(%1);")
                   .arg(moteJsonLiteral(rel)));
}

// 把图片字节写进「md 同目录/assets/」并让页面插入 ![](assets/xxx)。
// 文档还没保存（没有目录）时明确提示，不写入任何位置。
bool WebViewBase::saveImageBytes(const QByteArray &bytes, const QString &mime,
                                 const QString &hint, bool isPaste)
{
    const QString dir = m_baseDir.toLocalFile();
    if (dir.isEmpty() || !QFileInfo(dir).isDir()) {
        emit statusMessage(tr("图片未插入：当前文档还没有保存位置，请先保存 .md 文件"));
        return false;
    }

    const QString assetsPath = QDir(dir).filePath(QStringLiteral("assets"));
    if (!QDir().mkpath(assetsPath)) {
        emit statusMessage(tr("图片未插入：无法创建 assets 目录（%1）").arg(assetsPath));
        return false;
    }

    const QString extension = imageExtension(mime, hint);
    const QString base = isPaste || hint.isEmpty()
        ? QStringLiteral("paste-") + QDateTime::currentDateTime().toString(QStringLiteral("yyyyMMdd-HHmmss"))
        : sanitizedBase(hint);
    const QString name = uniqueAssetName(assetsPath, base, extension);

    QFile out(QDir(assetsPath).filePath(name));
    if (!out.open(QIODevice::WriteOnly)) {
        emit statusMessage(tr("图片未插入：无法写入 assets/%1").arg(name));
        return false;
    }
    const qint64 written = out.write(bytes);
    out.close();
    if (written != bytes.size()) {
        // 短写会在用户目录里留下一个坏 png，还会让下次同名退化成 -2，
        // 所以先删掉残缺文件再报错
        QFile::remove(QDir(assetsPath).filePath(name));
        emit statusMessage(tr("图片未插入：写入不完整（assets/%1），已删除残缺文件").arg(name));
        return false;
    }

    const QString rel = QStringLiteral("assets/") + name;
    insertImage(rel);
    emit statusMessage(tr("已保存图片：%1").arg(rel));
    return true;
}

bool WebViewBase::saveImageFile(const QString &path)
{
    QFile in(path);
    if (!in.open(QIODevice::ReadOnly)) {
        emit statusMessage(tr("图片未插入：无法读取 %1").arg(QFileInfo(path).fileName()));
        return false;
    }
    return saveImageBytes(in.readAll(), QString(), QFileInfo(path).fileName(), false);
}

bool WebViewBase::acceptsNativeFileDrop(const QStringList &paths) const
{
    for (const QString &path : paths) {
        if (moteIsMarkdownPath(path) || moteIsImagePath(path))
            return true;
    }
    return false;
}

bool WebViewBase::handleNativeFileDrop(const QStringList &paths)
{
    bool recognized = false;
    for (const QString &path : paths) {
        if (moteIsMarkdownPath(path)) {
            recognized = true;
            emit fileDropRequested(QFileInfo(path).absoluteFilePath());
            return true;
        }
    }
    for (const QString &path : paths) {
        if (moteIsImagePath(path)) {
            recognized = true;
            saveImageFile(path);
        }
    }
    return recognized;
}

void WebViewBase::handleMessage(const QString &json)
{
    const QJsonDocument document = QJsonDocument::fromJson(json.toUtf8());
    if (!document.isObject())
        return;
    const QJsonObject message = document.object();
    const QString type = message.value(QStringLiteral("type")).toString();

    if (type == QLatin1String("ready")) {
        m_pageReady = true;
        if (keyLogEnabled())
            std::fprintf(stderr, "NATIVE ready gen=%llu\n",
                         static_cast<unsigned long long>(m_pageGeneration));
        // 先把 <base> 与待注入正文推到当前页，再对外发 ready：
        // 顺序反了会让正文里的相对图片按旧目录解析。
        applyBaseHref();
        if (m_hasPending)
            injectMarkdown(m_pendingText);
        applyTheme();
        emit ready();
        pageReady();
        return;
    }
    if (type == QLatin1String("view")) {
        emit viewStateChanged(message.value(QStringLiteral("toc")).toBool(),
                              message.value(QStringLiteral("source")).toBool(),
                              message.value(QStringLiteral("zoom")).toDouble(1.0));
        return;
    }
    if (type == QLatin1String("dirty")) {
        emit dirtyChanged(message.value(QStringLiteral("value")).toBool());
        return;
    }
    if (type == QLatin1String("stats")) {
        emit statsChanged(message.value(QStringLiteral("cjk")).toInt(),
                          message.value(QStringLiteral("words")).toInt());
        return;
    }
    if (type == QLatin1String("save")) {
        emit saveRequested(message.value(QStringLiteral("text")).toString());
        return;
    }
    if (type == QLatin1String("open")) {
        emit openRequested();
        return;
    }
    if (type == QLatin1String("drop")) {
        emit dropReceived(message.value(QStringLiteral("name")).toString(),
                          message.value(QStringLiteral("text")).toString());
        return;
    }
    if (type == QLatin1String("image")) {
        const QByteArray data = QByteArray::fromBase64(
            message.value(QStringLiteral("data")).toString().toLatin1());
        if (data.isEmpty()) {
            emit statusMessage(tr("图片未插入：剪贴板内容为空"));
            return;
        }
        const QString source = message.value(QStringLiteral("source")).toString();
        saveImageBytes(data,
                       message.value(QStringLiteral("mime")).toString(),
                       message.value(QStringLiteral("name")).toString(),
                       source != QLatin1String("drop"));
        return;
    }
    if (type == QLatin1String("editCommand")) {
        // 页面（右键菜单）把编辑命令交回宿主，与编辑菜单、快捷键同一条路径
        clipboardCommand(message.value(QStringLiteral("command")).toString());
        return;
    }
    if (type == QLatin1String("clipboardWrite")) {
        // 页面算好的内容落到系统剪贴板（复制/剪切共用这一条回路）。
        // html 是后加的可选字段：旧页面不带它就保持纯文本，新页面带上则同时写
        // text/html，Windows 由 Qt 落成 CF_HTML（HTML Format），macOS 落成
        // public.html，粘到 Word / 邮件里仍有格式。
        const QString text = message.value(QStringLiteral("text")).toString();
        const QString html = message.value(QStringLiteral("html")).toString();
        if (html.isEmpty()) {
            QGuiApplication::clipboard()->setText(text);
        } else {
            auto *data = new QMimeData;
            data->setText(text);
            data->setHtml(html);
            QGuiApplication::clipboard()->setMimeData(data);
        }
        return;
    }
    if (type == QLatin1String("openLink")) {
        emit openLinkRequested(message.value(QStringLiteral("href")).toString());
        return;
    }
    if (type == QLatin1String("export")) {
        emit exportHtmlReady(message.value(QStringLiteral("html")).toString());
        return;
    }
    if (type == QLatin1String("status")) {
        emit statusMessage(message.value(QStringLiteral("message")).toString());
        return;
    }
    if (type == QLatin1String("error")) {
        emit errorOccurred(message.value(QStringLiteral("message")).toString());
        return;
    }
    if (type == QLatin1String("log")) {
        if (keyLogEnabled()) {
            const QByteArray line = message.value(QStringLiteral("message")).toString().toUtf8();
            std::fprintf(stderr, "JSLOG %s\n", line.constData());
        }
    }
}
