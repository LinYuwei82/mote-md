#import "main_window.h"

#import "dialogs.h"
#import "html_export.h"
#import "menus.h"
#import "updater.h"
#import "web_host_view.h"

#include "core/command_table.h"
#include "core/editor_controller.h"
#include "core/js_bridge.h"
#include "core/paths.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>
#include <vector>

typedef NS_ENUM(NSInteger, MoteAfterSave) {
    MoteAfterSaveNone = 0,
    MoteAfterSaveOpenDialog,
    MoteAfterSaveOpenPath,
    MoteAfterSaveNewDocument,
    MoteAfterSaveClose,
    MoteAfterSaveTerminate,
    MoteAfterSaveExportPdf,
    MoteAfterSaveDropText,
};

@interface MoteMainWindow () <NSWindowDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) MoteWebHostView *host;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, NSMenuItem *> *commandItems;
@property(nonatomic, copy) NSString *filePath;
@property(nonatomic, copy) NSString *lastDir;
@property(nonatomic, copy) NSString *lastText;
@property(nonatomic, copy) NSString *afterSavePath;
@property(nonatomic, copy) NSString *afterSaveText;
@property(nonatomic) MoteAfterSave afterSave;
@property(nonatomic) BOOL saveAsRequested;
@property(nonatomic) BOOL followSystem;
@property(nonatomic) BOOL darkMode;
@property(nonatomic) id keyMonitor;
@property(nonatomic, copy) NSString *lastStatus;

- (void)evaluateScript:(const std::string &)script;
- (void)loadPageInDirectory:(const std::string &)directory;
- (void)saveText:(const std::string &)text;
- (void)applyViewState:(const mote::ViewState &)state;
- (void)pageBecameReady;
- (void)openDocument;
- (void)openPathFromDrop:(const std::string &)path;
- (void)acceptDroppedName:(const std::string &)name text:(const std::string &)text;
- (void)openExternalUrl:(const std::string &)url;
- (void)htmlExportReady:(const std::string &)html;
- (void)requestPdfExport:(const std::string &)path;
- (void)pdfExportFailed:(const std::string &)message;
- (void)handlePageMessage:(NSDictionary *)body;
- (void)updateWindowTitle;
- (void)showStatus:(NSString *)text;
- (void)installMenu;
- (void)handleMenuCommand:(NSMenuItem *)item;
- (void)performCommand:(mote::CommandId)command;
- (NSEvent *)interceptKeyDown:(NSEvent *)event;
- (void)sendResponderAction:(SEL)action;
- (BOOL)systemIsDark;
- (void)applyTheme;
- (void)updateMenuStates;
- (void)loadBuiltinSample;
- (NSString *)displayName;
- (void)newDocument;
- (void)startNewDocument;
- (void)beginSaveAs:(BOOL)saveAs;
- (BOOL)writeText:(NSString *)text toPath:(NSString *)path;
- (BOOL)prepareForReplace:(MoteAfterSave)after path:(NSString *)path;
- (BOOL)prepareForReplace:(MoteAfterSave)after path:(NSString *)path text:(NSString *)text;
- (void)loadDroppedText:(const std::string &)text;
- (void)runAfterSave;
- (void)resetAfterSave;
- (void)setupDropHandlers;
- (void)runDropProbeIfNeeded;
- (void)runStartupCommandIfNeeded;
- (BOOL)performNativeDrop:(NSArray<NSString *> *)paths;
- (void)exportPdf;
- (void)checkForUpdatesFromMenu:(id)sender;
@end

static BOOL MoteKeyLogEnabled(void)
{
    return std::getenv("MOTE_KEYLOG") != nullptr;
}

static std::vector<std::string> MotePathsToVector(NSArray<NSString *> *paths)
{
    std::vector<std::string> result;
    result.reserve(paths.count);
    for (NSString *path in paths) {
        if (path.UTF8String)
            result.emplace_back(path.UTF8String);
    }
    return result;
}

namespace {

// EditorHost → AppKit 的转发层。owner 是应用级单窗口，生命周期覆盖整个进程。
class ShellHost final : public mote::EditorHost
{
public:
    explicit ShellHost(MoteMainWindow *window) : m_owner(window) {}

