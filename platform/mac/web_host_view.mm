#import "web_host_view.h"
#import "pdf_export.h"

#import <WebKit/WebKit.h>

#include <cstdio>
#include <cstdlib>
#include <unistd.h>

@interface MoteWebHostView () <WKNavigationDelegate>
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic) NSUInteger pageGeneration;
@property(nonatomic, copy) NSString *pageFile;
@end

// 从拖放板取真实文件路径；Finder 给的是 file URL
static NSArray<NSString *> *MoteDraggedPaths(id<NSDraggingInfo> sender)
{
    NSArray<NSURL *> *urls = [sender.draggingPasteboard
        readObjectsForClasses:@[ NSURL.class ]
                     options:@{ NSPasteboardURLReadingFileURLsOnlyKey : @YES }];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSURL *url in urls) {
        if (url.isFileURL && url.path)
            [paths addObject:url.path];
    }
    return paths;
}

// WKWebView 自己实现了拖放目标；判定/处理交给宿主的 block，
// 不接管时退回系统默认行为（页面内拖选文字等）。
@interface MoteWKWebView : WKWebView
@property(nonatomic, weak) MoteWebHostView *host;
@end

@implementation MoteWKWebView

- (BOOL)acceptsPaths:(NSArray<NSString *> *)paths
{
    return paths.count > 0 && self.host.canAcceptFileDrop
        && self.host.canAcceptFileDrop(paths);
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender
{
    if ([self acceptsPaths:MoteDraggedPaths(sender)])
        return NSDragOperationCopy;
    return [super draggingEntered:sender];
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender
{
    if ([self acceptsPaths:MoteDraggedPaths(sender)])
        return NSDragOperationCopy;
    return [super draggingUpdated:sender];
}

- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender
{
    if ([self acceptsPaths:MoteDraggedPaths(sender)])
        return YES;
    return [super prepareForDragOperation:sender];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender
{
    NSArray<NSString *> *paths = MoteDraggedPaths(sender);
    if (paths.count > 0 && self.host.performFileDrop && self.host.performFileDrop(paths))
        return YES;
    return [super performDragOperation:sender];
}

@end

// 消息桥单独成对象：WKUserContentController 强引用 handler，
// 直接让宿主自己当 handler 会形成引用环。owner 保持弱引用。
@interface MoteScriptBridge : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) MoteWebHostView *host;
@end

@implementation MoteScriptBridge

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message
{
    (void)controller;
    MoteWebHostView *host = self.host;
    if (!host || ![message.body isKindOfClass:[NSDictionary class]])
        return;

    // 跨页竞态防线：页面 URL 的 fragment 记录加载时的代次，
    // 上一个页面迟到的消息代次对不上就丢弃。
    NSString *token = message.frameInfo.request.URL.fragment;
    if (token.length > 0) {
        NSString *expected = [NSString stringWithFormat:@"g%lu",
                              (unsigned long)host.pageGeneration];
        if (![token isEqualToString:expected])
            return;
    }
    if (host.messageHandler)
        host.messageHandler((NSDictionary *)message.body);
}

@end

static NSString *MoteReadBundleText(NSString *name, NSString *ext, NSString *subdir)
{
    NSURL *url = [[NSBundle mainBundle] URLForResource:name
                                         withExtension:ext
                                          subdirectory:subdir];
    if (!url)
        return nil;
    return [NSString stringWithContentsOfURL:url
                                    encoding:NSUTF8StringEncoding
                                       error:NULL];
}

// 与 Qt 构建同口径：MOTE_INLINE_PROTO=0/false/off/no 时关闭行内标记
static BOOL MoteInlineProtoEnabled(void)
{
    const char *raw = std::getenv("MOTE_INLINE_PROTO");
    if (!raw)
        return YES;
    NSString *value = [[[NSString stringWithUTF8String:raw]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        lowercaseString];
    return !([value isEqualToString:@"0"] || [value isEqualToString:@"false"]
             || [value isEqualToString:@"off"] || [value isEqualToString:@"no"]);
}

// 代码字体随包分发：以 base64 @font-face 内联，避免页面（文档目录为 baseURL）
// 用相对路径找不到 bundle 里的字体。
static NSString *MoteFontFaceCSS(void)
{
    static NSString *css;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSURL *url = [[NSBundle mainBundle] URLForResource:@"JetBrainsMono-Light"
                                             withExtension:@"ttf"
                                              subdirectory:@"fonts"];
        NSData *data = url ? [NSData dataWithContentsOfURL:url] : nil;
        if (data.length == 0) {
            css = @"";
            return;
        }
        css = [NSString stringWithFormat:
            @"@font-face{font-family:'JetBrains Mono';"
             "src:url(data:font/ttf;base64,%@) format('truetype');"
             "font-weight:300;font-style:normal;font-display:block;}",
            [data base64EncodedStringWithOptions:0]];
    });
    return css;
}

static NSString *MotePageHTML(void)
{
    static NSString *page;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *html = MoteReadBundleText(@"editor", @"html", @"web");
        NSString *css = MoteReadBundleText(@"editor", @"css", @"web");
        NSString *js = MoteReadBundleText(@"editor", @"js", @"web");
        if (html.length == 0 || css.length == 0 || js.length == 0) {
            page = @"<html><body>缺少前端资源</body></html>";
            return;
        }
        NSMutableString *built = [html mutableCopy];
        NSString *style = [MoteFontFaceCSS() stringByAppendingString:css];
        [built replaceOccurrencesOfString:@"__MOTE_CSS__"
                               withString:style
                                  options:0
                                    range:NSMakeRange(0, built.length)];
        NSString *flag = MoteInlineProtoEnabled()
            ? @"window.MOTE_INLINE_PROTO=true;"
            : @"window.MOTE_INLINE_PROTO=false;";
        [built replaceOccurrencesOfString:@"__MOTE_JS__"
                               withString:[flag stringByAppendingString:js]
                                  options:0
                                    range:NSMakeRange(0, built.length)];
        page = [built copy];
    });
    return page;
}

