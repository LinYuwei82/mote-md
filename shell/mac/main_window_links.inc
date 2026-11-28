
- (void)showStatus:(NSString *)text
{
    if (text.length == 0)
        return;
    self.lastStatus = text;
    if (_controller && _controller->pageReady()) {
        self.window.subtitle = @"";
        NSString *script =
            [NSString stringWithUTF8String:mote::js::statusMessage(text.UTF8String).c_str()];
        [self.host evaluateJavaScript:script];
        return;
    }
    // 页面未就绪：先用窗口副标题兜底，ready 后再推进页面状态栏
    self.window.subtitle = text;
}

- (void)openExternalUrl:(const std::string &)rawUrl
{
    NSString *href = [[NSString stringWithUTF8String:rawUrl.c_str()]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (href.length == 0)
        return;
    if ([href hasPrefix:@"#"]) {
        [self showStatus:[NSString stringWithFormat:@"锚点链接 %@ 暂不支持（还没有标题锚点）", href]];
        return;
    }

    NSURL *url = [NSURL URLWithString:href];
    NSString *scheme = url.scheme.lowercaseString;
    if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]
        || [scheme isEqualToString:@"mailto"]) {
        if (![[NSWorkspace sharedWorkspace] openURL:url])
            [self showStatus:[NSString stringWithFormat:@"无法打开链接：%@", href]];
        return;
    }

    NSString *target = nil;
    if ([scheme isEqualToString:@"file"]) {
        target = url.path;
    } else if (scheme.length == 0) {
        NSString *decoded = href.stringByRemovingPercentEncoding ?: href;
        // 绝对路径（/Users/x.md）不能拼到 lastDir 后面，否则会变成 <lastDir>/Users/x.md
        if ([decoded hasPrefix:@"/"]) {
            target = decoded;
        } else {
            target = [self.lastDir stringByAppendingPathComponent:decoded];
        }
    } else {
        [self showStatus:[NSString stringWithFormat:@"不支持打开的链接类型：%@", href]];
        return;
    }

    if (target.length == 0 || ![[NSFileManager defaultManager] fileExistsAtPath:target]) {
        MoteAlert(@"链接目标不存在",
                  [NSString stringWithFormat:@"找不到链接指向的文件：\n%@", href]);
        return;
    }
    if (mote::isMarkdownPath(target.UTF8String)) {
        if ([self prepareForReplace:MoteAfterSaveOpenPath path:target])
            [self openPath:target];
        return;
    }
    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:target]];
}

