// 从拖放板取真实文件路径；Finder 给的是 file URL
static NSArray<NSString *> *MoteDraggedPaths(id<NSDraggingInfo> sender)
{
    NSArray<NSURL *> *urls = [sender.draggingPasteboard
        readObjectsForClasses:@[ NSURL.class ]
                     options:@{ NSPasteboardURLReadingFileURLsOnlyKey : @YES }];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSURL *url in urls) {
        if (url.isFileURL && url.path)
            [paths addObject:url.path];
    }
    return paths;
}

// WKWebView 自己实现了拖放目标；判定/处理交给宿主的 block，
// 不接管时退回系统默认行为（页面内拖选文字等）。
@interface MoteWKWebView : WKWebView
@property(nonatomic, weak) MoteWebHostView *host;
@end

@implementation MoteWKWebView

- (BOOL)acceptsPaths:(NSArray<NSString *> *)paths
{
    return paths.count > 0 && self.host.canAcceptFileDrop
        && self.host.canAcceptFileDrop(paths);
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender
{
    if ([self acceptsPaths:MoteDraggedPaths(sender)])
        return NSDragOperationCopy;
    return [super draggingEntered:sender];
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender
{
    if ([self acceptsPaths:MoteDraggedPaths(sender)])
        return NSDragOperationCopy;
    return [super draggingUpdated:sender];
}

- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender
{
    if ([self acceptsPaths:MoteDraggedPaths(sender)])
        return YES;
    return [super prepareForDragOperation:sender];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender
{
    NSArray<NSString *> *paths = MoteDraggedPaths(sender);
    if (paths.count > 0 && self.host.performFileDrop && self.host.performFileDrop(paths))
        return YES;
    return [super performDragOperation:sender];
}

@end

// 消息桥单独成对象：WKUserContentController 强引用 handler，
// 直接让宿主自己当 handler 会形成引用环。owner 保持弱引用。
@interface MoteScriptBridge : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) MoteWebHostView *host;
@end

@implementation MoteScriptBridge

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message
{
    (void)controller;
    MoteWebHostView *host = self.host;
    if (!host || ![message.body isKindOfClass:[NSDictionary class]])
        return;

    // 跨页竞态防线：页面 URL 的 fragment 记录加载时的代次，
    // 上一个页面迟到的消息代次对不上就丢弃。
    NSString *token = message.frameInfo.request.URL.fragment;
    if (token.length > 0) {
        NSString *expected = [NSString stringWithFormat:@"g%lu",
                              (unsigned long)host.pageGeneration];
        if (![token isEqualToString:expected])
            return;
    }
    if (host.messageHandler)
        host.messageHandler((NSDictionary *)message.body);
}

@end
