#import <Cocoa/Cocoa.h>

#import "main_window.h"
#import "menus.h"
#import "updater.h"
#import "about_window.h"

#include "core/command_table.h"
#include "core/perf.h"

#include <cstdlib>
#include <limits.h>

// 打开请求统一走真实路径：Finder/open 投递的 /private/tmp 与命令行手写的
// /tmp 是同一文件，不规范化会重复开窗口、最近列表出现两条。
static NSString *MoteCanonicalPath(NSString *path)
{
    if (path.length == 0)
        return path;
    char resolved[PATH_MAX];
    if (realpath(path.UTF8String, resolved)) {
        NSString *value = [NSString stringWithUTF8String:resolved];
        if (value)
            return value;
    }
    return path;
}

// 多窗口：AppDelegate 持有窗口注册表，菜单与键盘监视器都在应用级，
// 命令按 keyWindow 路由到对应 MoteMainWindow 实例。
@interface MoteAppDelegate : NSObject <NSApplicationDelegate, NSMenuDelegate>
@property(nonatomic, strong) NSMutableArray<MoteMainWindow *> *moteWindows;
@property(nonatomic, copy) NSArray<NSString *> *pendingPaths;
@property(nonatomic) BOOL launched;
@property(nonatomic, strong) id keyMonitor;
@end

@implementation MoteAppDelegate

- (instancetype)init
{
    self = [super init];
    if (self) {
        _moteWindows = [NSMutableArray array];
        _pendingPaths = @[];
        [NSNotificationCenter.defaultCenter addObserver:self
                                               selector:@selector(moteWindowWillClose:)
                                                   name:MoteWindowWillCloseNotification
                                                 object:nil];
    }
    return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    (void)notification;
    mote::perfMark("mac:did_finish_launch");

    // 菜单与键盘监视器应用级装一次（多窗口共享，命令路由 keyWindow）
    [self installMenu];
    [self installKeyMonitor];
    self.launched = YES;

    // 第一个命令行参数当作待打开文件：直接交给 init，避免先加载示例页
    // 再换目录重载（两次完整页面解析）
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    NSString *pendingPath = arguments.count > 1 ? MoteCanonicalPath(arguments[1]) : nil;

    [self openNewWindowWithPath:pendingPath];
    mote::perfMark("mac:window_shown");
    // delegate 设好之前收到的 openFile 会攒在 pendingPaths，这里补发
    for (NSString *path in self.pendingPaths)
        [self openRequestedPath:path];
    self.pendingPaths = @[];

    // 在线更新：自研检查（OSS 上的 manifest.json）负责「有没有新版本」，
    // 用户确认后由 Sparkle 完成下载、验签与替换。启动后延迟一次 + 每 24 小时一次。
    [[MoteUpdater sharedUpdater] start];
}

#pragma mark - 窗口注册表

- (MoteMainWindow *)openNewWindowWithPath:(NSString *)path
{
    MoteMainWindow *window = [[MoteMainWindow alloc] initWithPendingFile:path];
    [self.moteWindows addObject:window];
    [window show];
    return window;
}

- (void)openNewWindow
{
    [self openNewWindowWithPath:nil];
}

// 外部打开请求统一口径：该路径已在某窗口打开则激活它，否则新窗口
- (void)openRequestedPath:(NSString *)path
{
    path = MoteCanonicalPath(path);
    if (path.length == 0)
        return;
    for (MoteMainWindow *window in self.moteWindows) {
        if ([window isShowingPath:path]) {
            [window show];
            return;
        }
    }
    [self openNewWindowWithPath:path];
}

- (MoteMainWindow *)keyMoteWindow
{
    NSWindow *keyWindow = NSApp.keyWindow;
    for (MoteMainWindow *window in self.moteWindows) {
        if (window.nativeWindow == keyWindow)
            return window;
    }
    return nil;
}

- (void)moteWindowWillClose:(NSNotification *)notification
{
    [self.moteWindows removeObject:notification.object];
}

#pragma mark - 菜单

- (void)installMenu
{
    NSMenu *menu = MoteBuildMainMenu(self, @selector(handleMenuCommand:));
    NSApp.mainMenu = menu;

    NSMutableDictionary<NSNumber *, NSMenuItem *> *items = [NSMutableDictionary dictionary];
    for (NSMenuItem *top in menu.itemArray) {
        for (NSMenuItem *item in top.submenu.itemArray) {
            if (item.tag > 0)
                items[@(item.tag)] = item;
        }
    }
    [MoteMainWindow setSharedCommandItems:items];
    if (self.moteWindows.count > 0)
        [self.moteWindows.firstObject updateMenuStates];
}

