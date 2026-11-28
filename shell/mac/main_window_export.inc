- (void)htmlExportReady:(const std::string &)html
{
    NSString *content = [NSString stringWithUTF8String:html.c_str()] ?: @"";
    NSString *suggested = nil;
    if (self.filePath.length > 0) {
        suggested = [self.filePath.stringByDeletingPathExtension
            stringByAppendingPathExtension:@"html"];
    } else {
        NSString *dir = self.lastDir.length > 0 ? self.lastDir : NSHomeDirectory();
        suggested = [dir stringByAppendingPathComponent:@"未命名.html"];
    }

    const char *forced = std::getenv("MOTE_EXPORT_AS");
    NSString *path = forced && *forced
        ? [NSString stringWithUTF8String:forced]
        : MoteSavePanel(@"导出 HTML", suggested, @"html");
    if (path.length == 0)
        return;
    if (path.pathExtension.length == 0)
        path = [path stringByAppendingPathExtension:@"html"];

    int missing = 0;
    NSString *inlined = MoteInlineLocalImages(content, self.lastDir, &missing);
    NSData *data = [inlined dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    if (![data writeToFile:path options:NSDataWritingAtomic error:&error]) {
        MoteAlert(@"导出失败",
                  [NSString stringWithFormat:@"无法写入文件：\n%@\n%@", path,
                                             error.localizedDescription ?: @""]);
        return;
    }

    const double kb = static_cast<double>(data.length) / 1024.0;
    if (missing > 0) {
        [self showStatus:[NSString stringWithFormat:@"已导出 %@（%.0f KB），%d 张图片读取失败",
                                                   path, kb, missing]];
    } else {
        [self showStatus:[NSString stringWithFormat:@"已导出 %@（%.0f KB）", path, kb]];
    }
}

- (void)requestPdfExport:(const std::string &)path
{
    NSString *target = [NSString stringWithUTF8String:path.c_str()] ?: @"";
    __weak MoteMainWindow *weakSelf = self;
    [self.host exportPdfToPath:target
                    completion:^(BOOL ok, NSString *message) {
                      MoteMainWindow *window = weakSelf;
                      if (!window)
                          return;
                      if (ok) {
                          [window showStatus:
                              [NSString stringWithFormat:@"已导出到 %@", target]];
                          return;
                      }
                      NSString *reason = message.length > 0 ? message : @"导出失败";
                      [window showStatus:reason];
                      MoteAlert(@"导出失败", reason);
                    }];
}

- (void)pdfExportFailed:(const std::string &)message
{
    NSString *text = [NSString stringWithUTF8String:message.c_str()];
    [self showStatus:text ?: @"导出失败"];
}

