#import "about_window.h"

#import "updater.h"

static NSString *const kMoteWebsiteURL = @"https://dl.xiaotu.online/mote/";

// 代码构建的关于面板（无 xib），布局与 Windows 端 about_dialog 逐字一致。
@interface MoteAboutWindowController : NSWindowController <NSWindowDelegate>
@end

static MoteAboutWindowController *g_about_controller = nil;

@implementation MoteAboutWindowController

- (instancetype)init
{
    const CGFloat w = 320;
    const CGFloat h = 322;
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, w, h)
                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.title = @"关于 Mote";
    window.releasedWhenClosed = NO;
    window.delegate = self;
    window.representedURL = nil;
    if (self = [super initWithWindow:window]) {
        NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, w, h)];
        window.contentView = content;

        CGFloat y = h - 24;

        // 图标
        y -= 96;
        NSImageView *icon = [[NSImageView alloc]
            initWithFrame:NSMakeRect((w - 96) / 2, y, 96, 96)];
        icon.image = [NSApp applicationIconImage];
        [content addSubview:icon];

        // 名称
        y -= 34;
        NSTextField *name = [self labelWithText:@"Mote"
                                           font:[NSFont boldSystemFontOfSize:17]
                                          frame:NSMakeRect(0, y, w, 22)];
        name.alignment = NSTextAlignmentCenter;
        [content addSubview:name];

        // 版本（构建号）
        NSBundle *bundle = [NSBundle mainBundle];
        NSString *version = bundle.infoDictionary[@"CFBundleShortVersionString"] ?: @"0.0.0";
        NSString *build = bundle.infoDictionary[@"CFBundleVersion"] ?: @"0";
        y -= 22;
        NSTextField *ver = [self labelWithText:
                                      [NSString stringWithFormat:@"版本 %@ (%@)", version, build]
                                          font:[NSFont systemFontOfSize:12]
                                         frame:NSMakeRect(0, y, w, 18)];
        ver.alignment = NSTextAlignmentCenter;
        [content addSubview:ver];

        // 版权
        y -= 20;
        NSTextField *copyright = [self labelWithText:@"© 2026 xiaotu · 小兔在线"
                                                font:[NSFont systemFontOfSize:11]
                                               frame:NSMakeRect(0, y, w, 16)];
        copyright.alignment = NSTextAlignmentCenter;
        [content addSubview:copyright];

        // 官网链接（无边框蓝按钮，模拟超链接）
        y -= 30;
        NSButton *site = [[NSButton alloc] initWithFrame:NSMakeRect(0, y, w, 20)];
        site.bordered = NO;
        site.bezelStyle = NSBezelStyleInline;
        site.title = @"官网与下载";
        site.attributedTitle = [[NSAttributedString alloc]
            initWithString:@"官网与下载"
                attributes:@{
                    NSForegroundColorAttributeName : NSColor.linkColor,
                    NSFontAttributeName : [NSFont systemFontOfSize:12]
                }];
        site.target = self;
        site.action = @selector(openWebsite:);
        [content addSubview:site];

        y -= 22;

        // 检查更新
        y -= 32;
        NSButton *check = [[NSButton alloc]
            initWithFrame:NSMakeRect((w - 150) / 2, y, 150, 28)];
        check.title = @"检查更新…";
        check.bezelStyle = NSBezelStyleRounded;
        check.target = self;
        check.action = @selector(checkUpdates:);
        [content addSubview:check];

        // 关闭
        y -= 34;
        NSButton *close = [[NSButton alloc]
            initWithFrame:NSMakeRect((w - 96) / 2, y, 96, 28)];
        close.title = @"关闭";
        close.bezelStyle = NSBezelStyleRounded;
        close.keyEquivalent = @"\r";
        close.target = self;
        close.action = @selector(closeWindow:);
        [content addSubview:close];
    }
    return self;
}

- (NSTextField *)labelWithText:(NSString *)text
                          font:(NSFont *)font
                         frame:(NSRect)frame
{
    NSTextField *label = [[NSTextField alloc] initWithFrame:frame];
    label.stringValue = text;
    label.font = font;
    label.textColor = (font.pointSize >= 17) ? NSColor.labelColor : NSColor.secondaryLabelColor;
    label.editable = NO;
    label.selectable = NO;
    label.drawsBackground = NO;
    label.bordered = NO;
    return label;
}

- (void)openWebsite:(id)sender
{
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:kMoteWebsiteURL]];
}

- (void)checkUpdates:(id)sender
{
    [[MoteUpdater sharedUpdater] checkForUpdatesFromMenu:sender];
}

- (void)closeWindow:(id)sender
{
    [self.window performClose:sender];
}

- (void)windowWillClose:(NSNotification *)notification
{
    g_about_controller = nil;
}

@end

void MoteShowAboutWindow(void)
{
    if (!g_about_controller)
        g_about_controller = [[MoteAboutWindowController alloc] init];
    NSWindow *window = g_about_controller.window;
    NSWindow *parent = [NSApp keyWindow];
    if (parent) {
        NSRect frame = window.frame;
        NSRect pf = parent.frame;
        frame.origin = NSMakePoint(NSMidX(pf) - frame.size.width / 2,
                                   NSMidY(pf) - frame.size.height / 2);
        [window setFrameOrigin:frame.origin];
    } else {
        [window center];
    }
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}