static NSString *MoteHtmlEscaped(NSString *text)
{
    NSMutableString *out = [text mutableCopy];
    [out replaceOccurrencesOfString:@"&" withString:@"&amp;" options:0
                              range:NSMakeRange(0, out.length)];
    [out replaceOccurrencesOfString:@"\"" withString:@"&quot;" options:0
                              range:NSMakeRange(0, out.length)];
    [out replaceOccurrencesOfString:@"<" withString:@"&lt;" options:0
                              range:NSMakeRange(0, out.length)];
    [out replaceOccurrencesOfString:@">" withString:@"&gt;" options:0
                              range:NSMakeRange(0, out.length)];
    return out;
}

@implementation MoteWebHostView

- (instancetype)initWithFrame:(NSRect)frameRect
{
    self = [super initWithFrame:frameRect];
    if (!self)
        return nil;

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    MoteScriptBridge *bridge = [[MoteScriptBridge alloc] init];
    bridge.host = self;
    [config.userContentController addScriptMessageHandler:bridge name:@"mote"];

    MoteWKWebView *webView = [[MoteWKWebView alloc] initWithFrame:self.bounds
                                                    configuration:config];
    webView.host = self;
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    webView.navigationDelegate = self;
    [webView registerForDraggedTypes:@[ NSPasteboardTypeFileURL ]];
    [self addSubview:webView];
    _webView = webView;
    return self;
}

- (void)loadEditorPageInDirectory:(NSString *)directory
{
    // 临时页面必须用 loadFileURL 加载：loadHTMLString 的页面没有来源，
    // WebKit 会拒绝一切 file:// 子资源（图片永远显示不出来）。
    // 主文档还必须落在读权限目录内，所以有文档目录时写进文档目录。
    NSString *dir = directory.length > 0 ? directory : @"";
    if (dir.length == 0 || ![[NSFileManager defaultManager] isWritableFileAtPath:dir]) {
        dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"MoteNative"];
        [[NSFileManager defaultManager] createDirectoryAtPath:dir
                                 withIntermediateDirectories:YES
                                                  attributes:nil
                                                       error:NULL];
    }
    NSString *path = [dir stringByAppendingPathComponent:
        [NSString stringWithFormat:@".mote-preview-%d.html", (int)getpid()]];

    NSMutableString *page = [MotePageHTML() mutableCopy];
    if (directory.length > 0) {
        NSString *base = [[NSURL fileURLWithPath:directory isDirectory:YES] absoluteString];
        if (![base hasSuffix:@"/"])
            base = [base stringByAppendingString:@"/"];
        // 只替换页面模板自己的 </head>（第一处），避免改到内嵌 JS 里的字面量
        NSRange head = [page rangeOfString:@"</head>"];
        if (head.location != NSNotFound) {
            NSString *tag = [NSString stringWithFormat:@"<base href=\"%@\"></head>",
                                                      MoteHtmlEscaped(base)];
            [page replaceCharactersInRange:head withString:tag];
        }
    }

    if (self.pageFile.length > 0 && ![self.pageFile isEqualToString:path])
        [[NSFileManager defaultManager] removeItemAtPath:self.pageFile error:NULL];
    if (![page writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL]) {
        NSLog(@"Mote: 无法写入临时页面 %@", path);
        return;
    }
    self.pageFile = path;

    // 页面代次写进 fragment，消息桥据此丢弃上一个页面迟到的消息
    ++_pageGeneration;
    NSURLComponents *components =
        [NSURLComponents componentsWithURL:[NSURL fileURLWithPath:path]
                   resolvingAgainstBaseURL:NO];
    components.fragment = [NSString stringWithFormat:@"g%lu", (unsigned long)_pageGeneration];
    [self.webView loadFileURL:components.URL
      allowingReadAccessToURL:[NSURL fileURLWithPath:dir isDirectory:YES]];
}

