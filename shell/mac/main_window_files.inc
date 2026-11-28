- (void)exportPdf
{
    // 未命名文档没有目录：先另存为，保存完成后回到这里继续导出
    if (self.filePath.length == 0) {
        self.saveAsRequested = YES;
        self.afterSave = MoteAfterSaveExportPdf;
        _controller->requestSnapshot();
        return;
    }

    NSString *suggested = [self.filePath.stringByDeletingPathExtension
        stringByAppendingPathExtension:@"pdf"];
    const char *promptOnly = std::getenv("MOTE_PDF_PROMPT");
    if (promptOnly && *promptOnly) {
        std::fprintf(stderr, "PDF suggestion: %s\n", suggested.UTF8String);
        return;
    }
    const char *forced = std::getenv("MOTE_PDF_AS");
    NSString *path = forced && *forced
        ? [NSString stringWithUTF8String:forced]
        : MoteSavePanel(@"导出 PDF", suggested, @"pdf");
    if (path.length == 0)
        return;
    if (path.pathExtension.length == 0)
        path = [path stringByAppendingPathExtension:@"pdf"];

    [self showStatus:@"正在导出 PDF…"];
    _controller->requestExportPdf(path.UTF8String);
}

- (void)saveText:(const std::string &)text
{
    const BOOL wantsSaveAs = self.saveAsRequested;
    self.saveAsRequested = NO;

    NSString *content = [NSString stringWithUTF8String:text.c_str()] ?: @"";
    NSString *path = self.filePath;
    if (path.length == 0 || wantsSaveAs) {
        NSString *dir = self.lastDir.length > 0 ? self.lastDir : NSHomeDirectory();
        NSString *suggested = path.length > 0
            ? path
            : [dir stringByAppendingPathComponent:@"未命名.md"];
        // 自动化验证用：跳过保存面板
        const char *forced = std::getenv("MOTE_SAVE_AS");
        if (forced && *forced) {
            path = [NSString stringWithUTF8String:forced];
        } else {
            path = MoteSavePanel(@"另存为", suggested, @"md");
        }
        if (path.length == 0) {
            [self resetAfterSave];
            return;
        }
        if (path.pathExtension.length == 0)
            path = [path stringByAppendingPathExtension:@"md"];
    }

    if (![self writeText:content toPath:path]) {
        [self resetAfterSave];
        return;
    }

    self.filePath = path;
    self.lastDir = path.stringByDeletingLastPathComponent;
    self.lastText = content;
    _controller->notifySaved(text);
    // 另存为可能换了目录：图片落盘位置跟随新的 .md 路径
    _controller->setBaseDir(self.lastDir.UTF8String);
    [self updateWindowTitle];
    [[MoteRecentFiles shared] addPath:path];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE save %s bytes=%lu\n", path.UTF8String,
                     (unsigned long)[content lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
    [self showStatus:[NSString stringWithFormat:@"已保存：%@", path]];
    [self runAfterSave];
}

- (BOOL)writeText:(NSString *)text toPath:(NSString *)path
{
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    if (![data writeToFile:path options:NSDataWritingAtomic error:&error]) {
        MoteAlert(@"保存失败",
                  [NSString stringWithFormat:@"无法写入文件：\n%@\n%@", path,
                                             error.localizedDescription ?: @""]);
        return NO;
    }
    return YES;
}

- (BOOL)prepareForReplace:(MoteAfterSave)after path:(NSString *)path
{
    return [self prepareForReplace:after path:path text:nil];
}

- (BOOL)prepareForReplace:(MoteAfterSave)after path:(NSString *)path text:(NSString *)text
{
    if (!_controller->dirty())
        return YES;

    const MoteSaveChoice choice = MoteConfirmUnsaved([self displayName]);
    if (choice == MoteSaveChoiceCancel)
        return NO;
    if (choice == MoteSaveChoiceDiscard)
        return YES;

    self.afterSave = after;
    self.afterSavePath = path;
    self.afterSaveText = text;
    _controller->requestSnapshot();
    return NO;
}

- (void)runAfterSave
{
    const MoteAfterSave after = self.afterSave;
    NSString *path = self.afterSavePath;
    NSString *text = self.afterSaveText;
    [self resetAfterSave];

    switch (after) {
    case MoteAfterSaveOpenDialog:
        [self openDocument];
        break;
    case MoteAfterSaveOpenPath:
        if (path.length > 0)
            [self openPath:path];
        break;
    case MoteAfterSaveNewDocument:
        [self startNewDocument];
        break;
    case MoteAfterSaveClose:
        [self.window performClose:nil];
        break;
    case MoteAfterSaveTerminate:
        [NSApp terminate:nil];
        break;
    case MoteAfterSaveExportPdf:
        [self exportPdf];
        break;
    case MoteAfterSaveDropText:
        [self loadDroppedText:text.UTF8String ? std::string(text.UTF8String) : std::string()];
        break;
    case MoteAfterSaveNone:
        break;
    }
}

- (void)resetAfterSave
{
    self.afterSave = MoteAfterSaveNone;
    self.afterSavePath = nil;
    self.afterSaveText = nil;
}