    void evaluateJs(const std::string &script) override
    {
        [m_owner evaluateScript:script];
    }
    void loadPage(const std::string &baseDir) override
    {
        [m_owner loadPageInDirectory:baseDir];
    }
    void setClipboard(const std::string &text, const std::string &html) override
    {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        [pasteboard clearContents];
        NSString *plain = [NSString stringWithUTF8String:text.c_str()];
        [pasteboard setString:plain ?: @"" forType:NSPasteboardTypeString];
        if (!html.empty()) {
            NSString *marked = [NSString stringWithUTF8String:html.c_str()];
            if (marked)
                [pasteboard setString:marked forType:NSPasteboardTypeHTML];
        }
    }
    std::string clipboardText() override
    {
        NSString *text = [[NSPasteboard generalPasteboard]
            stringForType:NSPasteboardTypeString];
        return text ? std::string(text.UTF8String) : std::string();
    }
    void openExternal(const std::string &url) override
    {
        [m_owner openExternalUrl:url];
    }
    void saveRequested(const std::string &text) override
    {
        [m_owner saveText:text];
    }
    void openRequested() override
    {
        [m_owner openDocument];
    }
    void dropReceived(const std::string &name, const std::string &text) override
    {
        [m_owner acceptDroppedName:name text:text];
    }
    void exportHtmlReady(const std::string &html) override
    {
        [m_owner htmlExportReady:html];
    }
    void exportPdfRequested(const std::string &path) override
    {
        [m_owner requestPdfExport:path];
    }
    void exportPdfFailed(const std::string &message) override
    {
        [m_owner pdfExportFailed:message];
    }
    void fileDropRequested(const std::string &path) override
    {
        [m_owner openPathFromDrop:path];
    }
    void statusMessage(const std::string &message) override
    {
        [m_owner showStatus:[NSString stringWithUTF8String:message.c_str()]];
    }
    void errorOccurred(const std::string &message) override
    {
        NSString *plain = [NSString stringWithUTF8String:message.c_str()];
        [m_owner showStatus:[NSString stringWithFormat:@"前端错误：%@", plain ?: @""]];
    }
    void ready() override
    {
        [m_owner pageBecameReady];
    }
    void dirtyChanged(bool dirty) override
    {
        (void)dirty;
        [m_owner updateWindowTitle];
    }
    void viewStateChanged(const mote::ViewState &state) override
    {
        [m_owner applyViewState:state];
    }
    void statsChanged(int cjk, int words) override
    {
        if (std::getenv("MOTE_KEYLOG"))
            std::fprintf(stderr, "NATIVE stats cjk=%d words=%d\n", cjk, words);
    }
    void logMessage(const std::string &message) override
    {
        if (std::getenv("MOTE_KEYLOG"))
            std::fprintf(stderr, "JSLOG %s\n", message.c_str());
    }

private:
    __unsafe_unretained MoteMainWindow *m_owner;
};

} // namespace

@implementation MoteMainWindow {
    std::unique_ptr<ShellHost> _shell;
    std::unique_ptr<mote::EditorController> _controller;
    BOOL _tocOn;
    BOOL _sourceOn;
    BOOL _dropProbeDone;
    double _lastZoom;
}

- (instancetype)init
{
    self = [super init];
    if (!self)
        return nil;

    _followSystem = YES;
    _darkMode = [self systemIsDark];
    _lastZoom = 1.0;

    NSRect frame = NSMakeRect(0, 0, 1180, 820);
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                             | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.title = @"Mote";
    window.minSize = NSMakeSize(760, 520);
    window.delegate = self;
    _window = window;

    MoteWebHostView *host = [[MoteWebHostView alloc] initWithFrame:frame];
    host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    __weak MoteMainWindow *weakSelf = self;
    host.messageHandler = ^(NSDictionary *body) {
        [weakSelf handlePageMessage:body];
    };
    window.contentView = host;
    _host = host;

    _shell = std::make_unique<ShellHost>(self);
    _controller = std::make_unique<mote::EditorController>(*_shell);
    [self setupDropHandlers];

    [self installMenu];
    [self loadBuiltinSample];
    // 页面就绪前先记住主题，ready 后由 core 补发
    [self applyTheme];
    [window center];

    __weak MoteMainWindow *weakForMonitor = self;
    _keyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                       handler:^NSEvent *(NSEvent *event) {
        MoteMainWindow *strongSelf = weakForMonitor;
        return strongSelf ? [strongSelf interceptKeyDown:event] : event;
    }];
    return self;
}

- (void)dealloc
{
    if (_keyMonitor)
        [NSEvent removeMonitor:_keyMonitor];
}

