#import <Cocoa/Cocoa.h>

#import "main_window.h"

@interface MoteAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) MoteMainWindow *mainWindow;
@end

@implementation MoteAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    (void)notification;

    // Sparkle 自动更新初始化：
    // 纯 Sparkle 方案只需一行——SUUpdater 单例会读取 Info.plist 的 SUFeedURL，
    // 按 SUScheduledCheckInterval 定时检查，用户点菜单「检查更新…」也走同一个单例。
    // 用 NSClassFromString 动态获取类，没有 Sparkle.framework 时自动跳过（开发期友好）。
    Class SUUpdaterClass = NSClassFromString(@"SUUpdater");
    if (SUUpdaterClass) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        // sharedUpdater 返回单例，不持有；Sparkle 自己管生命周期
        [SUUpdaterClass performSelector:@selector(sharedUpdater)];
#pragma clang diagnostic pop
    }

    self.mainWindow = [[MoteMainWindow alloc] init];
    [self.mainWindow show];

    // 与 Qt 构建一致：第一个命令行参数当作待打开文件
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    if (arguments.count > 1)
        [self.mainWindow openPath:arguments[1]];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
    (void)sender;
    return YES;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender
{
    (void)sender;
    return [self.mainWindow applicationShouldTerminate] ? NSTerminateNow : NSTerminateCancel;
}

@end

int main(int argc, const char *argv[])
{
    (void)argc;
    (void)argv;
    @autoreleasepool {
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
