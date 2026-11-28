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

