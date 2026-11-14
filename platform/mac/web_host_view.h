#pragma once

#import <Cocoa/Cocoa.h>

// WKWebView 宿主：负责临时页面、消息桥与导航兜底。
// 页面就绪/正文注入/状态同步都由 core 的 EditorController 驱动，
// 这里只提供「加载页面」「执行脚本」「把页面消息交出去」三件事。
@interface MoteWebHostView : NSView

// 页面消息（已确认页面代次）；由外壳转给 EditorController::handleMessage
@property(nonatomic, copy) void (^messageHandler)(NSDictionary *body);

// 原生文件拖放：判定与处理都交给 core，宿主只负责从拖放板取路径
@property(nonatomic, copy) BOOL (^canAcceptFileDrop)(NSArray<NSString *> *paths);
@property(nonatomic, copy) BOOL (^performFileDrop)(NSArray<NSString *> *paths);

// directory 为空表示未命名文档：临时页面落在系统临时目录
- (void)loadEditorPageInDirectory:(NSString *)directory;
- (void)evaluateJavaScript:(NSString *)script;
- (void)focusEditor;

// 诊断钩子（MOTE_EVAL / MOTE_SNAPSHOT），页面 ready 后由外壳调用
- (void)runPageDiagnostics;

@end
