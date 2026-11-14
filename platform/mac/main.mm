#import <Cocoa/Cocoa.h>

#import "web_host_view.h"

static NSMenuItem *MoteMenuItem(NSMenu *menu, NSString *title, SEL action,
                               NSString *key, NSEventModifierFlags flags)
{
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title
                                                 action:action
                                          keyEquivalent:key ?: @""];
    if (flags)
        item.keyEquivalentModifierMask = flags;
    [menu addItem:item];
    return item;
}

static NSMenu *MoteSubmenu(NSMenu *mainMenu, NSString *title)
{
    NSMenuItem *holder = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
    NSMenu *menu = [[NSMenu alloc] initWithTitle:title];
    holder.submenu = menu;
    [mainMenu addItem:holder];
    return menu;
}

@interface MoteAppDelegate : NSObject <NSApplicationDelegate, MoteWebHostDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) MoteWebHostView *host;
@end

@implementation MoteAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    (void)notification;
    [self installMenu];

    NSRect frame = NSMakeRect(0, 0, 1180, 820);
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                             | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.title = @"Mote";
    window.minSize = NSMakeSize(760, 520);

    MoteWebHostView *host = [[MoteWebHostView alloc] initWithFrame:frame];
    host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    host.delegate = self;
    window.contentView = host;

    [window center];
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    _window = window;
    _host = host;
    [host loadEditorPage];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
    (void)sender;
    return YES;
}

// M0 验收：页面 ready 后推一份示例文档
- (void)webHostDidBecomeReady:(MoteWebHostView *)host
{
    NSURL *sample = [[NSBundle mainBundle] URLForResource:@"welcome"
                                             withExtension:@"md"
                                              subdirectory:@"samples"];
    NSString *text = sample
        ? [NSString stringWithContentsOfURL:sample encoding:NSUTF8StringEncoding error:NULL]
        : nil;
    [host setMarkdown:text ?: @"# Mote\n\n原生外壳已启动。"];
}

- (void)installMenu
{
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@"Mote"];

    NSMenu *app = MoteSubmenu(mainMenu, @"Mote");
    MoteMenuItem(app, @"关于 Mote", @selector(orderFrontStandardAboutPanel:), @"", 0);
    [app addItem:[NSMenuItem separatorItem]];
    MoteMenuItem(app, @"隐藏 Mote", @selector(hide:), @"h", 0);
    MoteMenuItem(app, @"隐藏其他", @selector(hideOtherApplications:), @"h",
                 NSEventModifierFlagCommand | NSEventModifierFlagOption);
    MoteMenuItem(app, @"显示全部", @selector(unhideAllApplications:), @"", 0);
    [app addItem:[NSMenuItem separatorItem]];
    MoteMenuItem(app, @"退出 Mote", @selector(terminate:), @"q", 0);

    NSMenu *edit = MoteSubmenu(mainMenu, @"编辑");
    MoteMenuItem(edit, @"剪切", @selector(cut:), @"x", 0);
    MoteMenuItem(edit, @"复制", @selector(copy:), @"c", 0);
    MoteMenuItem(edit, @"粘贴", @selector(paste:), @"v", 0);
    MoteMenuItem(edit, @"全选", @selector(selectAll:), @"a", 0);

    NSMenu *win = MoteSubmenu(mainMenu, @"窗口");
    MoteMenuItem(win, @"最小化", @selector(performMiniaturize:), @"m", 0);
    MoteMenuItem(win, @"关闭", @selector(performClose:), @"w", 0);

    NSApp.mainMenu = mainMenu;
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
