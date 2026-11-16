#import <Cocoa/Cocoa.h>

#import "main_window.h"
#import "updater.h"

@interface MoteAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) MoteMainWindow *mainWindow;
@end

@implementation MoteAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    (void)notification;

    self.mainWindow = [[MoteMainWindow alloc] init];
    [self.mainWindow show];

    // 在线更新：自研检查（OSS 上的 latest.json）负责「有没有新版本」，
    // 用户确认后由 Sparkle 完成下载、验签与替换。启动后延迟一次 + 每 24 小时一次。
    [[MoteUpdater sharedUpdater] start];

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