- (void)show
{
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

#pragma mark - 菜单

- (void)installMenu
{
    NSMenu *menu = MoteBuildMainMenu(self, @selector(handleMenuCommand:));
    NSApp.mainMenu = menu;

    self.commandItems = [NSMutableDictionary dictionary];
    for (NSMenuItem *top in menu.itemArray) {
        for (NSMenuItem *item in top.submenu.itemArray) {
            if (item.tag > 0)
                self.commandItems[@(item.tag)] = item;
        }
    }
}

- (void)handleMenuCommand:(NSMenuItem *)item
{
    [self performCommand:static_cast<mote::CommandId>(item.tag)];
}

- (void)checkForUpdatesFromMenu:(id)sender
{
    [[MoteUpdater sharedUpdater] checkForUpdatesFromMenu:sender];
}

- (NSEvent *)interceptKeyDown:(NSEvent *)event
{
    // 弹窗（保存面板/警告框）期间把按键交回 AppKit
    if (NSApp.modalWindow || !self.window.isKeyWindow)
        return event;

    if (MoteKeyLogEnabled()) {
        std::fprintf(stderr, "NATIVE keydown chars=%s flags=%lu\n",
                     event.charactersIgnoringModifiers.UTF8String,
                     (unsigned long)event.modifierFlags);
    }

    for (const mote::MenuSpec &menu : mote::menus()) {
        for (const mote::CommandId id : menu.items) {
            const mote::CommandSpec *spec = mote::findCommand(id);
            if (!spec)
                continue;
            for (const std::string &shortcut : spec->shortcuts) {
                NSString *text = [NSString stringWithUTF8String:shortcut.c_str()];
                if (MoteEventMatchesShortcut(event, text)) {
                    if (MoteKeyLogEnabled())
                        std::fprintf(stderr, "NATIVE key matched %s\n", shortcut.c_str());
                    [self performCommand:id];
                    return nil;
                }
            }
        }
    }
    return event;
}

- (void)performCommand:(mote::CommandId)command
{
    const mote::CommandSpec *spec = mote::findCommand(command);
    if (MoteKeyLogEnabled() && spec)
        std::fprintf(stderr, "NATIVE command %s\n", spec->title.c_str());

    switch (command) {
    case mote::CommandId::New:
        [self newDocument];
        return;
    case mote::CommandId::Open:
        [self openDocument];
        return;
    case mote::CommandId::Save:
        [self beginSaveAs:NO];
        return;
    case mote::CommandId::SaveAs:
        [self beginSaveAs:YES];
        return;
    case mote::CommandId::ExportHtml:
        _controller->requestExportHtml(self.displayName.UTF8String);
        return;
    case mote::CommandId::ExportPdf:
        if (_sourceOn) {
            [self showStatus:@"源码模式下不能导出 PDF，先退出源码模式"];
            return;
        }
        [self exportPdf];
        return;
    case mote::CommandId::Undo:
        _controller->undo();
        return;
    case mote::CommandId::Redo:
        _controller->redo();
        return;
    // 标准编辑动作交给响应链：WebKit 自己处理选区、剪贴板与页面 copy/cut/paste 事件
    // 例外：自建跨块选区时原生选区是折叠的，WebKit 会判成「没有可复制内容」而
    // 不派发 copy/cut 事件；此时改走页面算内容、外壳写剪贴板这条回路。
    case mote::CommandId::Cut:
        if (_controller->crossSelection()) {
            _controller->clipboardCommand("cut");
            return;
        }
        [self sendResponderAction:@selector(cut:)];
        return;
    case mote::CommandId::Copy:
        if (_controller->crossSelection()) {
            _controller->clipboardCommand("copy");
            return;
        }
        [self sendResponderAction:@selector(copy:)];
        return;
    case mote::CommandId::Paste:
        [self sendResponderAction:@selector(paste:)];
        return;
    case mote::CommandId::SelectAll:
        [self sendResponderAction:@selector(selectAll:)];
        return;
    case mote::CommandId::ToggleToc:
        _controller->toggleToc();
        return;
    case mote::CommandId::ToggleSource:
        _controller->toggleSource();
        return;
    case mote::CommandId::ToggleDark:
        _followSystem = NO;
        _darkMode = !_darkMode;
        [self applyTheme];
        return;
    case mote::CommandId::FollowSystem:
        _followSystem = YES;
        [self applyTheme];
        return;
    case mote::CommandId::ZoomIn:
        _controller->zoomBy(1);
        return;
    case mote::CommandId::ZoomOut:
        _controller->zoomBy(-1);
        return;
    case mote::CommandId::ZoomReset:
        _controller->resetZoom();
        return;
    default:
        break;
    }

    // 剩余的是格式命令：动作名由 core 命令表给出，前端统一解释
    if (spec && !spec->formatAction.empty()) {
        _controller->applyFormat(spec->formatAction);
        return;
    }
}

- (void)sendResponderAction:(SEL)action
{
    [NSApp sendAction:action to:nil from:nil];
}

- (void)applyViewState:(const mote::ViewState &)state
{
    _tocOn = state.toc;
    _sourceOn = state.source;
    [self updateMenuStates];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE view toc=%d source=%d zoom=%.2f\n", state.toc ? 1 : 0,
                     state.source ? 1 : 0, state.zoom);
    if (std::abs(state.zoom - _lastZoom) > 0.001) {
        _lastZoom = state.zoom;
        [self showStatus:[NSString stringWithFormat:@"缩放：%d%%", (int)lround(state.zoom * 100)]];
    }
}

