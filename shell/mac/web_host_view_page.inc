- (void)loadEditorPageInDirectory:(NSString *)directory
{
    // 临时页面必须用 loadFileURL 加载：loadHTMLString 的页面没有来源，
    // WebKit 会拒绝一切 file:// 子资源（图片永远显示不出来）。
    // 文档目录在 home 内（绝大多数场景）：页面固定写进 ~/Library/Caches/MoteNative，
    // 读权限一次性授权整个 home——之后根内换目录只需改 <base> 注入正文，
    // 不再重载页面（core 只在首载或越界目录时才走到这里）。
    // 越界目录（/Volumes、外置盘）：退回旧行为，页面写进该目录、只授该目录。
    NSString *home = NSHomeDirectory();
    BOOL inHome = directory.length == 0
        || [directory isEqualToString:home]
        || [directory hasPrefix:[home stringByAppendingString:@"/"]];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *pageDir;
    NSString *scopeDir;
    if (inHome) {
        pageDir = [home stringByAppendingPathComponent:@"Library/Caches/MoteNative"];
        [fm createDirectoryAtPath:pageDir withIntermediateDirectories:YES
                       attributes:nil error:NULL];
        scopeDir = home;
    } else {
        pageDir = directory;
        if (![fm isWritableFileAtPath:pageDir]) {
            pageDir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"MoteNative"];
            [fm createDirectoryAtPath:pageDir withIntermediateDirectories:YES
                           attributes:nil error:NULL];
        }
        scopeDir = pageDir;
    }
    NSString *path = [pageDir stringByAppendingPathComponent:
        [NSString stringWithFormat:@".mote-preview-%d.html", (int)getpid()]];

    // mermaid 库文件与临时页面放同一目录（该目录在 WebView 读取授权内），
    // 页面按需动态加载；缺文件时前端自然退回「mermaid 块显示源码」。
    NSString *mermaidName = [NSString stringWithFormat:@".mote-mermaid-%d.js", (int)getpid()];
    NSString *mermaidPath = [pageDir stringByAppendingPathComponent:mermaidName];
    NSURL *mermaidURL = [[NSBundle mainBundle] URLForResource:@"mermaid.min"
                                                 withExtension:@"js"
                                                  subdirectory:@"web"];
    if (mermaidURL) {
        unsigned long long want = [[fm attributesOfItemAtPath:mermaidURL.path error:NULL] fileSize];
        unsigned long long have = [[fm attributesOfItemAtPath:mermaidPath error:NULL] fileSize];
        if (want > 0 && have != want) {
            [fm removeItemAtPath:mermaidPath error:NULL];
            [fm copyItemAtPath:mermaidURL.path toPath:mermaidPath error:NULL];
        }
    }
    if (self.mermaidFile.length > 0 && ![self.mermaidFile isEqualToString:mermaidPath])
        [fm removeItemAtPath:self.mermaidFile error:NULL];
    self.mermaidFile = mermaidURL ? mermaidPath : nil;

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
    mote::perfMark("mac:page_written");
    self.pageFile = path;

    // 页面代次写进 fragment，消息桥据此丢弃上一个页面迟到的消息
    ++_pageGeneration;
    NSURLComponents *components =
        [NSURLComponents componentsWithURL:[NSURL fileURLWithPath:path]
                   resolvingAgainstBaseURL:NO];
    components.fragment = [NSString stringWithFormat:@"g%lu", (unsigned long)_pageGeneration];
    [self.webView loadFileURL:components.URL
      allowingReadAccessToURL:[NSURL fileURLWithPath:scopeDir isDirectory:YES]];
    mote::perfMark("mac:navigate");
}

