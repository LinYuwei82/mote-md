#pragma once

#import <Cocoa/Cocoa.h>

// 主窗口外壳：文档状态、菜单动作、打开/保存与未保存确认。
// 页面状态机在 core 的 EditorController 里，这里只做 AppKit 落地。
@interface MoteMainWindow : NSObject

- (void)show;
- (void)openPath:(NSString *)path;
- (BOOL)applicationShouldTerminate;

@end