- (void)updateMenuStates
{
    void (^setState)(mote::CommandId, BOOL) = ^(mote::CommandId id, BOOL on) {
        NSMenuItem *item = self.commandItems[@(static_cast<NSInteger>(id))];
        item.state = on ? NSControlStateValueOn : NSControlStateValueOff;
    };
    setState(mote::CommandId::ToggleToc, _tocOn);
    setState(mote::CommandId::ToggleSource, _sourceOn);
    setState(mote::CommandId::ToggleDark, _darkMode);
    setState(mote::CommandId::FollowSystem, _followSystem);

    NSMenuItem *pdf = self.commandItems[@(static_cast<NSInteger>(mote::CommandId::ExportPdf))];
    pdf.enabled = !_sourceOn;
}

#pragma mark - 主题

- (BOOL)systemIsDark
{
    NSAppearanceName name = [NSApp.effectiveAppearance
        bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
    return [name isEqualToString:NSAppearanceNameDarkAqua];
}

- (void)applyTheme
{
    if (_followSystem)
        _darkMode = [self systemIsDark];
    _controller->setTheme(_darkMode ? "dark" : "light");
    [self updateMenuStates];
}

#pragma mark - 文档

- (void)loadBuiltinSample
{
    NSURL *url = [[NSBundle mainBundle] URLForResource:@"welcome"
                                         withExtension:@"md"
                                          subdirectory:@"samples"];
    NSString *text = url
        ? [NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:NULL]
        : nil;
    self.lastText = text ?: @"# 欢迎\n\n没有找到内置示例文档。\n";
    self.filePath = nil;
    _controller->setMarkdown(self.lastText.UTF8String, "");
    [self updateWindowTitle];
}

- (NSString *)displayName
{
    return self.filePath.length > 0 ? self.filePath.lastPathComponent : @"未命名";
}

- (void)updateWindowTitle
{
    self.window.title = [NSString stringWithFormat:@"%@ - Mote", [self displayName]];
    self.window.documentEdited = _controller && _controller->dirty();
    if (self.filePath.length > 0)
        [self.window setRepresentedFilename:self.filePath];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE title=%s dirty=%d\n", self.window.title.UTF8String,
                     _controller && _controller->dirty() ? 1 : 0);
}

- (void)newDocument
{
    if (![self prepareForReplace:MoteAfterSaveNewDocument path:nil])
        return;
    [self startNewDocument];
}

- (void)startNewDocument
{
    self.filePath = nil;
    self.lastText = @"";
    self.saveAsRequested = NO;
    _controller->newDocument();
    [self updateWindowTitle];
    [self showStatus:@"已新建空白文档（未命名，保存时会询问位置）"];
}

- (void)openDocument
{
    if (![self prepareForReplace:MoteAfterSaveOpenDialog path:nil])
        return;
    NSString *dir = self.lastDir.length > 0 ? self.lastDir : NSHomeDirectory();
    NSString *path = MoteOpenMarkdownPanel(dir);
    if (path.length == 0)
        return;
    [self openPath:path];
}

