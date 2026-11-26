#import "updater.h"

// macOS 更新适配器：只实现「网络 / 持久化 / 原生弹窗 / Sparkle 安装」四件事，
// 状态机（时机、节流、验签→解析→判定、跳过规则、文案）全部在 mote::UpdateEngine，
// 与 Windows 共用同一份，见 modules/update/include/mote/update_engine.h。

#include "mote/update_engine.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>

#if __has_include(<Sparkle/Sparkle.h>)
#import <Sparkle/Sparkle.h>
#define MOTE_HAS_SPARKLE 1
#else
#define MOTE_HAS_SPARKLE 0
#endif

namespace {

const NSTimeInterval kStartupDelay = 10.0;
const NSTimeInterval kCheckInterval = 24 * 60 * 60;
const NSTimeInterval kRequestTimeout = 15.0;

// 沿用旧版 NSUserDefaults 键名，升级后不丢「稍后」记录与灰度分桶标识
NSString *const kLastCheckAtKey = @"MoteLastUpdateCheckAt";
NSString *const kSkippedVersionKey = @"MoteSkippedUpdateVersion";
NSString *const kInstallIdKey = @"MoteInstallId";

bool LogEnabled() { return std::getenv("MOTE_KEYLOG") != nullptr; }

void EngineLog(const std::string &line)
{
    if (LogEnabled())
        std::fprintf(stderr, "%s\n", line.c_str());
}

void ShellLog(const char *format, ...) __attribute__((format(printf, 1, 2)));
void ShellLog(const char *format, ...)
{
    if (!LogEnabled())
        return;
    va_list args;
    va_start(args, format);
    std::fprintf(stderr, "NATIVE update ");
    std::vfprintf(stderr, format, args);
    std::fprintf(stderr, "\n");
    va_end(args);
}

NSString *ToStr(const std::string &text)
{
    return [NSString stringWithUTF8String:text.c_str()] ?: @"";
}
std::string FromStr(NSString *text) { return text ? std::string(text.UTF8String) : std::string(); }

// ---- 四个平台适配器 ----

class MacFetcher : public mote::ManifestFetcher {
public:
    void asyncGet(const std::string &url, Callback done) override
    {
        NSURL *nsUrl = [NSURL URLWithString:ToStr(url)];
        if (!nsUrl) {
            if (done)
                done(0, "", "更新地址不合法");
            return;
        }
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:nsUrl];
        request.timeoutInterval = kRequestTimeout;
        request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
        NSURLSessionDataTask *task = [NSURLSession.sharedSession
            dataTaskWithRequest:request
              completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                const NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                    ? ((NSHTTPURLResponse *)response).statusCode
                    : 0;
                const std::string body(data ? (const char *)data.bytes : "",
                                       data ? data.length : 0);
                const std::string reason =
                    error ? FromStr(error.localizedDescription) : std::string();
                // 引擎要求结果回到主线程
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (done)
                        done((int)status, body, reason);
                });
              }];
        [task resume];
    }
};

class MacStore : public mote::SettingsStore {
public:
    std::string getString(const std::string &key) override
    {
        return FromStr([NSUserDefaults.standardUserDefaults stringForKey:DefaultKey(key)]);
    }
    void setString(const std::string &key, const std::string &value) override
    {
        [NSUserDefaults.standardUserDefaults setObject:ToStr(value) forKey:DefaultKey(key)];
    }
    void clearString(const std::string &key) override
    {
        [NSUserDefaults.standardUserDefaults removeObjectForKey:DefaultKey(key)];
    }
    std::string newInstallId() override { return FromStr(NSUUID.UUID.UUIDString); }

private:
    static NSString *DefaultKey(const std::string &key)
    {
        if (key == mote::update_keys::kLastCheckAt)
            return kLastCheckAtKey;
        if (key == mote::update_keys::kSkippedVersion)
            return kSkippedVersionKey;
        return ToStr("Mote" + key);
    }
};

