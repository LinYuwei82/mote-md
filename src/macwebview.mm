#include "macwebview.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QResizeEvent>
#include <QShowEvent>
#include <QStringList>
#include <QTimer>
#include <QUrl>

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <cstdio>

namespace {

bool keyLogEnabled()
{
    return qEnvironmentVariableIsSet("MOTE_KEYLOG");
}

bool isMarkdownPath(const QString &path)
{
    const QString suffix = QFileInfo(path).suffix().toLower();
    return suffix == QLatin1String("md") || suffix == QLatin1String("markdown")
        || suffix == QLatin1String("mdown") || suffix == QLatin1String("mkd")
        || suffix == QLatin1String("txt");
}

bool isImagePath(const QString &path)
{
    static const QStringList extensions = {
        QStringLiteral("png"), QStringLiteral("jpg"), QStringLiteral("jpeg"),
        QStringLiteral("gif"), QStringLiteral("webp"), QStringLiteral("heic"),
        QStringLiteral("tif"), QStringLiteral("tiff"), QStringLiteral("bmp")
    };
    return extensions.contains(QFileInfo(path).suffix().toLower());
}

} // namespace

// 诊断用子类：只在 MOTE_KEYLOG=1 时打印，不改变任何行为。
// 用来确认 Cmd+Z 是被菜单/响应链吞掉，还是根本没到页面。
// 同时承担原生拖放：网页里的 drop 事件拿不到文件真实路径，只有 NSView 这一层能拿到。
@interface MoteWKWebView : WKWebView {
@public
    MacWebView *moteOwner;
}
@end

@implementation MoteWKWebView

- (instancetype)initWithFrame:(NSRect)frameRect configuration:(WKWebViewConfiguration *)configuration
{
    self = [super initWithFrame:frameRect configuration:configuration];
    if (self) {
        // 只登记文件 URL；文本/HTML 拖放仍交给 WebKit 自己处理
        [self registerForDraggedTypes:@[NSPasteboardTypeFileURL]];
    }
    return self;
}

