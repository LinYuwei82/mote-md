#include "webviewbase.h"

#include "webpage.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
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
    // 未命名文档没有磁盘位置：清掉 baseDir，图片粘贴会走「请先保存」提示
    m_baseDir = QUrl();
    m_pendingText.clear();
    m_hasPending = false;
    evaluateJs(QStringLiteral("window.mote && window.mote.newDocument();"));
}

void WebViewBase::setBaseDir(const QUrl &dir)
{
    // 另存为后只改图片落盘位置，不重载页面（保住编辑状态与光标）
    m_baseDir = dir;
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
        emit statusMessage(tr("图片未插入：写入不完整（assets/%1）").arg(name));
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
        applyTheme();
        emit ready();
        if (m_hasPending)
            injectMarkdown(m_pendingText);
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
