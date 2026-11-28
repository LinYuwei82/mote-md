- (instancetype)init
{
    return [self initWithPendingFile:nil];
}

- (instancetype)initWithPendingFile:(NSString *)pendingPath
{
    self = [super init];
    if (!self)
        return nil;

    _followSystem = YES;
    _darkMode = [self systemIsDark];
    _lastZoom = 1.0;

    NSRect frame = NSMakeRect(0, 0, 1180, 820);
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                             | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.title = @"Mote";
    // ARC + strong 属性管理生命周期：默认的 releasedWhenClosed=YES 会让 AppKit
    // 在关窗时多 release 一次，与属性释放叠加成双重释放（多窗口关窗崩溃）
    window.releasedWhenClosed = NO;
    window.minSize = NSMakeSize(760, 520);
    window.delegate = self;
    _window = window;

    MoteWebHostView *host = [[MoteWebHostView alloc] initWithFrame:frame];
    host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    __weak MoteMainWindow *weakSelf = self;
    host.messageHandler = ^(NSDictionary *body) {
        [weakSelf handlePageMessage:body];
    };
    window.contentView = host;
    _host = host;

    _shell = std::make_unique<ShellHost>(self);
    _controller = std::make_unique<mote::EditorController>(*_shell);
    // 换目录免重载：页面读作用域一次性授权 home（见 web_host_view.mm），
    // 根内打开不同目录的文档不再重走整页导航。清空即回退旧行为。
    _controller->setReadAccessRoot(NSHomeDirectory().UTF8String ?: "");
    [self setupDropHandlers];

    if (pendingPath.length > 0)
        [self openPath:pendingPath];
    else
        [self loadBuiltinSample];
    // 页面就绪前先记住主题，ready 后由 core 补发
    [self applyTheme];
    [window center];
    return self;
}

- (void)show
{
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

#pragma mark - 菜单（应用级共享，本窗口只同步状态与执行命令）

+ (void)setSharedCommandItems:(NSDictionary<NSNumber *, NSMenuItem *> *)items
{
    gCommandItems = items;
}

- (NSWindow *)nativeWindow
{
    return self.window;
}

- (void)performMenuCommandWithTag:(NSInteger)tag
{
    [self performCommand:static_cast<mote::CommandId>(tag)];
}

- (NSEvent *)interceptKeyDown:(NSEvent *)event
{
    // 弹窗（保存面板/警告框）期间把按键交回 AppKit
    if (NSApp.modalWindow || !self.window.isKeyWindow)
        return event;

    if (MoteKeyLogEnabled()) {
        std::fprintf(stderr, "NATIVE keydown chars=%s flags=%lu\n",
                     event.charactersIgnoringModifiers.UTF8String,
                     (unsigned long)event.modifierFlags);
    }

    for (const mote::MenuSpec &menu : mote::menus()) {
        for (const mote::CommandId id : menu.items) {
            const mote::CommandSpec *spec = mote::findCommand(id);
            if (!spec)
                continue;
            for (const std::string &shortcut : spec->shortcuts) {
                NSString *text = [NSString stringWithUTF8String:shortcut.c_str()];
                if (MoteEventMatchesShortcut(event, text)) {
                    if (MoteKeyLogEnabled())
                        std::fprintf(stderr, "NATIVE key matched %s\n", shortcut.c_str());
                    [self performCommand:id];
                    return nil;
                }
            }
        }
    }
    return event;
}

