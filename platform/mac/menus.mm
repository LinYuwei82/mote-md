#import "menus.h"

#include "core/command_table.h"

namespace {

NSString *KeyEquivalentForToken(NSString *token)
{
    if ([token isEqualToString:@"equal"])
        return @"=";
    if ([token isEqualToString:@"plus"])
        return @"+";
    if ([token isEqualToString:@"minus"])
        return @"-";
    if ([token isEqualToString:@"slash"])
        return @"/";
    return token;
}

// 符号键按「字符族」比较：Shift 会改变 = 变 +、- 变 _，但命令表把它们分开列出，
// 因此比较符号键时忽略 Shift，靠字符本身区分。
NSString *KeyFamilyForToken(NSString *token)
{
    if ([token isEqualToString:@"equal"] || [token isEqualToString:@"plus"])
        return @"equal";
    if ([token isEqualToString:@"minus"])
        return @"minus";
    if ([token isEqualToString:@"slash"])
        return @"slash";
    return token;
}

NSString *KeyFamilyForEvent(NSEvent *event)
{
    NSString *chars = [event.charactersIgnoringModifiers lowercaseString];
    if ([chars isEqualToString:@"="] || [chars isEqualToString:@"+"])
        return @"equal";
    if ([chars isEqualToString:@"-"] || [chars isEqualToString:@"_"])
        return @"minus";
    if ([chars isEqualToString:@"/"] || [chars isEqualToString:@"?"])
        return @"slash";
    return chars;
}

NSEventModifierFlags ModifierMaskForToken(NSString *token)
{
    if ([token isEqualToString:@"cmd"])
        return NSEventModifierFlagCommand;
    if ([token isEqualToString:@"ctrl"] || [token isEqualToString:@"control"])
        return NSEventModifierFlagControl;
    if ([token isEqualToString:@"option"] || [token isEqualToString:@"alt"])
        return NSEventModifierFlagOption;
    if ([token isEqualToString:@"shift"])
        return NSEventModifierFlagShift;
    return 0;
}

const NSEventModifierFlags kRelevantFlags = NSEventModifierFlagCommand
    | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift;

NSString *TitleOf(const mote::CommandSpec &spec)
{
    return [NSString stringWithUTF8String:spec.title.c_str()];
}

} // namespace

BOOL MoteShortcutToKeyEquivalent(NSString *shortcut, NSString **key,
                                 NSEventModifierFlags *flags)
{
    if (shortcut.length == 0)
        return NO;
    NSEventModifierFlags mask = 0;
    NSString *keyToken = nil;
    for (NSString *raw in [shortcut componentsSeparatedByString:@"+"]) {
        NSString *token = [raw lowercaseString];
        const NSEventModifierFlags modifier = ModifierMaskForToken(token);
        if (modifier != 0)
            mask |= modifier;
        else
            keyToken = token;
    }
    if (keyToken.length == 0)
        return NO;
    if (key)
        *key = KeyEquivalentForToken(keyToken);
    if (flags)
        *flags = mask;
    return YES;
}

BOOL MoteEventMatchesShortcut(NSEvent *event, NSString *shortcut)
{
    NSString *key = nil;
    NSEventModifierFlags expected = 0;
    if (!MoteShortcutToKeyEquivalent(shortcut, &key, &expected))
        return NO;

    const NSEventModifierFlags actual = event.modifierFlags & kRelevantFlags;
    NSString *family = KeyFamilyForToken([key lowercaseString]);
    const bool symbolKey = [family isEqualToString:@"equal"] || [family isEqualToString:@"minus"]
        || [family isEqualToString:@"slash"];
    const NSEventModifierFlags comparableExpected =
        symbolKey ? (expected & ~NSEventModifierFlagShift) : expected;
    const NSEventModifierFlags comparableActual =
        symbolKey ? (actual & ~NSEventModifierFlagShift) : actual;
    if (comparableExpected != comparableActual)
        return NO;
    return [KeyFamilyForEvent(event) isEqualToString:family];
}

