#pragma once

#import <Cocoa/Cocoa.h>

@class MoteMainWindow;

// 窗口即将关闭（object=窗口实例）：AppDelegate 据此从窗口注册表摘除
extern NSNotificationName const MoteWindowWillCloseNotification;

// AppDelegate 必须实现：窗口侧把「新窗口打开」类请求上收到应用层路由
@protocol MoteAppRouting <NSObject>
// 外部打开请求（Finder 双击 / 拖放 / 最近列表）：已打开则激活，否则新窗口
- (void)openRequestedPath:(NSString *)path;
// 新建窗口（示例页）
- (void)openNewWindow;
@end

// 主窗口外壳：文档状态、菜单动作、打开/保存与未保存确认。
// 页面状态机在 core 的 EditorController 里，这里只做 AppKit 落地。
// 多窗口：菜单与键盘监视器在 AppDelegate（应用级共享），本类只管单文档。
@interface MoteMainWindow : NSObject

// 带待打开文件构造：init 内直接加载该文件，不再先加载内置示例页
//（示例页会触发一次完整的 4MB 级页面解析，随后 openPath 再换目录重载一次）。
- (instancetype)initWithPendingFile:(NSString *)path;
- (void)show;
- (void)openPath:(NSString *)path;
- (BOOL)applicationShouldTerminate;

// ---- 多窗口支撑 ----
@property(nonatomic, readonly) NSWindow *nativeWindow;
// 该窗口当前是否正打开 path（分隔符统一 + 大小写不敏感比较）
- (BOOL)isShowingPath:(NSString *)path;
// 应用级键盘监视器转发至此；返回 nil 表示已消费
- (NSEvent *)interceptKeyDown:(NSEvent *)event;
// 菜单命令入口（item.tag 即 CommandId）
- (void)performMenuCommandWithTag:(NSInteger)tag;
// 把本窗口状态同步到共享菜单项（keyWindow 切换 / 状态变化时调用）
- (void)updateMenuStates;
// 菜单项按 tag 索引表：AppDelegate 构建主菜单后一次性注入，全窗口共享
+ (void)setSharedCommandItems:(NSDictionary<NSNumber *, NSMenuItem *> *)items;

@end

// 「最近打开」列表：NSUserDefaults 持久化，跨窗口共享（core RecentFiles 封装）
@interface MoteRecentFiles : NSObject
+ (instancetype)shared;
- (void)addPath:(NSString *)path;
- (NSArray<NSString *> *)paths;
- (void)clear;
@end