class MacUi : public mote::UpdateUi {
public:
    void showAlert(const std::string &title, const std::string &body) override
    {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = ToStr(title);
        alert.informativeText = ToStr(body);
        alert.alertStyle = NSAlertStyleInformational;
        [alert addButtonWithTitle:@"好"];
        [NSApp activateIgnoringOtherApps:YES];
        [alert runModal];
    }

    Choice showPrompt(const mote::PromptSpec &spec) override
    {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = ToStr(spec.title);
        alert.informativeText = ToStr(spec.body);
        alert.alertStyle = spec.force ? NSAlertStyleCritical : NSAlertStyleInformational;
        [alert addButtonWithTitle:spec.force ? @"立即更新" : @"下载并安装"];
        if (spec.allow_later)
            [alert addButtonWithTitle:@"稍后"];

        if (!spec.notes_url.empty()) {
            NSURL *notesUrl = [NSURL URLWithString:ToStr(spec.notes_url)];
            if (notesUrl) {
                NSString *linkText = @"查看完整更新说明…";
                NSMutableAttributedString *attr =
                    [[NSMutableAttributedString alloc] initWithString:linkText];
                [attr addAttribute:NSLinkAttributeName value:notesUrl
                            range:NSMakeRange(0, linkText.length)];
                [attr addAttribute:NSFontAttributeName
                            value:[NSFont systemFontOfSize:[NSFont smallSystemFontSize]]
                            range:NSMakeRange(0, linkText.length)];
                NSTextField *link = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 240, 16)];
                [link setEditable:NO];
                [link setSelectable:YES];
                link.allowsEditingTextAttributes = YES;
                link.drawsBackground = NO;
                link.bordered = NO;
                link.attributedStringValue = attr;
                alert.accessoryView = link;
            }
        }

        [NSApp activateIgnoringOtherApps:YES];
        return [alert runModal] == NSAlertFirstButtonReturn ? Choice::Install : Choice::Later;
    }
};

class MacInstaller : public mote::PlatformInstaller {
public:
    std::function<void()> triggerSparkle; // 由 MoteUpdater 注入

    bool preflight(std::string *title, std::string *body) override
    {
        // Gatekeeper 会把带 quarantine 的应用放到 AppTranslocation 只读路径运行，
        // 此时 Sparkle 无法替换 bundle。提前识别，给出可执行的指引。
        if ([NSBundle.mainBundle.bundlePath containsString:@"/AppTranslocation/"]) {
            *title = "需要先移动到“应用程序”";
            *body = "Mote 正在从系统临时位置运行，无法自动安装。\n\n"
                    "请退出 Mote，把它拖到“应用程序”文件夹，重新打开后再检查更新。";
            return false;
        }
        return true;
    }

    long long preferredArtifactSize(const mote::UpdateManifest &manifest) override
    {
        return manifest.dmg.size;
    }

    void install(const mote::UpdateManifest &manifest, const std::string &) override
    {
#if MOTE_HAS_SPARKLE
        ShellLog("install via Sparkle version=%s", manifest.version.c_str());
        if (triggerSparkle)
            triggerSparkle();
#else
        ShellLog("Sparkle 未链接，退回浏览器下载 version=%s", manifest.version.c_str());
        NSString *url = ToStr(manifest.dmg.url);
        if (url.length > 0)
            [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:url]];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"未安装 Sparkle";
        alert.informativeText = @"当前构建缺少 Sparkle.framework，已为你打开更新包下载地址，请手动安装。";
        [alert addButtonWithTitle:@"好"];
        [alert runModal];
#endif
    }
};