- (NSArray<NSString *> *)moteDraggedPaths:(id<NSDraggingInfo>)sender
{
    NSArray *urls = [sender.draggingPasteboard
        readObjectsForClasses:@[NSURL.class]
                      options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    NSMutableArray *paths = [NSMutableArray array];
    for (NSURL *url in urls) {
        if (url.isFileURL && url.path)
            [paths addObject:url.path];
    }
    return paths;
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender
{
    if (moteOwner) {
        for (NSString *path in [self moteDraggedPaths:sender]) {
            const QString local = QString::fromNSString(path);
            if (isMarkdownPath(local) || isImagePath(local))
                return NSDragOperationCopy;
        }
    }
    return [super draggingEntered:sender];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender
{
    if (moteOwner) {
        QStringList paths;
        for (NSString *path in [self moteDraggedPaths:sender])
            paths << QString::fromNSString(path);
        if (!paths.isEmpty() && moteOwner->handleNativeFileDrop(paths))
            return YES;
    }
    return [super performDragOperation:sender];
}

- (void)keyDown:(NSEvent *)event
{
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE keyDown chars=%s flags=%lu\n",
                     event.charactersIgnoringModifiers.UTF8String,
                     (unsigned long)event.modifierFlags);
    [super keyDown:event];
}

- (BOOL)performKeyEquivalent:(NSEvent *)event
{
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE performKeyEquivalent chars=%s flags=%lu\n",
                     event.charactersIgnoringModifiers.UTF8String,
                     (unsigned long)event.modifierFlags);
    return [super performKeyEquivalent:event];
}

- (void)undo:(id)sender
{
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE undo:\n");
    [super undo:sender];
}

- (void)redo:(id)sender
{
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE redo:\n");
    [super redo:sender];
}

@end

// 消息处理器：把 WKScriptMessage.body（NSDictionary）序列化成 JSON 交给 C++。
// 手动引用计数（工程未开启 ARC），owner 为弱引用，生命周期由 MacWebView 保证。
@interface MoteMessageHandler : NSObject <WKScriptMessageHandler> {
    MacWebView *_owner;
}
- (void)setOwner:(MacWebView *)owner;
@end

@implementation MoteMessageHandler

- (void)setOwner:(MacWebView *)owner
{
    _owner = owner;
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message
{
    Q_UNUSED(controller)
    if (!_owner)
        return;
    if (![message.body isKindOfClass:[NSDictionary class]])
        return;

    NSData *data = [NSJSONSerialization dataWithJSONObject:message.body options:0 error:nil];
    if (!data)
        return;
    NSString *json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    _owner->handleMessage(QString::fromNSString(json));
}

@end

namespace {

QString quotedJson(const QString &text)
{
    // 把字符串编码成 JSON 字面量（含引号），安全地嵌进 evaluateJavaScript
    const QByteArray json = QJsonDocument(QJsonArray{text}).toJson(QJsonDocument::Compact);
    return QString::fromUtf8(json.mid(1, json.size() - 2));
}

void evalScript(void *webView, const QString &js)
{
    if (!webView)
        return;
    [static_cast<WKWebView *>(webView) evaluateJavaScript:js.toNSString() completionHandler:nil];
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

// 临时页面文件名：必须与文档同目录（loadFileURL 要求主文档在授权目录内）
QString filePathOf(const QString &dir)
{
    return QDir(dir).filePath(
        QStringLiteral(".mote-preview-%1.html").arg(QCoreApplication::applicationPid()));
}

// 代码字体随包分发：把 qrc 里的 JetBrains Mono Light 以 base64 @font-face 注入页面。
// 页面由 loadHTMLString: 载入，baseURL 指向文档目录，因此不能用 :/fonts/ 这样的
// 资源路径，只能内联成 data URI。
QString fontCss()
{
    static const QString css = [] {
        QFile font(QStringLiteral(":/fonts/JetBrainsMono-Light.ttf"));
        if (!font.open(QIODevice::ReadOnly))
            return QString();
        const QByteArray base64 = font.readAll().toBase64();
        return QStringLiteral("@font-face{font-family:'JetBrains Mono';"
                              "src:url(data:font/ttf;base64,%1) format('truetype');"
                              "font-weight:300;font-style:normal;font-display:block;}")
            .arg(QString::fromLatin1(base64));
    }();
    return css;
}

QString pageHtml()
{
    static const QString html = [] {
        QFile tmpl(QStringLiteral(":/web/editor.html"));
        QFile css(QStringLiteral(":/web/editor.css"));
        QFile js(QStringLiteral(":/web/editor.js"));
        if (!tmpl.open(QIODevice::ReadOnly) || !css.open(QIODevice::ReadOnly)
            || !js.open(QIODevice::ReadOnly)) {
            return QStringLiteral("<html><body>缺少前端资源</body></html>");
        }
        QString page = QString::fromUtf8(tmpl.readAll());
        page.replace(QStringLiteral("__MOTE_CSS__"), fontCss() + QString::fromUtf8(css.readAll()));
        // 行内标记（阶段一）默认开启：标记常驻 DOM、零宽折叠。保留开关仅作应急
        // 回退——MOTE_INLINE_PROTO=0 / false / off / no 时回到「整块替换」旧行为。
        const QString raw = qEnvironmentVariable("MOTE_INLINE_PROTO").trimmed().toLower();
        const bool protoOff = raw == QStringLiteral("0") || raw == QStringLiteral("false")
            || raw == QStringLiteral("off") || raw == QStringLiteral("no");
        const QString flag = protoOff
            ? QStringLiteral("window.MOTE_INLINE_PROTO=false;")
            : QStringLiteral("window.MOTE_INLINE_PROTO=true;");
        page.replace(QStringLiteral("__MOTE_JS__"), flag + QString::fromUtf8(js.readAll()));
        return page;
    }();
    return html;
}

} // namespace

MacWebView::MacWebView(QWidget *parent)
    : WebEditor(parent)
{
    setAttribute(Qt::WA_NativeWindow);
    setFocusPolicy(Qt::StrongFocus);
}

MacWebView::~MacWebView()
{
    if (!m_pageFile.isEmpty())
        QFile::remove(m_pageFile);
    if (m_keyMonitor) {
        [NSEvent removeMonitor:static_cast<id>(m_keyMonitor)];
        m_keyMonitor = nullptr;
    }
    if (m_webView) {
        WKWebView *view = static_cast<WKWebView *>(m_webView);
        [view.configuration.userContentController removeScriptMessageHandlerForName:@"mote"];
        [view removeFromSuperview];
        [view release];
        m_webView = nullptr;
    }
    if (m_handler) {
        [(MoteMessageHandler *)m_handler release];
        m_handler = nullptr;
    }
}

void MacWebView::ensureWebView()
{
    if (m_webView)
        return;

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    MoteMessageHandler *handler = [[MoteMessageHandler alloc] init];
    [handler setOwner:this];
    [config.userContentController addScriptMessageHandler:handler name:@"mote"];

    NSView *host = reinterpret_cast<NSView *>(winId());
    WKWebView *view = [[MoteWKWebView alloc] initWithFrame:host.bounds configuration:config];
    [view setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    static_cast<MoteWKWebView *>(view)->moteOwner = this;
    [host addSubview:view];

    m_webView = view;
    m_handler = handler;

    // Cmd+Z / Cmd+Shift+Z 走 AppKit 菜单的 key equivalent，先于页面 keydown；
    // 而 NSMenu 匹配字母快捷键时会忽略 Shift——实测 Cmd+Shift+Z 会命中“撤销”项。
    // 本地事件监视器比菜单更早拿到事件，在这里按精确修饰键分流，并直接驱动与
    // 菜单项相同的前端历史栈，确保快捷键和菜单点击走同一条路。
    if (!m_keyMonitor) {
        MacWebView *owner = this;
        id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                          handler:^NSEvent *(NSEvent *event) {
            if (!owner || !owner->isVisible())
                return event;
            const NSEventModifierFlags flags = event.modifierFlags;
            if ((flags & NSEventModifierFlagCommand) == 0
                || (flags & (NSEventModifierFlagControl | NSEventModifierFlagOption)))
                return event;
            WKWebView *web = static_cast<WKWebView *>(owner->m_webView);
            NSWindow *window = web ? [web window] : nil;
            if (!window || ![window isKeyWindow] || [NSApp modalWindow])
                return event;
            NSString *key = [event.charactersIgnoringModifiers lowercaseString];
            if ([key isEqualToString:@"z"]) {
                if (flags & NSEventModifierFlagShift)
                    owner->redo();
                else
                    owner->undo();
                return nil;
            }
            if ([key isEqualToString:@"y"]) {
                owner->redo();
                return nil;
            }
            return event;
        }];
        m_keyMonitor = monitor;
    }
}

void MacWebView::showEvent(QShowEvent *event)
{
    QWidget::showEvent(event);
    ensureWebView();
}

void MacWebView::resizeEvent(QResizeEvent *event)
{
    QWidget::resizeEvent(event);
    if (!m_webView)
        return;
    NSView *host = reinterpret_cast<NSView *>(winId());
    [static_cast<WKWebView *>(m_webView) setFrame:host.bounds];
}

void MacWebView::setMarkdown(const QString &text, const QUrl &baseDir)
{
    ensureWebView();

    if (!m_pageLoaded || baseDir != m_baseDir) {
        m_baseDir = baseDir;
        m_pendingText = text;
        m_hasPending = true;
        loadPage(baseDir);
        return;
    }

    m_pendingText = text;
    m_hasPending = true;
    if (m_pageReady)
        injectMarkdown(text);
}

void MacWebView::newDocument()
{
    // 未命名文档没有磁盘位置：清掉 baseDir，图片粘贴会走「请先保存」提示
    m_baseDir = QUrl();
    m_pendingText.clear();
    m_hasPending = false;
    evalScript(m_webView, QStringLiteral("window.mote && window.mote.newDocument();"));
}

void MacWebView::setBaseDir(const QUrl &dir)
{
    // 另存为后只改图片落盘位置，不重载页面（保住编辑状态与光标）
    m_baseDir = dir;
}

void MacWebView::loadPage(const QUrl &baseDir)
{
    m_pageLoaded = true;
    m_pageReady = false;
    const QString dir = baseDir.toLocalFile();
    if (dir.isEmpty()) {
        NSURL *base = [NSURL fileURLWithPath:dir.toNSString() isDirectory:YES];
        [static_cast<WKWebView *>(m_webView) loadHTMLString:pageHtml().toNSString() baseURL:base];
        return;
    }

    // loadHTMLString:baseURL: 的页面是「无来源」文档：即使 baseURL 指向文档目录，
    // WebKit 也拒绝读取任何 file:// 子资源（实测 img.naturalWidth=0、fetch 报
    // Load failed），图片因此永远显示不出来。改用 loadFileURL:allowingReadAccessToURL:
    // 才是官方支持的本地资源方案；主文档必须落在读权限目录内，因此临时 HTML
    // 写到文档目录下的隐藏文件（.mote-preview-<pid>.html），退出/换文档时删除。
    QString page = pageHtml();
    const QString baseUrl = QUrl::fromLocalFile(dir + QLatin1Char('/')).toString();
    page.replace(QStringLiteral("</head>"),
                 QStringLiteral("<base href=\"%1\"></head>").arg(baseUrl.toHtmlEscaped()));

    if (!m_pageFile.isEmpty() && m_pageFile != filePathOf(dir))
        QFile::remove(m_pageFile);
    const QString filePath = filePathOf(dir);
    QFile file(filePath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        NSURL *base = [NSURL fileURLWithPath:dir.toNSString() isDirectory:YES];
        [static_cast<WKWebView *>(m_webView) loadHTMLString:page.toNSString() baseURL:base];
        return;
    }
    file.write(page.toUtf8());
    file.close();
    m_pageFile = filePath;

    NSURL *pageUrl = [NSURL fileURLWithPath:filePath.toNSString() isDirectory:NO];
    NSURL *readAccess = [NSURL fileURLWithPath:dir.toNSString() isDirectory:YES];
    [static_cast<WKWebView *>(m_webView) loadFileURL:pageUrl allowingReadAccessToURL:readAccess];
}

void MacWebView::injectMarkdown(const QString &text)
{
    if (!m_webView)
        return;
    const QString js = QStringLiteral("window.mote && window.mote.setMarkdown(%1);").arg(quotedJson(text));
    [static_cast<WKWebView *>(m_webView) evaluateJavaScript:js.toNSString() completionHandler:nil];
    m_hasPending = false;
}

// 诊断用（MOTE_SNAPSHOT=/path.png）：页面就绪后延迟 2 秒把 WKWebView 的画面
// 直接渲染成 PNG。屏幕锁定时 screencapture 只能拿到锁屏，这条路不受影响。
static void snapshotWebView(WKWebView *web, WKSnapshotConfiguration *config, NSString *path)
{
    [web takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *error) {
        if (!image) {
            std::fprintf(stderr, "SNAPSHOT ERR %s\n",
                         error ? error.localizedDescription.UTF8String : "nil");
            return;
        }
        NSData *tiff = [image TIFFRepresentation];
        NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:tiff];
        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        const BOOL ok = [png writeToFile:path atomically:YES];
        std::fprintf(stderr, "SNAPSHOT %s %s\n", ok ? "OK" : "WRITE_FAIL", path.UTF8String);
    }];
}

void MacWebView::runEvalProbe()
{
    // 诊断用（MOTE_EVAL=任意 JS 表达式）：等文档注入完成后执行一次，把结果打到 stderr。
    // 只用于核对页面真实 DOM/状态，不参与产品逻辑。
    const QString expression = qEnvironmentVariable("MOTE_EVAL");
    if (expression.isEmpty() || !m_webView)
        return;
    const QString script = QStringLiteral(
        "(function(){try{var r=(%1);window.webkit.messageHandlers.mote.postMessage("
        "{type:'log',message:'EVAL '+String(r)});}catch(e){window.webkit.messageHandlers.mote."
        "postMessage({type:'log',message:'EVALERR '+e});}})();").arg(expression);
    WKWebView *web = static_cast<WKWebView *>(m_webView);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(1.2 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [web evaluateJavaScript:script.toNSString() completionHandler:nil];
    });
}

