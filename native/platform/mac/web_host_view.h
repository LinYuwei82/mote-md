#pragma once

#import <Cocoa/Cocoa.h>

@class MoteWebHostView;

@protocol MoteWebHostDelegate <NSObject>
// 页面完成初始化（editor.js 发出 ready）后回调，此后才可以推正文
- (void)webHostDidBecomeReady:(MoteWebHostView *)host;
@end

// WKWebView 宿主：负责临时页面、消息桥与导航兜底。
// M0 只暴露加载页面与推正文，打开/保存等动作在后续里程碑接入。
@interface MoteWebHostView : NSView

@property(nonatomic, weak) id<MoteWebHostDelegate> delegate;

- (void)loadEditorPage;
- (void)setMarkdown:(NSString *)text;

@end
