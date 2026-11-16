#pragma once

#import <Cocoa/Cocoa.h>

// 在线更新的「自研检查」入口：拉取 OSS 上的 latest.json → 用 core/update 判定 →
// 自定义弹窗；用户同意后交给 Sparkle 完成下载、验签、替换与重启。
// 检查时机：启动后延迟一次、每 24 小时一次、菜单「检查更新…」立即检查。
@interface MoteUpdater : NSObject

+ (instancetype)sharedUpdater;

// 启动定时检查（幂等）
- (void)start;

// 菜单入口：强制立即检查，并明确告知结果
- (void)checkForUpdatesFromMenu:(id)sender;

@end
