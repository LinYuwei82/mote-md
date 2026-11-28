#pragma mark - 文档

- (void)loadBuiltinSample
{
    NSURL *url = [[NSBundle mainBundle] URLForResource:@"welcome"
                                         withExtension:@"md"
                                          subdirectory:@"samples"];
    NSString *text = url
        ? [NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:NULL]
        : nil;
    self.lastText = text ?: @"# 欢迎\n\n没有找到内置示例文档。\n";
    self.filePath = nil;
    _controller->setMarkdown(self.lastText.UTF8String, "");
    [self updateWindowTitle];
}

- (NSString *)displayName
{
    return self.filePath.length > 0 ? self.filePath.lastPathComponent : @"未命名";
}

- (void)updateWindowTitle
{
    self.window.title = [NSString stringWithFormat:@"%@ - Mote", [self displayName]];
    self.window.documentEdited = _controller && _controller->dirty();
    if (self.filePath.length > 0)
        [self.window setRepresentedFilename:self.filePath];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE title=%s dirty=%d\n", self.window.title.UTF8String,
                     _controller && _controller->dirty() ? 1 : 0);
}

- (void)newDocument
{
    if (![self prepareForReplace:MoteAfterSaveNewDocument path:nil])
        return;
    [self startNewDocument];
}

- (void)startNewDocument
{
    self.filePath = nil;
    self.lastText = @"";
    self.saveAsRequested = NO;
    _controller->newDocument();
    [self updateWindowTitle];
    [self showStatus:@"已新建空白文档（未命名，保存时会询问位置）"];
}

- (void)openDocument
{
    if (![self prepareForReplace:MoteAfterSaveOpenDialog path:nil])
        return;
    NSString *dir = self.lastDir.length > 0 ? self.lastDir : NSHomeDirectory();
    NSString *path = MoteOpenMarkdownPanel(dir);
    if (path.length == 0)
        return;
    [self openPath:path];
}

- (void)openPath:(NSString *)path
{
    NSError *error = nil;
    NSString *text = [NSString stringWithContentsOfFile:path
                                               encoding:NSUTF8StringEncoding
                                                  error:&error];
    if (!text) {
        MoteAlert(@"无法打开",
                  [NSString stringWithFormat:@"读取文件失败：\n%@\n%@", path,
                                             error.localizedDescription ?: @""]);
        return;
    }
    if ([text hasPrefix:@"\uFEFF"])
        text = [text substringFromIndex:1];
    mote::perfMark("mac:file_read_done");

    self.filePath = path;
    self.lastDir = path.stringByDeletingLastPathComponent;
    self.lastText = text;
    _controller->setMarkdown(text.UTF8String, self.lastDir.UTF8String);
    [self updateWindowTitle];
    [[MoteRecentFiles shared] addPath:path];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE open %s\n", path.UTF8String);
    [self showStatus:[NSString stringWithFormat:@"已打开：%@", path]];
}

- (BOOL)isShowingPath:(NSString *)path
{
    if (self.filePath.length == 0 || path.length == 0)
        return NO;
    return [[self normalizedPathForCompare:self.filePath]
        isEqualToString:[self normalizedPathForCompare:path]];
}

// 比较用规范化：'\' 统一为 '/'，大小写不敏感（APFS 默认大小写不敏感）
- (NSString *)normalizedPathForCompare:(NSString *)path
{
    NSString *slashes = [path stringByReplacingOccurrencesOfString:@"\\" withString:@"/"];
    return slashes.lowercaseString;
}

- (void)openPathFromDrop:(const std::string &)path
{
    NSString *target = [NSString stringWithUTF8String:path.c_str()];
    if (target.length == 0)
        return;
    // 拖放等同 Finder 双击：新窗口打开，不替换当前文档
    [(id<MoteAppRouting>)NSApp.delegate openRequestedPath:target];
}

- (void)acceptDroppedName:(const std::string &)name text:(const std::string &)text
{
    (void)name;
    // 拖入等同「打开另一份文档」：有未保存修改时先问，不能在用户不知情时覆盖。
    NSString *dropped = [NSString stringWithUTF8String:text.c_str()] ?: @"";
    if (![self prepareForReplace:MoteAfterSaveDropText path:nil text:dropped])
        return;
    [self loadDroppedText:text];
}

- (void)loadDroppedText:(const std::string &)text
{
    // WebKit 出于安全不暴露拖入文件的真实路径，只能作为「未命名」文档载入
    self.filePath = nil;
    NSString *content = [NSString stringWithUTF8String:text.c_str()] ?: @"";
    self.lastText = content;
    _controller->setMarkdown(text, "");
    [self updateWindowTitle];
    [self showStatus:@"已载入拖入的文档（未关联磁盘路径，保存时会询问位置）"];
}

- (void)beginSaveAs:(BOOL)saveAs
{
    self.saveAsRequested = saveAs;
    _controller->requestSnapshot();
}

