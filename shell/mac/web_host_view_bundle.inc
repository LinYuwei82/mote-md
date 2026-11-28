
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

// MOTE_INLINE_PROTO=0/false/off/no 时关闭行内标记
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
        // mermaid 不再内联进页面（3.3MB，每次换页都要重新解析，是启动与
        // 打开文件的主要开销）；这里只留一个懒加载声明，页面首次出现
        // mermaid 块时再从同目录的 .mote-mermaid-<pid>.js 动态加载。
        NSString *mermaidStub = @"";
        if ([[NSBundle mainBundle] URLForResource:@"mermaid.min"
                                    withExtension:@"js"
                                     subdirectory:@"web"]) {
            mermaidStub = [NSString stringWithFormat:
                @"window.MOTE_MERMAID_SRC=\".mote-mermaid-%d.js\";", (int)getpid()];
        }
        NSMutableString *built = [html mutableCopy];
        NSString *style = [MoteFontFaceCSS() stringByAppendingString:css];
        [built replaceOccurrencesOfString:@"__MOTE_CSS__"
                               withString:style
                                  options:0
                                    range:NSMakeRange(0, built.length)];
        [built replaceOccurrencesOfString:@"__MOTE_MERMAID__"
                               withString:mermaidStub
                                  options:0
                                    range:NSMakeRange(0, built.length)];
        NSString *flag = MoteInlineProtoEnabled()
            ? @"window.MOTE_INLINE_PROTO=true;"
            : @"window.MOTE_INLINE_PROTO=false;";
        if (std::getenv("MOTE_PERF"))
            flag = [flag stringByAppendingString:@"window.MOTE_PERF=true;"];
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
