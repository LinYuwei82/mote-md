#import <Cocoa/Cocoa.h>

#import "main_window.h"
#import "updater.h"

#include "core/perf.h"

@interface MoteAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) MoteMainWindow *mainWindow;
@property(nonatomic, copy) NSArray<NSString *> *pendingPaths;
@end

@implementation MoteAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    (void)notification;
    mote::perfMark("mac:did_finish_launch");

    // 第一个命令行参数当作待打开文件：直接交给 init，避免先加载示例页
    // 再换目录重载（两次完整页面解析）
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    NSString *pendingPath = arguments.count > 1 ? arguments[1] : nil;

    self.mainWindow = [[MoteMainWindow alloc] initWithPendingFile:pendingPath];
    [self.mainWindow show];
    mote::perfMark("mac:window_shown");
    // delegate 设好之前收到的 openFile 会攒在 pendingPaths，这里补发
    for (NSString *path in self.pendingPaths)
        [self.mainWindow requestOpenPath:path];
    self.pendingPaths = @[];

    // 在线更新：自研检查（OSS 上的 manifest.json）负责「有没有新版本」，
    // 用户确认后由 Sparkle 完成下载、验签与替换。启动后延迟一次 + 每 24 小时一次。
    [[MoteUpdater sharedUpdater] start];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
    (void)sender;
    return YES;
}

// Finder 双击 / 拖到 Dock 打开文档：冷启动时系统可能在 delegate 设好之前
// 就投递 openFile，所以两种时序都要接住（mainWindow 还没建就先存 pending）。
- (void)application:(NSApplication *)application openFiles:(NSArray<NSString *> *)paths
{
    (void)application;
    for (NSString *path in paths) {
        if (path.length == 0)
            continue;
        if (self.mainWindow)
            [self.mainWindow requestOpenPath:path];
        else
            self.pendingPaths = [self.pendingPaths arrayByAddingObject:path];
    }
}

- (BOOL)application:(NSApplication *)application openFile:(NSString *)filename
{
    (void)application;
    if (filename.length == 0)
        return NO;
    if (self.mainWindow)
        [self.mainWindow requestOpenPath:filename];
    else
        self.pendingPaths = [self.pendingPaths arrayByAddingObject:filename];
    return YES;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender
{
    (void)sender;
    return [self.mainWindow applicationShouldTerminate] ? NSTerminateNow : NSTerminateCancel;
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