// 清单地址：MOTE_UPDATE_URL 覆盖（本地联调），否则从 SUFeedURL 推导同目录 manifest.json
std::string ResolveManifestUrl()
{
    const char *overrideUrl = std::getenv("MOTE_UPDATE_URL");
    if (overrideUrl && *overrideUrl)
        return overrideUrl;
    NSString *feed = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"SUFeedURL"];
    if (feed.length == 0)
        return std::string();
    NSURL *feedUrl = [NSURL URLWithString:feed];
    if (!feedUrl)
        return std::string();
    return FromStr([[feedUrl URLByDeletingLastPathComponent]
        URLByAppendingPathComponent:@"manifest.json"].absoluteString);
}

} // namespace

#if MOTE_HAS_SPARKLE
@interface MoteUpdater () <SPUUpdaterDelegate>
@end
#endif

@implementation MoteUpdater {
    BOOL _started;
    std::unique_ptr<MacFetcher> _fetcher;
    std::unique_ptr<MacStore> _store;
    std::unique_ptr<MacUi> _ui;
    std::unique_ptr<MacInstaller> _installer;
    std::unique_ptr<mote::UpdateEngine> _engine;
#if MOTE_HAS_SPARKLE
    SPUStandardUpdaterController *_sparkleController;
#endif
}

+ (instancetype)sharedUpdater
{
    static MoteUpdater *shared;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      shared = [[MoteUpdater alloc] init];
    });
    return shared;
}

- (void)start
{
    if (_started)
        return;
    _started = YES;

    if (!_engine)
        [self buildEngine];

    __weak MoteUpdater *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStartupDelay * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     [weakSelf tick];
                   });
    [NSTimer scheduledTimerWithTimeInterval:kCheckInterval
                                    repeats:YES
                                      block:^(NSTimer *timer) {
                                        (void)timer;
                                        [weakSelf tick];
                                      }];
}

- (void)buildEngine
{
    _fetcher = std::make_unique<MacFetcher>();
    _store = std::make_unique<MacStore>();
    _ui = std::make_unique<MacUi>();
    _installer = std::make_unique<MacInstaller>();
    _installer->triggerSparkle = [self] {
        [[[self sparkleController] updater] checkForUpdates];
    };

    mote::UpdateEngineConfig config;
    config.platform = mote::UpdatePlatform::Macos;
    config.manifest_url = ResolveManifestUrl();
    NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    config.current_version = version.length > 0 ? version.UTF8String : "0.0.0";
    const NSOperatingSystemVersion os = NSProcessInfo.processInfo.operatingSystemVersion;
    config.current_os = [NSString stringWithFormat:@"%ld.%ld", (long)os.majorVersion,
                                                    (long)os.minorVersion].UTF8String;
    config.os_label = "macOS";
    config.current_build = MOTE_BUILD;
    config.install_note = "安装过程会退出并重新打开 Mote。";
    _engine = std::make_unique<mote::UpdateEngine>(
        std::move(config), *_fetcher, *_store, *_ui, *_installer, EngineLog);
}

- (void)tick
{
    _engine->tick(std::time(nullptr));
}

- (void)checkForUpdatesFromMenu:(id)sender
{
    (void)sender;
    if (!_engine)
        [self buildEngine];
    _engine->checkNow(std::time(nullptr));
}

#if MOTE_HAS_SPARKLE
- (SPUStandardUpdaterController *)sparkleController
{
    if (_sparkleController == nil) {
        _sparkleController =
            [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES
                                                        updaterDelegate:self
                                                     userDriverDelegate:nil];
    }
    return _sparkleController;
}

// 更新 UI 由自研清单链路负责，Sparkle 的默认弹窗全部静音，
// 它只负责下载、验签与替换。
- (void)updater:(SPUUpdater *)updater didNotFindUpdate:(NSError *)error
{
    (void)updater;
    (void)error;
}

- (void)updaterUserDidCancel:(SPUUpdater *)updater error:(NSError *)error
{
    (void)updater;
    (void)error;
}

- (void)updater:(SPUUpdater *)updater
    didFinishUpdateCycleForUpdate:(SPUStandardUpdaterController *)updaterController
                            error:(NSError *)error
{
    (void)updater;
    (void)updaterController;
    (void)error;
}
#endif

@end