- (void)openPath:(NSString *)path
{
    NSError *error = nil;
    NSString *text = [NSString stringWithContentsOfFile:path
                                               encoding:NSUTF8StringEncoding
                                                  error:&error];
    if (!text) {
        MoteAlert(@"无法打开",
                  [NSString stringWithFormat:@"读取文件失败：\n%@\n%@", path,
                                             error.localizedDescription ?: @""]);
        return;
    }
    if ([text hasPrefix:@"\uFEFF"])
        text = [text substringFromIndex:1];

    self.filePath = path;
    self.lastDir = path.stringByDeletingLastPathComponent;
    self.lastText = text;
    _controller->setMarkdown(text.UTF8String, self.lastDir.UTF8String);
    [self updateWindowTitle];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE open %s\n", path.UTF8String);
    [self showStatus:[NSString stringWithFormat:@"已打开：%@", path]];
}

- (void)openPathFromDrop:(const std::string &)path
{
    NSString *target = [NSString stringWithUTF8String:path.c_str()];
    if (target.length == 0)
        return;
    if ([self prepareForReplace:MoteAfterSaveOpenPath path:target])
        [self openPath:target];
}

- (void)acceptDroppedName:(const std::string &)name text:(const std::string &)text
{
    (void)name;
    // 拖入等同「打开另一份文档」：有未保存修改时先问，不能在用户不知情时覆盖。
    NSString *dropped = [NSString stringWithUTF8String:text.c_str()] ?: @"";
    if (![self prepareForReplace:MoteAfterSaveDropText path:nil text:dropped])
        return;
    [self loadDroppedText:text];
}

- (void)loadDroppedText:(const std::string &)text
{
    // WebKit 出于安全不暴露拖入文件的真实路径，只能作为「未命名」文档载入
    self.filePath = nil;
    NSString *content = [NSString stringWithUTF8String:text.c_str()] ?: @"";
    self.lastText = content;
    _controller->setMarkdown(text, "");
    [self updateWindowTitle];
    [self showStatus:@"已载入拖入的文档（未关联磁盘路径，保存时会询问位置）"];
}

- (void)beginSaveAs:(BOOL)saveAs
{
    self.saveAsRequested = saveAs;
    _controller->requestSnapshot();
}

- (void)exportPdf
{
    // 未命名文档没有目录：先另存为，保存完成后回到这里继续导出
    if (self.filePath.length == 0) {
        self.saveAsRequested = YES;
        self.afterSave = MoteAfterSaveExportPdf;
        _controller->requestSnapshot();
        return;
    }

    NSString *suggested = [self.filePath.stringByDeletingPathExtension
        stringByAppendingPathExtension:@"pdf"];
    const char *promptOnly = std::getenv("MOTE_PDF_PROMPT");
    if (promptOnly && *promptOnly) {
        std::fprintf(stderr, "PDF suggestion: %s\n", suggested.UTF8String);
        return;
    }
    const char *forced = std::getenv("MOTE_PDF_AS");
    NSString *path = forced && *forced
        ? [NSString stringWithUTF8String:forced]
        : MoteSavePanel(@"导出 PDF", suggested, @"pdf");
    if (path.length == 0)
        return;
    if (path.pathExtension.length == 0)
        path = [path stringByAppendingPathExtension:@"pdf"];

    [self showStatus:@"正在导出 PDF…"];
    _controller->requestExportPdf(path.UTF8String);
}