void MacWebView::requestSnapshot()
{
    if (!m_webView)
        return;
    [static_cast<WKWebView *>(m_webView) evaluateJavaScript:@"window.mote && window.mote.requestSnapshot();"
                                        completionHandler:nil];
}

void MacWebView::notifySaved(const QString &text)
{
    if (!m_webView)
        return;
    const QString js = QStringLiteral("window.mote && window.mote.markSaved(%1);").arg(quotedJson(text));
    [static_cast<WKWebView *>(m_webView) evaluateJavaScript:js.toNSString() completionHandler:nil];
}

void MacWebView::undo()
{
    if (!m_webView)
        return;
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS undo\n");
    [static_cast<WKWebView *>(m_webView) evaluateJavaScript:@"window.mote && window.mote.undo();"
                                        completionHandler:nil];
}

void MacWebView::redo()
{
    if (!m_webView)
        return;
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS redo\n");
    [static_cast<WKWebView *>(m_webView) evaluateJavaScript:@"window.mote && window.mote.redo();"
                                        completionHandler:nil];
}

void MacWebView::toggleToc()
{
    evalScript(m_webView, QStringLiteral("window.mote && window.mote.toggleToc();"));
}

void MacWebView::toggleSource()
{
    evalScript(m_webView, QStringLiteral("window.mote && window.mote.toggleSource();"));
}

