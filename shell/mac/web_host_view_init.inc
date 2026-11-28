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