- (void)saveText:(const std::string &)text
{
    const BOOL wantsSaveAs = self.saveAsRequested;
    self.saveAsRequested = NO;

    NSString *content = [NSString stringWithUTF8String:text.c_str()] ?: @"";
    NSString *path = self.filePath;
    if (path.length == 0 || wantsSaveAs) {
        NSString *dir = self.lastDir.length > 0 ? self.lastDir : NSHomeDirectory();
        NSString *suggested = path.length > 0
            ? path
            : [dir stringByAppendingPathComponent:@"未命名.md"];
        // 自动化验证用：跳过保存面板
        const char *forced = std::getenv("MOTE_SAVE_AS");
        if (forced && *forced) {
            path = [NSString stringWithUTF8String:forced];
        } else {
            path = MoteSavePanel(@"另存为", suggested, @"md");
        }
        if (path.length == 0) {
            [self resetAfterSave];
            return;
        }
        if (path.pathExtension.length == 0)
            path = [path stringByAppendingPathExtension:@"md"];
    }

    if (![self writeText:content toPath:path]) {
        [self resetAfterSave];
        return;
    }

    self.filePath = path;
    self.lastDir = path.stringByDeletingLastPathComponent;
    self.lastText = content;
    _controller->notifySaved(text);
    // 另存为可能换了目录：图片落盘位置跟随新的 .md 路径
    _controller->setBaseDir(self.lastDir.UTF8String);
    [self updateWindowTitle];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE save %s bytes=%lu\n", path.UTF8String,
                     (unsigned long)[content lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
    [self showStatus:[NSString stringWithFormat:@"已保存：%@", path]];
    [self runAfterSave];
}

- (BOOL)writeText:(NSString *)text toPath:(NSString *)path
{
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    if (![data writeToFile:path options:NSDataWritingAtomic error:&error]) {
        MoteAlert(@"保存失败",
                  [NSString stringWithFormat:@"无法写入文件：\n%@\n%@", path,
                                             error.localizedDescription ?: @""]);
        return NO;
    }
    return YES;
}

- (BOOL)prepareForReplace:(MoteAfterSave)after path:(NSString *)path
{
    return [self prepareForReplace:after path:path text:nil];
}

- (BOOL)prepareForReplace:(MoteAfterSave)after path:(NSString *)path text:(NSString *)text
{
    if (!_controller->dirty())
        return YES;

    const MoteSaveChoice choice = MoteConfirmUnsaved([self displayName]);
    if (choice == MoteSaveChoiceCancel)
        return NO;
    if (choice == MoteSaveChoiceDiscard)
        return YES;

    self.afterSave = after;
    self.afterSavePath = path;
    self.afterSaveText = text;
    _controller->requestSnapshot();
    return NO;
}

- (void)runAfterSave
{
    const MoteAfterSave after = self.afterSave;
    NSString *path = self.afterSavePath;
    NSString *text = self.afterSaveText;
    [self resetAfterSave];

    switch (after) {
    case MoteAfterSaveOpenDialog:
        [self openDocument];
        break;
    case MoteAfterSaveOpenPath:
        if (path.length > 0)
            [self openPath:path];
        break;
    case MoteAfterSaveNewDocument:
        [self startNewDocument];
        break;
    case MoteAfterSaveClose:
        [self.window performClose:nil];
        break;
    case MoteAfterSaveTerminate:
        [NSApp terminate:nil];
        break;
    case MoteAfterSaveExportPdf:
        [self exportPdf];
        break;
    case MoteAfterSaveDropText:
        [self loadDroppedText:text.UTF8String ? std::string(text.UTF8String) : std::string()];
        break;
    case MoteAfterSaveNone:
        break;
    }
}

- (void)resetAfterSave
{
    self.afterSave = MoteAfterSaveNone;
    self.afterSavePath = nil;
    self.afterSaveText = nil;
}

- (BOOL)applicationShouldTerminate
{
    if (!_controller->dirty())
        return YES;

    const MoteSaveChoice choice = MoteConfirmUnsaved([self displayName]);
    if (choice == MoteSaveChoiceCancel)
        return NO;
    if (choice == MoteSaveChoiceDiscard)
        return YES;

    self.afterSave = MoteAfterSaveTerminate;
    _controller->requestSnapshot();
    return NO;
}

#pragma mark - NSWindowDelegate

- (BOOL)windowShouldClose:(NSWindow *)sender
{
    (void)sender;
    if (!_controller->dirty())
        return YES;

    const MoteSaveChoice choice = MoteConfirmUnsaved([self displayName]);
    if (choice == MoteSaveChoiceCancel)
        return NO;
    if (choice == MoteSaveChoiceDiscard)
        return YES;

    self.afterSave = MoteAfterSaveClose;
    _controller->requestSnapshot();
    return NO;
}

#pragma mark - 页面消息与脚本

- (void)handlePageMessage:(NSDictionary *)body
{
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:&error];
    if (!data)
        return;
    const std::string json(static_cast<const char *>(data.bytes), data.length);
    _controller->handleMessage(json);
}

- (void)evaluateScript:(const std::string &)script
{
    NSString *text = [NSString stringWithUTF8String:script.c_str()];
    if (text)
        [self.host evaluateJavaScript:text];
}

- (void)loadPageInDirectory:(const std::string &)directory
{
    NSString *dir = directory.empty() ? @"" : [NSString stringWithUTF8String:directory.c_str()];
    [self.host loadEditorPageInDirectory:dir ?: @""];
}

