#pragma once

#import <Cocoa/Cocoa.h>

// 主窗口外壳：文档状态、菜单动作、打开/保存与未保存确认。
// 页面状态机在 core 的 EditorController 里，这里只做 AppKit 落地。
@interface MoteMainWindow : NSObject

// 带待打开文件构造：init 内直接加载该文件，不再先加载内置示例页
//（示例页会触发一次完整的 4MB 级页面解析，随后 openPath 再换目录重载一次）。
- (instancetype)initWithPendingFile:(NSString *)path;
- (void)show;
- (void)openPath:(NSString *)path;
- (BOOL)applicationShouldTerminate;

@end
