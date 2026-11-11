#include "macwebview.h"

#include "webpage.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPointer>
#include <QResizeEvent>
#include <QShowEvent>
#include <QTimer>
#include <QUrl>

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <cstdio>
#include <QFileInfo>

namespace {

bool keyLogEnabled()
{
    return qEnvironmentVariableIsSet("MOTE_KEYLOG");
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
        QStringList paths;
        for (NSString *path in [self moteDraggedPaths:sender])
            paths << QString::fromNSString(path);
        // 「能否接受」由共享层判定，与 Windows 的 OLE 拖放口径一致
        if (moteOwner->acceptsNativeFileDrop(paths))
            return NSDragOperationCopy;
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
    (void)sender;
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE undo:\n");
    // Cmd+Z 已由本地事件监视器直接驱动前端历史栈。WKWebView 并未实现 undo:，
    // 原先的 [super undo:] 会在运行时抛 unrecognized selector，这里只吞掉事件。
}

- (void)redo:(id)sender
{
    (void)sender;
    if (keyLogEnabled())
        std::fprintf(stderr, "NATIVE redo:\n");
    // 同上：不再调用不存在的 [super redo:]
}

@end

// 导航兜底：只放行本地临时页的首次加载，其余导航一律取消，
// 保证 WebView 不会把编辑器页面替换成外部站点（Cmd+Click 由外壳另开浏览器）。
@interface MoteNavigationDelegate : NSObject <WKNavigationDelegate>
@end

@implementation MoteNavigationDelegate

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler
{
    NSURL *url = action.request.URL;
    NSURL *current = webView.URL;
    if (!current) {            // 首次 loadFileURL
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (url && [[url absoluteString] isEqualToString:[current absoluteString]]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (keyLogEnabled()) {
        std::fprintf(stderr, "NATIVE nav blocked %s\n",
                     url ? [[url absoluteString] UTF8String] : "(nil)");
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)action
                    windowFeatures:(WKWindowFeatures *)windowFeatures
{
    return nil;                // 不弹新窗口
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

    // 跨页竞态防线：页面 URL 的 fragment 记录加载时的代次（见 loadPage）。
    // 上一个页面迟到的消息（典型是 ready）代次对不上就丢弃，否则它会把新文档的
    // pending 注入到已卸载的旧页，并清掉 m_hasPending，导致新页空白。
    NSString *token = message.frameInfo.request.URL.fragment;
    if (token.length > 0) {
        NSString *expected = [NSString stringWithFormat:@"g%llu",
                              static_cast<unsigned long long>(_owner->pageGeneration())];
        if (![token isEqualToString:expected]) {
            if (keyLogEnabled())
                std::fprintf(stderr, "NATIVE drop stale msg token=%s current=%s\n",
                             token.UTF8String, expected.UTF8String);
            return;
        }
    }

    NSData *data = [NSJSONSerialization dataWithJSONObject:message.body options:0 error:nil];
    if (!data)
        return;
    NSString *json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    _owner->handleMessage(QString::fromNSString(json));
}

@end

namespace {

void evalScript(void *webView, const QString &js)
{
    if (!webView)
        return;
    [static_cast<WKWebView *>(webView) evaluateJavaScript:js.toNSString() completionHandler:nil];
}

// 临时页面文件名：必须与文档同目录（loadFileURL 要求主文档在授权目录内）
QString filePathOf(const QString &dir)
{
    return QDir(dir).filePath(
        QStringLiteral(".mote-preview-%1.html").arg(QCoreApplication::applicationPid()));
}

} // namespace

MacWebView::MacWebView(QWidget *parent)
    : WebViewBase(parent)
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
    if (m_navDelegate) {
        [(MoteNavigationDelegate *)m_navDelegate release];
        m_navDelegate = nullptr;
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
    // WKWebView 自己持有配置的副本（configuration 属性是 copy），这里释放本地引用
    [config release];
    [view setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    static_cast<MoteWKWebView *>(view)->moteOwner = this;
    // 兜底：无论页面里的 preventDefault 是否生效，WebView 自身都不允许离开当前文档。
    // 只放行本地文件加载（初始 loadFileURL），其余导航一律取消。
    MoteNavigationDelegate *nav = [[MoteNavigationDelegate alloc] init];
    [view setNavigationDelegate:nav];
    [host addSubview:view];

    m_webView = view;
    m_handler = handler;
    m_navDelegate = nav;

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

void MacWebView::clipboardCommand(const QString &command)
{
    if (!m_webView)
        return;
    SEL action = nullptr;
    if (command == QLatin1String("cut"))
        action = @selector(cut:);
    else if (command == QLatin1String("copy"))
        action = @selector(copy:);
    else if (command == QLatin1String("paste"))
        action = @selector(paste:);
    if (!action)
        return;
    if (![static_cast<WKWebView *>(m_webView) window])
        return;
    // 标准编辑动作只存在于 AppKit 的响应链里（cut:/copy:/paste: 由 WebKit 的输入
    // 视图实现）：交给第一响应者自己执行，剪贴板读写、选区删除与页面 copy/cut/paste
    // 事件全部按系统默认路径走，页面的纯文本清理逻辑照常生效。
    // 早先菜单里没有这三项，AppKit 就没有对应的 key equivalent，WKWebView 收不到
    // 命令，Cmd+C/X/V 因此完全无反应。
    [NSApp sendAction:action to:nil from:nil];
}

// 导出 PDF：走 WKWebView 的打印操作（与 createPDFWithConfiguration 同一套渲染，
// 导出 PDF：WKWebView 的打印操作在本项目的页面结构上会无限分页（根节点
// min-height:100% 在分页上下文里被当成“每页满高”，实测会把磁盘写满），因此改为：
// 1) 用 createPDFWithConfiguration 把整篇正文抓成一张高图 PDF（同一套 WebKit 渲染，
//    中文、图片、代码高亮与等宽字体全保留）；
// 2) 再按 A4 内容区把这张高页切成多页矢量 PDF（CoreGraphics 绘制，文字仍是文字）。
// 页面侧只用 @media print 隐藏外壳，不改 DOM，导出前后文档、撤销栈、脏标记都不动。
namespace {

// 把 createPDF 得到的一整页高图切成 A4 多页；失败返回 nil。
NSData *moteSlicePdfToA4(NSData *source)
{
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((CFDataRef)source);
    CGPDFDocumentRef sourceDoc = CGPDFDocumentCreateWithProvider(provider);
    CGDataProviderRelease(provider);
    if (!sourceDoc || CGPDFDocumentGetNumberOfPages(sourceDoc) < 1) {
        if (sourceDoc)
            CGPDFDocumentRelease(sourceDoc);
        return nil;
    }

    CGPDFPageRef sourcePage = CGPDFDocumentGetPage(sourceDoc, 1);
    const CGRect box = CGPDFPageGetBoxRect(sourcePage, kCGPDFMediaBox);
    // A4 纵向与 18/20 mm 边距（与 Windows 侧 PrintToPdf 的设置一致）
    const CGFloat pageW = 595.28;
    const CGFloat pageH = 841.89;
    const CGFloat marginLeft = 51.0;
    const CGFloat marginRight = 51.0;
    const CGFloat marginTop = 56.7;
    const CGFloat marginBottom = 56.7;
    const CGFloat contentW = pageW - marginLeft - marginRight;
    const CGFloat contentH = pageH - marginTop - marginBottom;
    if (box.size.width <= 0 || box.size.height <= 0) {
        CGPDFDocumentRelease(sourceDoc);
        return nil;
    }

    const CGFloat scale = contentW / box.size.width;
    const CGFloat sliceHeight = contentH / scale; // 每页覆盖多少源高度
    const int pageCount = static_cast<int>(ceil(box.size.height / sliceHeight));
    // 上限兜底：真实文档不会超过 200 页，超出说明量到的尺寸异常，宁可失败也不写巨型文件
    if (pageCount <= 0 || pageCount > 200) {
        CGPDFDocumentRelease(sourceDoc);
        return nil;
    }

    NSMutableData *output = [NSMutableData data];
    CGDataConsumerRef consumer = CGDataConsumerCreateWithCFData((CFMutableDataRef)output);
    CGRect mediaBox = CGRectMake(0, 0, pageW, pageH);
    CGContextRef ctx = CGPDFContextCreate(consumer, &mediaBox, NULL);
    CGDataConsumerRelease(consumer);
    if (!ctx) {
        CGPDFDocumentRelease(sourceDoc);
        return nil;
    }

    for (int i = 0; i < pageCount; i++) {
        const CGFloat top = i * sliceHeight;
        const CGFloat bottom = MIN(box.size.height, top + sliceHeight);
        const CGFloat visibleH = bottom - top;
        const CGFloat outputH = visibleH * scale;
        CGPDFContextBeginPage(ctx, NULL);
        CGContextSaveGState(ctx);
        // 源页原点在左下：把当前切片对齐到 A4 内容区的底部（首页贴顶）
        CGContextTranslateCTM(ctx, marginLeft, marginBottom + contentH - outputH);
        CGContextScaleCTM(ctx, scale, scale);
        CGContextTranslateCTM(ctx, 0, -(box.size.height - bottom));
        CGContextClipToRect(ctx, CGRectMake(0, box.size.height - bottom, box.size.width, visibleH));
        CGContextDrawPDFPage(ctx, sourcePage);
        CGContextRestoreGState(ctx);
        CGPDFContextEndPage(ctx);
    }
    CGPDFContextClose(ctx);
    CGContextRelease(ctx);
    CGPDFDocumentRelease(sourceDoc);
    return output;
}

} // namespace

void MacWebView::exportPdfNative(const QString &filePath)
{
    WKWebView *web = static_cast<WKWebView *>(m_webView);
    if (!web) {
        emit pdfExportFailed(tr("导出失败：页面还没准备好"));
        return;
    }

    const QString path = filePath;
    // 同名旧文件不能算本次成功：先删掉，成功与否由产物是否存在、是否非空判定
    QFile::remove(path);

    // 先进入导出态（隐藏外壳）并量整篇正文尺寸（CSS px）；pdfBegin 只加 body 的
    // class，导出结束（含失败）立刻 pdfEnd 还原，不改正文节点。
    NSString *measure = @"window.mote && window.mote.pdfBegin()";
    QPointer<MacWebView> guard(this);
    [web evaluateJavaScript:measure
          completionHandler:^(id result, NSError *error) {
            MacWebView *owner = guard.data();
            if (!owner)
                return;
            const QString json = result ? QString::fromNSString([result description]) : QString();
            const QJsonObject dims = QJsonDocument::fromJson(json.toUtf8()).object();
            const double width = dims.value(QStringLiteral("w")).toDouble();
            const double height = dims.value(QStringLiteral("h")).toDouble();
            if (width < 10 || height < 10) {
                Q_UNUSED(error)
                [web evaluateJavaScript:@"window.mote && window.mote.pdfEnd()"
                      completionHandler:nil];
                emit owner->pdfExportFailed(tr("导出失败：没有可导出的正文"));
                return;
            }

            WKPDFConfiguration *configuration = [[WKPDFConfiguration alloc] init];
            configuration.rect = CGRectMake(0, 0, width, height);
            [web createPDFWithConfiguration:configuration
                          completionHandler:^(NSData *data, NSError *pdfError) {
                            [configuration release];
                            MacWebView *inner = guard.data();
                            if (!inner)
                                return;
                            // 无论成败都先还原页面显示，别让导出态留在界面上
                            [web evaluateJavaScript:@"window.mote && window.mote.pdfEnd()"
                                  completionHandler:nil];
                            NSData *sliced = data ? moteSlicePdfToA4(data) : nil;
                            const BOOL written = sliced
                                && [sliced writeToFile:path.toNSString() atomically:YES];
                            const QFileInfo pdf(path);
                            if (!written || !pdf.exists() || pdf.size() <= 0) {
                                Q_UNUSED(pdfError)
                                QFile::remove(path);
                                emit inner->pdfExportFailed(
                                    tr("导出失败：无法写入 %1")
                                        .arg(QDir::toNativeSeparators(path)));
                                return;
                            }
                            emit inner->pdfExportFinished(path);
                          }];
          }];
}

void MacWebView::ensureHost()
{
    ensureWebView();
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

void MacWebView::loadPage(const QUrl &baseDir)
{
    const QString dir = baseDir.toLocalFile();
    if (dir.isEmpty()) {
        NSURL *base = [NSURL fileURLWithPath:dir.toNSString() isDirectory:YES];
        [static_cast<WKWebView *>(m_webView) loadHTMLString:motePageHtml().toNSString() baseURL:base];
        return;
    }

    // loadHTMLString:baseURL: 的页面是「无来源」文档：即使 baseURL 指向文档目录，
    // WebKit 也拒绝读取任何 file:// 子资源（实测 img.naturalWidth=0、fetch 报
    // Load failed），图片因此永远显示不出来。改用 loadFileURL:allowingReadAccessToURL:
    // 才是官方支持的本地资源方案；主文档必须落在读权限目录内，因此临时 HTML
    // 写到文档目录下的隐藏文件（.mote-preview-<pid>.html），退出/换文档时删除。
    QString page = motePageHtml();
    const QString baseUrl = QUrl::fromLocalFile(dir + QLatin1Char('/')).toString();
    // 只替换页面模板自己的 </head>（第一处）。整串 replaceAll 会连内嵌 JS 源码里
    // 的 '</head>' 字面量一起改掉——导出 HTML 就是这样凭空多出一个 file:// 的 <base>。
    const int headEnd = page.indexOf(QStringLiteral("</head>"));
    if (headEnd >= 0) {
        page.replace(headEnd, 7,
                     QStringLiteral("<base href=\"%1\"></head>").arg(baseUrl.toHtmlEscaped()));
    }

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
    // 把页面代次写进 URL fragment：消息桥据此丢弃上一个页面迟到的消息。
    // loadFileURL 读的是文件本身，fragment 不参与路径解析。
    NSURLComponents *components = [NSURLComponents componentsWithURL:pageUrl
                                             resolvingAgainstBaseURL:NO];
    if (components) {
        components.fragment = [NSString stringWithFormat:@"g%llu",
                               static_cast<unsigned long long>(pageGeneration())];
        pageUrl = components.URL;
    }
    NSURL *readAccess = [NSURL fileURLWithPath:dir.toNSString() isDirectory:YES];
    [static_cast<WKWebView *>(m_webView) loadFileURL:pageUrl allowingReadAccessToURL:readAccess];
}

void MacWebView::evaluateJs(const QString &js)
{
    evalScript(m_webView, js);
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

void MacWebView::pageReady()
{
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
}

WebEditor *createWebEditor(QWidget *parent)
{
    return new MacWebView(parent);
}