- (void)pageBecameReady
{
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE ready gen=%llu\n",
                     (unsigned long long)_controller->pageGeneration());
    // 状态栏移入页面：加上平台类后 #statusbar 才显示
    [self.host evaluateJavaScript:
        [NSString stringWithUTF8String:mote::js::enableStatusBar("mac").c_str()]];
    if (self.lastStatus.length > 0) {
        [self showStatus:self.lastStatus];
        self.window.subtitle = @"";
    }
    [self.host focusEditor];
    [self.host runPageDiagnostics];
    [self runDropProbeIfNeeded];
    [self runStartupCommandIfNeeded];
    [self updateWindowTitle];
}

// 诊断用（MOTE_COMMAND=exportPdf 等）：无法用键盘自动化触发菜单时，
// 页面就绪后按命令表执行一次指定命令。
- (void)runStartupCommandIfNeeded
{
    static BOOL done = NO;
    if (done)
        return;
    const char *raw = std::getenv("MOTE_COMMAND");
    if (!raw || !*raw)
        return;
    done = YES;

    NSString *name = [[[NSString stringWithUTF8String:raw]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        lowercaseString];
    const std::pair<const char *, mote::CommandId> table[] = {
        { "new", mote::CommandId::New },
        { "open", mote::CommandId::Open },
        { "save", mote::CommandId::Save },
        { "saveas", mote::CommandId::SaveAs },
        { "exporthtml", mote::CommandId::ExportHtml },
        { "exportpdf", mote::CommandId::ExportPdf },
        { "toggletoc", mote::CommandId::ToggleToc },
        { "togglesource", mote::CommandId::ToggleSource },
        { "toggledark", mote::CommandId::ToggleDark },
        { "followsystem", mote::CommandId::FollowSystem },
        { "zoomin", mote::CommandId::ZoomIn },
        { "zoomout", mote::CommandId::ZoomOut },
        { "zoomreset", mote::CommandId::ZoomReset },
    };
    mote::CommandId id = mote::CommandId::Separator;
    bool found = false;
    for (const auto &entry : table) {
        if ([name isEqualToString:[NSString stringWithUTF8String:entry.first]]) {
            id = entry.second;
            found = true;
            break;
        }
    }
    if (!found)
        return;

    __weak MoteMainWindow *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.7 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                       [weakSelf performCommand:id];
                   });
}

#pragma mark - 拖放

- (void)setupDropHandlers
{
    __weak MoteMainWindow *weakSelf = self;
    self.host.canAcceptFileDrop = ^BOOL(NSArray<NSString *> *paths) {
        MoteMainWindow *window = weakSelf;
        return window && window->_controller->acceptsNativeFileDrop(MotePathsToVector(paths));
    };
    self.host.performFileDrop = ^BOOL(NSArray<NSString *> *paths) {
        MoteMainWindow *window = weakSelf;
        if (!window)
            return NO;
        const std::vector<std::string> list = MotePathsToVector(paths);
        const bool handled = window->_controller->handleNativeFileDrop(list);
        if (MoteKeyLogEnabled()) {
            for (const std::string &path : list)
                std::fprintf(stderr, "NATIVE drop %s -> %d\n", path.c_str(), handled ? 1 : 0);
        }
        return handled;
    };
}

// 诊断用（MOTE_DROP=路径[:路径]）：自动化环境无法模拟 Finder 拖放，
// 页面就绪后把同一套拖放处理按时调用一次。
- (void)runDropProbeIfNeeded
{
    if (_dropProbeDone)
        return;
    const char *probe = std::getenv("MOTE_DROP");
    if (!probe || !*probe)
        return;
    _dropProbeDone = YES;

    NSString *text = [NSString stringWithUTF8String:probe];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSString *part in [text componentsSeparatedByString:@":"]) {
        if (part.length > 0)
            [paths addObject:part];
    }
    __weak MoteMainWindow *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.9 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                       [weakSelf performNativeDrop:paths];
                   });
}

- (BOOL)performNativeDrop:(NSArray<NSString *> *)paths
{
    return self.host.performFileDrop ? self.host.performFileDrop(paths) : NO;
}

- (void)showStatus:(NSString *)text
{
    if (text.length == 0)
        return;
    self.lastStatus = text;
    if (_controller && _controller->pageReady()) {
        self.window.subtitle = @"";
        NSString *script =
            [NSString stringWithUTF8String:mote::js::statusMessage(text.UTF8String).c_str()];
        [self.host evaluateJavaScript:script];
        return;
    }
    // 页面未就绪：先用窗口副标题兜底，ready 后再推进页面状态栏
    self.window.subtitle = text;
}