- (void)evaluateJavaScript:(NSString *)script
{
    [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (void)focusEditor
{
    [self.window makeFirstResponder:self.webView];
}

- (void)exportPdfToPath:(NSString *)path
             completion:(void (^)(BOOL, NSString *))completion
{
    const std::string target(path.UTF8String ?: "");
    MoteExportPdf(self.webView, target, [completion](bool ok, const std::string &message) {
        NSString *text = message.empty()
            ? nil
            : [NSString stringWithUTF8String:message.c_str()];
        if (completion)
            completion(ok, text);
    });
}

- (void)runPageDiagnostics
{
    // 诊断用（MOTE_EVAL=任意 JS 表达式）：等正文注入完成后执行一次，结果经页面
    // 消息桥回到 log 分支（配合 MOTE_KEYLOG=1 输出）。
    const char *expression = std::getenv("MOTE_EVAL");
    if (expression && *expression) {
        NSString *probe = [NSString stringWithFormat:
            @"(function(){try{var r=(%s);window.webkit.messageHandlers.mote.postMessage("
             "{type:'log',message:'EVAL '+String(r)});}catch(e){window.webkit.messageHandlers.mote."
             "postMessage({type:'log',message:'EVALERR '+e});}})();",
            expression];
        __weak MoteWebHostView *weakSelf = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
                           [weakSelf.webView evaluateJavaScript:probe completionHandler:nil];
                       });
    }

    // 诊断用（MOTE_SNAPSHOT=/path.png）：把 WKWebView 直接渲染成 PNG，
    // 不依赖 screencapture（屏幕锁定时也能拿到画面）。
    const char *snapshot = std::getenv("MOTE_SNAPSHOT");
    if (snapshot && *snapshot) {
        NSString *path = [NSString stringWithUTF8String:snapshot];
        const char *rawDelay = std::getenv("MOTE_SNAPSHOT_DELAY");
        const double delay = rawDelay && *rawDelay ? std::atof(rawDelay) / 1000.0 : 2.0;
        __weak MoteWebHostView *weakSelf = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
                           WKWebView *web = weakSelf.webView;
                           if (!web)
                               return;
                           WKSnapshotConfiguration *config = [[WKSnapshotConfiguration alloc] init];
                           config.snapshotWidth = @(web.bounds.size.width * 2);
                           [web takeSnapshotWithConfiguration:config
                                            completionHandler:^(NSImage *image, NSError *error) {
                               if (!image) {
                                   std::fprintf(stderr, "SNAPSHOT ERR %s\n",
                                                error.localizedDescription.UTF8String ?: "nil");
                                   return;
                               }
                               NSData *tiff = image.TIFFRepresentation;
                               NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:tiff];
                               NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG
                                                               properties:@{}];
                               const BOOL ok = [png writeToFile:path atomically:YES];
                               std::fprintf(stderr, "SNAPSHOT %s %s\n",
                                            ok ? "OK" : "WRITE_FAIL", path.UTF8String);
                           }];
                       });
    }
}

- (void)dealloc
{
    if (self.pageFile.length > 0)
        [[NSFileManager defaultManager] removeItemAtPath:self.pageFile error:NULL];
}

#pragma mark - WKNavigationDelegate

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler
{
    // 只放行本地临时页的首次加载；Cmd+Click 等外链由外壳另开浏览器
    NSURL *url = action.request.URL;
    if (!webView.URL) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (url && [[url absoluteString] isEqualToString:[webView.URL absoluteString]]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)action
                    windowFeatures:(WKWindowFeatures *)windowFeatures
{
    (void)webView;
    (void)configuration;
    (void)action;
    (void)windowFeatures;
    return nil;                // 不弹新窗口
}

@end