void MacWebView::zoomBy(int steps)
{
    evalScript(m_webView, QStringLiteral("window.mote && window.mote.zoomBy(%1);").arg(steps));
}

void MacWebView::resetZoom()
{
    evalScript(m_webView, QStringLiteral("window.mote && window.mote.resetZoom();"));
}

void MacWebView::applyFormat(const QString &action)
{
    // 格式动作名由 JS 的 formatAction 统一解释，三个入口（菜单快捷键、斜杠、右键）共用
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE -> JS format %s\n", action.toUtf8().constData());
    evalScript(m_webView, QStringLiteral("window.mote && window.mote.format(%1);")
                              .arg(quotedJson(action)));
}

void MacWebView::insertImage(const QString &rel)
{
    const QString js = QStringLiteral("window.mote && window.mote.insertImage(%1);")
                           .arg(quotedJson(rel));
    evalScript(m_webView, js);
}

// 把图片字节写进「md 同目录/assets/」并让页面插入 ![](assets/xxx)。
// 文档还没保存（没有目录）时明确提示，不写入任何位置。
bool MacWebView::saveImageBytes(const QByteArray &bytes, const QString &mime,
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

bool MacWebView::saveImageFile(const QString &path)
{
    QFile in(path);
    if (!in.open(QIODevice::ReadOnly)) {
        emit statusMessage(tr("图片未插入：无法读取 %1").arg(QFileInfo(path).fileName()));
        return false;
    }
    return saveImageBytes(in.readAll(), QString(), QFileInfo(path).fileName(), false);
}

bool MacWebView::handleNativeFileDrop(const QStringList &paths)
{
    bool recognized = false;
    for (const QString &path : paths) {
        if (isMarkdownPath(path)) {
            recognized = true;
            emit fileDropRequested(QFileInfo(path).absoluteFilePath());
            return true;
        }
    }
    for (const QString &path : paths) {
        if (isImagePath(path)) {
            recognized = true;
            saveImageFile(path);
        }
    }
    return recognized;
}

void MacWebView::handleMessage(const QString &json)
{
    const QJsonDocument document = QJsonDocument::fromJson(json.toUtf8());
    if (!document.isObject())
        return;
    const QJsonObject message = document.object();
    const QString type = message.value(QStringLiteral("type")).toString();

    if (type == QLatin1String("ready")) {
        m_pageReady = true;
        emit ready();
        if (m_hasPending)
            injectMarkdown(m_pendingText);
        runEvalProbe();
        // 诊断用（MOTE_DROP=路径[:路径]）：把同样的原生拖放处理函数按时调用一次，
        // 便于在无法模拟 Finder 拖放的自动化环境里验证「打开 md / 图片落盘」。
        if (!m_dropProbeDone) {
            const QString probe = qEnvironmentVariable("MOTE_DROP");
            if (!probe.isEmpty()) {
                m_dropProbeDone = true;
                const QStringList paths = probe.split(QLatin1Char(':'), Qt::SkipEmptyParts);
                QTimer::singleShot(900, this, [this, paths] { handleNativeFileDrop(paths); });
            }
        }
        const QString snapPath = qEnvironmentVariable("MOTE_SNAPSHOT");
        if (!snapPath.isEmpty() && m_webView) {
            WKWebView *snapView = static_cast<WKWebView *>(m_webView);
            NSString *snapFile = [snapPath.toNSString() copy];
            const double snapDelay =
                qEnvironmentVariable("MOTE_SNAPSHOT_DELAY", QStringLiteral("2000")).toDouble() / 1000.0;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(snapDelay * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{
                WKSnapshotConfiguration *config = [[WKSnapshotConfiguration alloc] init];
                [config setSnapshotWidth:@(snapView.bounds.size.width * 2)];
                std::fprintf(stderr, "SNAPSHOT scheduled %s\n", snapFile.UTF8String);
                snapshotWebView(snapView, config, snapFile);
                [config release];
                [snapFile release];
            });
        }
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
    if (type == QLatin1String("status")) {
        emit statusMessage(message.value(QStringLiteral("message")).toString());
        return;
    }
    if (type == QLatin1String("error")) {
        emit errorOccurred(message.value(QStringLiteral("message")).toString());
        return;
    }
    if (type == QLatin1String("log")) {
        if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
            const QByteArray line = message.value(QStringLiteral("message")).toString().toUtf8();
            std::fprintf(stderr, "JSLOG %s\n", line.constData());
        }
    }
}

WebEditor *createWebEditor(QWidget *parent)
{
    return new MacWebView(parent);
}
