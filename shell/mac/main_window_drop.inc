#pragma mark - 拖放

- (void)setupDropHandlers
{
    __weak MoteMainWindow *weakSelf = self;
    self.host.canAcceptFileDrop = ^BOOL(NSArray<NSString *> *paths) {
        MoteMainWindow *window = weakSelf;
        return window && window->_controller->acceptsNativeFileDrop(MotePathsToVector(paths));
    };
    self.host.performFileDrop = ^BOOL(NSArray<NSString *> *paths) {
        MoteMainWindow *window = weakSelf;
        if (!window)
            return NO;
        const std::vector<std::string> list = MotePathsToVector(paths);
        const bool handled = window->_controller->handleNativeFileDrop(list);
        if (MoteKeyLogEnabled()) {
            for (const std::string &path : list)
                std::fprintf(stderr, "NATIVE drop %s -> %d\n", path.c_str(), handled ? 1 : 0);
        }
        return handled;
    };
}

// 诊断用（MOTE_DROP=路径[:路径]）：自动化环境无法模拟 Finder 拖放，
// 页面就绪后把同一套拖放处理按时调用一次。
- (void)runDropProbeIfNeeded
{
    // 进程级只跑一次：多窗口下每个新窗口的 ready 不能再触发，
    // 否则拖放打开新窗口会连环重复
    static BOOL done = NO;
    if (done)
        return;
    const char *probe = std::getenv("MOTE_DROP");
    if (!probe || !*probe)
        return;
    done = YES;

    NSString *text = [NSString stringWithUTF8String:probe];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSString *part in [text componentsSeparatedByString:@":"]) {
        if (part.length > 0)
            [paths addObject:part];
    }
    __weak MoteMainWindow *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.9 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                       [weakSelf performNativeDrop:paths];
                   });
}

- (BOOL)performNativeDrop:(NSArray<NSString *> *)paths
{
    return self.host.performFileDrop ? self.host.performFileDrop(paths) : NO;
}