- (void)openExternalUrl:(const std::string &)rawUrl
{
    NSString *href = [[NSString stringWithUTF8String:rawUrl.c_str()]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (href.length == 0)
        return;
    if ([href hasPrefix:@"#"]) {
        [self showStatus:[NSString stringWithFormat:@"锚点链接 %@ 暂不支持（还没有标题锚点）", href]];
        return;
    }

    NSURL *url = [NSURL URLWithString:href];
    NSString *scheme = url.scheme.lowercaseString;
    if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]
        || [scheme isEqualToString:@"mailto"]) {
        if (![[NSWorkspace sharedWorkspace] openURL:url])
            [self showStatus:[NSString stringWithFormat:@"无法打开链接：%@", href]];
        return;
    }

    NSString *target = nil;
    if ([scheme isEqualToString:@"file"]) {
        target = url.path;
    } else if (scheme.length == 0) {
        NSString *decoded = href.stringByRemovingPercentEncoding ?: href;
        // 绝对路径（/Users/x.md）不能拼到 lastDir 后面，否则会变成 <lastDir>/Users/x.md
        if ([decoded hasPrefix:@"/"]) {
            target = decoded;
        } else {
            target = [self.lastDir stringByAppendingPathComponent:decoded];
        }
    } else {
        [self showStatus:[NSString stringWithFormat:@"不支持打开的链接类型：%@", href]];
        return;
    }

    if (target.length == 0 || ![[NSFileManager defaultManager] fileExistsAtPath:target]) {
        MoteAlert(@"链接目标不存在",
                  [NSString stringWithFormat:@"找不到链接指向的文件：\n%@", href]);
        return;
    }
    if (mote::isMarkdownPath(target.UTF8String)) {
        if ([self prepareForReplace:MoteAfterSaveOpenPath path:target])
            [self openPath:target];
        return;
    }
    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:target]];
}

- (void)htmlExportReady:(const std::string &)html
{
    NSString *content = [NSString stringWithUTF8String:html.c_str()] ?: @"";
    NSString *suggested = nil;
    if (self.filePath.length > 0) {
        suggested = [self.filePath.stringByDeletingPathExtension
            stringByAppendingPathExtension:@"html"];
    } else {
        NSString *dir = self.lastDir.length > 0 ? self.lastDir : NSHomeDirectory();
        suggested = [dir stringByAppendingPathComponent:@"未命名.html"];
    }

    const char *forced = std::getenv("MOTE_EXPORT_AS");
    NSString *path = forced && *forced
        ? [NSString stringWithUTF8String:forced]
        : MoteSavePanel(@"导出 HTML", suggested, @"html");
    if (path.length == 0)
        return;
    if (path.pathExtension.length == 0)
        path = [path stringByAppendingPathExtension:@"html"];

    int missing = 0;
    NSString *inlined = MoteInlineLocalImages(content, self.lastDir, &missing);
    NSData *data = [inlined dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    if (![data writeToFile:path options:NSDataWritingAtomic error:&error]) {
        MoteAlert(@"导出失败",
                  [NSString stringWithFormat:@"无法写入文件：\n%@\n%@", path,
                                             error.localizedDescription ?: @""]);
        return;
    }

    const double kb = static_cast<double>(data.length) / 1024.0;
    if (missing > 0) {
        [self showStatus:[NSString stringWithFormat:@"已导出 %@（%.0f KB），%d 张图片读取失败",
                                                   path, kb, missing]];
    } else {
        [self showStatus:[NSString stringWithFormat:@"已导出 %@（%.0f KB）", path, kb]];
    }
}

- (void)requestPdfExport:(const std::string &)path
{
    NSString *target = [NSString stringWithUTF8String:path.c_str()] ?: @"";
    __weak MoteMainWindow *weakSelf = self;
    [self.host exportPdfToPath:target
                    completion:^(BOOL ok, NSString *message) {
                      MoteMainWindow *window = weakSelf;
                      if (!window)
                          return;
                      if (ok) {
                          [window showStatus:
                              [NSString stringWithFormat:@"已导出到 %@", target]];
                          return;
                      }
                      NSString *reason = message.length > 0 ? message : @"导出失败";
                      [window showStatus:reason];
                      MoteAlert(@"导出失败", reason);
                    }];
}

- (void)pdfExportFailed:(const std::string &)message
{
    NSString *text = [NSString stringWithUTF8String:message.c_str()];
    [self showStatus:text ?: @"导出失败"];
}

@end
