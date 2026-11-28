#pragma mark - 页面消息与脚本

- (void)handlePageMessage:(NSDictionary *)body
{
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:&error];
    if (!data)
        return;
    const std::string json(static_cast<const char *>(data.bytes), data.length);
    _controller->handleMessage(json);
}

- (void)evaluateScript:(const std::string &)script
{
    NSString *text = [NSString stringWithUTF8String:script.c_str()];
    if (text)
        [self.host evaluateJavaScript:text];
}

- (void)loadPageInDirectory:(const std::string &)directory
{
    mote::perfMark("mac:loadpage_call");
    NSString *dir = directory.empty() ? @"" : [NSString stringWithUTF8String:directory.c_str()];
    [self.host loadEditorPageInDirectory:dir ?: @""];
}

- (void)pageBecameReady
{
    mote::perfMark("mac:page_ready_cb");
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE ready gen=%llu\n",
                     (unsigned long long)_controller->pageGeneration());
    // 状态栏移入页面：加上平台类后 #statusbar 才显示
    [self.host evaluateJavaScript:
        [NSString stringWithUTF8String:mote::js::enableStatusBar("mac").c_str()]];
    if (self.lastStatus.length > 0) {
        [self showStatus:self.lastStatus];
        self.window.subtitle = @"";
    }
    [self.host focusEditor];
    [self.host runPageDiagnostics];
    [self runDropProbeIfNeeded];
    [self runStartupCommandIfNeeded];
    // 诊断用（MOTE_OPEN2=路径）：首屏就绪后再打开第二个文件，模拟热打开，
    // 用于测跨目录重载 / 同目录纯注入的耗时。
    const char *open2 = std::getenv("MOTE_OPEN2");
    static BOOL open2Done = NO;
    if (open2 && *open2 && !open2Done) {
        open2Done = YES;
        NSString *target = [NSString stringWithUTF8String:open2];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.6 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            mote::perfReset();
            mote::perfMark("mac:hot_open_start");
            [self openPath:target];
        });
    }
    [self updateWindowTitle];
}

// 诊断用（MOTE_COMMAND=exportPdf 等）：无法用键盘自动化触发菜单时，
// 页面就绪后按命令表执行一次指定命令。
- (void)runStartupCommandIfNeeded
{
    static BOOL done = NO;
    if (done)
        return;
    const char *raw = std::getenv("MOTE_COMMAND");
    if (!raw || !*raw)
        return;
    done = YES;

    NSString *name = [[[NSString stringWithUTF8String:raw]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        lowercaseString];
    const std::pair<const char *, mote::CommandId> table[] = {
        { "new", mote::CommandId::New },
        { "newwindow", mote::CommandId::NewWindow },
        { "open", mote::CommandId::Open },
        { "save", mote::CommandId::Save },
        { "saveas", mote::CommandId::SaveAs },
        { "exporthtml", mote::CommandId::ExportHtml },
        { "exportpdf", mote::CommandId::ExportPdf },
        { "toggletoc", mote::CommandId::ToggleToc },
        { "togglesource", mote::CommandId::ToggleSource },
        { "toggledark", mote::CommandId::ToggleDark },
        { "followsystem", mote::CommandId::FollowSystem },
        { "zoomin", mote::CommandId::ZoomIn },
        { "zoomout", mote::CommandId::ZoomOut },
        { "zoomreset", mote::CommandId::ZoomReset },
    };
    mote::CommandId id = mote::CommandId::Separator;
    bool found = false;
    for (const auto &entry : table) {
        if ([name isEqualToString:[NSString stringWithUTF8String:entry.first]]) {
            id = entry.second;
            found = true;
            break;
        }
    }
    if (!found)
        return;

    __weak MoteMainWindow *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.7 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                       [weakSelf performCommand:id];
                   });
}

