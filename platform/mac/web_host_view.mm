#import "web_host_view.h"

#import <WebKit/WebKit.h>

#include <cstdlib>

@interface MoteWebHostView () <WKNavigationDelegate>
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic) NSUInteger pageGeneration;
- (void)handleScriptMessage:(WKScriptMessage *)message;
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
    [self.host handleScriptMessage:message];
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

// 把任意文本变成 JS 字面量（借用 JSON 编码，再剥掉数组方括号）
static NSString *MoteJsonLiteral(NSString *text)
{
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[text ?: @""]
                                                   options:0
                                                     error:NULL];
    if (!data)
        return @"\"\"";
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (json.length < 2)
        return @"\"\"";
    return [json substringWithRange:NSMakeRange(1, json.length - 2)];
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

    WKWebView *webView = [[WKWebView alloc] initWithFrame:self.bounds configuration:config];
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    webView.navigationDelegate = self;
    [self addSubview:webView];
    _webView = webView;
    return self;
}

- (void)loadEditorPage
{
    // 临时页面必须用 loadFileURL 加载：loadHTMLString 的页面没有来源，
    // WebKit 会拒绝一切 file:// 子资源（图片永远显示不出来）。
    // 文档目录接入后（M3）临时页改写到文档同目录，这里先落在临时目录。
    NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"MoteNative"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir
                             withIntermediateDirectories:YES
                                              attributes:nil
                                                   error:NULL];
    NSString *path = [dir stringByAppendingPathComponent:@"preview.html"];
    if (![MotePageHTML() writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL]) {
        NSLog(@"Mote: 无法写入临时页面 %@", path);
        return;
    }

    // 页面代次写进 fragment，消息桥据此丢弃上一个页面迟到的消息
    ++_pageGeneration;
    NSURLComponents *components =
        [NSURLComponents componentsWithURL:[NSURL fileURLWithPath:path]
                   resolvingAgainstBaseURL:NO];
    components.fragment = [NSString stringWithFormat:@"g%lu", (unsigned long)_pageGeneration];
    [self.webView loadFileURL:components.URL
      allowingReadAccessToURL:[NSURL fileURLWithPath:dir isDirectory:YES]];
}

- (void)setMarkdown:(NSString *)text
{
    NSString *js = [NSString stringWithFormat:@"window.mote && window.mote.setMarkdown(%@);",
                                             MoteJsonLiteral(text)];
    [self.webView evaluateJavaScript:js completionHandler:nil];
}

- (void)handleScriptMessage:(WKScriptMessage *)message
{
    if (![message.body isKindOfClass:[NSDictionary class]])
        return;

    NSString *token = message.frameInfo.request.URL.fragment;
    if (token.length > 0) {
        NSString *expected = [NSString stringWithFormat:@"g%lu", (unsigned long)_pageGeneration];
        if (![token isEqualToString:expected])
            return;
    }

    NSDictionary *body = (NSDictionary *)message.body;
    NSString *type = body[@"type"];
    if ([type isKindOfClass:[NSString class]] && [type isEqualToString:@"ready"])
        [self.delegate webHostDidBecomeReady:self];
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