- (void)handleMenuCommand:(NSMenuItem *)item
{
    MoteMainWindow *window = [self keyMoteWindow];
    if (!window)
        window = self.moteWindows.lastObject;
    [window performMenuCommandWithTag:item.tag];
}

- (void)checkForUpdatesFromMenu:(id)sender
{
    [[MoteUpdater sharedUpdater] checkForUpdatesFromMenu:sender];
}

- (void)showAboutWindow:(id)sender
{
    MoteShowAboutWindow();
}

#pragma mark - 打开最近…（NSMenuDelegate）

- (void)menuNeedsUpdate:(NSMenu *)menu
{
    if (![menu.identifier isEqualToString:MoteRecentMenuIdentifier])
        return;
    [menu removeAllItems];
    NSArray<NSString *> *paths = [MoteRecentFiles.shared paths];
    NSFileManager *fm = NSFileManager.defaultManager;
    for (NSString *path in paths) {
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:path.lastPathComponent
                                                      action:@selector(openRecentDocument:)
                                               keyEquivalent:@""];
        item.target = self;
        item.representedObject = path;
        item.toolTip = path;
        item.enabled = [fm fileExistsAtPath:path];
        [menu addItem:item];
    }
    if (paths.count > 0)
        [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *clear = [[NSMenuItem alloc] initWithTitle:@"清除记录"
                                                   action:@selector(clearRecentDocuments:)
                                            keyEquivalent:@""];
    clear.target = self;
    [menu addItem:clear];
}

- (void)openRecentDocument:(NSMenuItem *)item
{
    [self openRequestedPath:item.representedObject];
}

- (void)clearRecentDocuments:(id)sender
{
    (void)sender;
    [MoteRecentFiles.shared clear];
}

#pragma mark - 键盘监视器（应用级装一次，路由 keyWindow）

- (void)installKeyMonitor
{
    __weak MoteAppDelegate *weakSelf = self;
    self.keyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                            handler:^NSEvent *(NSEvent *event) {
        MoteAppDelegate *delegate = weakSelf;
        MoteMainWindow *window = delegate ? [delegate keyMoteWindow] : nil;
        return window ? [window interceptKeyDown:event] : event;
    }];
}

#pragma mark - 生命周期

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
    (void)sender;
    return YES;
}

// Finder 双击 / 拖到 Dock 打开文档：冷启动时系统可能在 delegate 设好之前
// 就投递 openFile，所以两种时序都要接住（未启动完就先存 pending）。
// 运行中一律新窗口打开（同路径已开则激活既有窗口）。
- (void)application:(NSApplication *)application openFiles:(NSArray<NSString *> *)paths
{
    (void)application;
    for (NSString *path in paths) {
        if (path.length == 0)
            continue;
        if (self.launched)
            [self openRequestedPath:path];
        else
            self.pendingPaths = [self.pendingPaths arrayByAddingObject:path];
    }
}

- (BOOL)application:(NSApplication *)application openFile:(NSString *)filename
{
    (void)application;
    if (filename.length == 0)
        return NO;
    if (self.launched)
        [self openRequestedPath:filename];
    else
        self.pendingPaths = [self.pendingPaths arrayByAddingObject:filename];
    return YES;
}

// 逐窗取脏守卫：任一窗口需要「保存后再退出」会返回 NO 中断本次终止，
// 其保存完成后 runAfterSave 会再次 terminate，届时轮到下一个脏窗口确认。
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender
{
    (void)sender;
    for (MoteMainWindow *window in [self.moteWindows copy]) {
        if (![window applicationShouldTerminate])
            return NSTerminateCancel;
    }
    return NSTerminateNow;
}

@end

// 应用界面只有中文：把应用级语言固定为中文，让 Sparkle 等第三方界面
// 不跟随系统语言显示英文。系统语言已是中文时不做任何事。
static void MoteForceChineseUI()
{
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    id current = [defaults objectForKey:@"AppleLanguages"];
    NSString *first = [current isKindOfClass:NSArray.class] && [current count] > 0
        ? ((NSArray *)current)[0]
        : nil;
    if (first && [first isKindOfClass:NSString.class] && [first hasPrefix:@"zh"])
        return;
    [defaults setObject:@[ @"zh-Hans-CN", @"zh-Hans" ] forKey:@"AppleLanguages"];
}

int main(int argc, const char *argv[])
{
    (void)argc;
    (void)argv;
    mote::perfReset();
    mote::perfMark("mac:proc_entry");
    @autoreleasepool {
        // 必须在任何 bundle 取本地化字符串之前执行
        MoteForceChineseUI();

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        // NSApplication.delegate 不持有对象，必须自己保住生命周期
        static MoteAppDelegate *delegate;
        delegate = [[MoteAppDelegate alloc] init];
        NSApp.delegate = delegate;
        [NSApp run];
    }
    return 0;
}