NSMenu *MoteBuildMainMenu(id commandTarget, SEL commandAction)
{
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@"Mote"];

    // 应用菜单：macOS 约定项，不进 core 命令表
    NSMenuItem *appHolder = [[NSMenuItem alloc] initWithTitle:@"Mote" action:nil keyEquivalent:@""];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Mote"];
    appHolder.submenu = appMenu;
    [mainMenu addItem:appHolder];
    [appMenu addItem:[[NSMenuItem alloc] initWithTitle:@"关于 Mote"
                                                action:@selector(orderFrontStandardAboutPanel:)
                                         keyEquivalent:@""]];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItem:[[NSMenuItem alloc] initWithTitle:@"隐藏 Mote"
                                                action:@selector(hide:)
                                         keyEquivalent:@"h"]];
    NSMenuItem *hideOthers = [[NSMenuItem alloc] initWithTitle:@"隐藏其他"
                                                       action:@selector(hideOtherApplications:)
                                                keyEquivalent:@"h"];
    hideOthers.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
    [appMenu addItem:hideOthers];
    [appMenu addItem:[[NSMenuItem alloc] initWithTitle:@"显示全部"
                                                action:@selector(unhideAllApplications:)
                                         keyEquivalent:@""]];
    [appMenu addItem:[NSMenuItem separatorItem]];
    // 「检查更新…」走自研入口（拉 latest.json 判定），确认安装后才转给 Sparkle
    NSMenuItem *checkUpdate =
        [[NSMenuItem alloc] initWithTitle:@"检查更新…"
                                   action:@selector(checkForUpdatesFromMenu:)
                            keyEquivalent:@""];
    checkUpdate.target = commandTarget;
    [appMenu addItem:checkUpdate];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItem:[[NSMenuItem alloc] initWithTitle:@"退出 Mote"
                                                action:@selector(terminate:)
                                         keyEquivalent:@"q"]];

    for (const mote::MenuSpec &menuSpec : mote::menus()) {
        NSString *title = [NSString stringWithUTF8String:menuSpec.title.c_str()];
        NSMenuItem *holder = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
        NSMenu *menu = [[NSMenu alloc] initWithTitle:title];
        holder.submenu = menu;
        [mainMenu addItem:holder];

        for (const mote::CommandId id : menuSpec.items) {
            if (id == mote::CommandId::Separator) {
                [menu addItem:[NSMenuItem separatorItem]];
                continue;
            }
            const mote::CommandSpec *spec = mote::findCommand(id);
            if (!spec)
                continue;
            NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:TitleOf(*spec)
                                                         action:commandAction
                                                  keyEquivalent:@""];
            item.target = commandTarget;
            item.tag = static_cast<NSInteger>(id);
            if (!spec->shortcuts.empty()) {
                NSString *key = nil;
                NSEventModifierFlags flags = 0;
                NSString *shortcut = [NSString stringWithUTF8String:spec->shortcuts.front().c_str()];
                if (MoteShortcutToKeyEquivalent(shortcut, &key, &flags)) {
                    item.keyEquivalent = key;
                    item.keyEquivalentModifierMask = flags;
                }
            }
            if (spec->checkable)
                item.state = NSControlStateValueOff;
            [menu addItem:item];
        }
    }

    // 窗口菜单：系统约定项
    NSMenuItem *windowHolder = [[NSMenuItem alloc] initWithTitle:@"窗口"
                                                          action:nil
                                                   keyEquivalent:@""];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"窗口"];
    windowHolder.submenu = windowMenu;
    [mainMenu addItem:windowHolder];
    [windowMenu addItem:[[NSMenuItem alloc] initWithTitle:@"最小化"
                                                   action:@selector(performMiniaturize:)
                                            keyEquivalent:@"m"]];
    [windowMenu addItem:[[NSMenuItem alloc] initWithTitle:@"关闭"
                                                   action:@selector(performClose:)
                                            keyEquivalent:@"w"]];

    return mainMenu;
}
