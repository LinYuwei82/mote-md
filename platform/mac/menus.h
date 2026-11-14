#pragma once

#import <Cocoa/Cocoa.h>

// 按 core/command_table 生成主菜单：命令项统一打到 commandTarget/commandAction，
// 用 item.tag 区分命令（CommandId）。
NSMenu *MoteBuildMainMenu(id commandTarget, SEL commandAction);

// 快捷键字符串（"cmd+shift+z"）→ keyEquivalent 与修饰键
BOOL MoteShortcutToKeyEquivalent(NSString *shortcut, NSString **key,
                                 NSEventModifierFlags *flags);

// 键盘事件是否命中该快捷键（供本地事件监视器分流，避免菜单忽略 Shift 的问题）
BOOL MoteEventMatchesShortcut(NSEvent *event, NSString *shortcut);
