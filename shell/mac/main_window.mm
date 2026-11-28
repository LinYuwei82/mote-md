#import "main_window.h"

#import "dialogs.h"
#import "html_export.h"
#import "menus.h"
#import "web_host_view.h"

#include "core/command_table.h"
#include "core/editor_controller.h"
#include "core/js_bridge.h"
#include "core/paths.h"
#include "core/perf.h"
#include "core/recent_files.h"
#include "mote/update_engine.h"

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

NSNotificationName const MoteWindowWillCloseNotification = @"MoteWindowWillClose";

@interface MoteMainWindow () <NSWindowDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) MoteWebHostView *host;
@property(nonatomic, copy) NSString *filePath;
@property(nonatomic, copy) NSString *lastDir;
@property(nonatomic, copy) NSString *lastText;
@property(nonatomic, copy) NSString *afterSavePath;
@property(nonatomic, copy) NSString *afterSaveText;
@property(nonatomic) MoteAfterSave afterSave;
@property(nonatomic) BOOL saveAsRequested;
@property(nonatomic) BOOL followSystem;
@property(nonatomic) BOOL darkMode;
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
- (NSString *)normalizedPathForCompare:(NSString *)path;
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

#include "main_window_host.inc"
#include "main_window_store.inc"

@implementation MoteMainWindow {
    std::unique_ptr<ShellHost> _shell;
    std::unique_ptr<mote::EditorController> _controller;
    BOOL _tocOn;
    BOOL _sourceOn;
    double _lastZoom;
}

#include "main_window_core.inc"
#include "main_window_commands.inc"
#include "main_window_view.inc"
#include "main_window_docs.inc"
#include "main_window_files.inc"
#include "main_window_window.inc"
#include "main_window_page.inc"
#include "main_window_drop.inc"
#include "main_window_links.inc"
#include "main_window_export.inc"
@end
