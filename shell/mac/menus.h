#pragma once

#import <Cocoa/Cocoa.h>

// 「打开最近…」子菜单的识别标记（AppDelegate 作为 delegate 在
// menuNeedsUpdate: 里按此 identifier 重建条目）
#define MoteRecentMenuIdentifier @"com.mote.recent-files"

// 按 core/command_table 生成主菜单：命令项统一打到 commandTarget/commandAction，
// 用 item.tag 区分命令（CommandId）。commandTarget 同时充当最近子菜单的 delegate。
NSMenu *MoteBuildMainMenu(id commandTarget, SEL commandAction);

// 快捷键字符串（"cmd+shift+z"）→ keyEquivalent 与修饰键
BOOL MoteShortcutToKeyEquivalent(NSString *shortcut, NSString **key,
                                 NSEventModifierFlags *flags);

// 键盘事件是否命中该快捷键（供本地事件监视器分流，避免菜单忽略 Shift 的问题）
BOOL MoteEventMatchesShortcut(NSEvent *event, NSString *shortcut);
