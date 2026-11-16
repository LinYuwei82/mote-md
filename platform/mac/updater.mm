#import "updater.h"

#include "core/update.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

// 检查节奏由自研模块决定：启动后延迟一次，之后每 24 小时一次
const NSTimeInterval kCheckInterval = 24 * 60 * 60;
const NSTimeInterval kStartupDelay = 10.0;

// 后台检查网络请求超时：更新清单很小，卡住就不必等太久
const NSTimeInterval kRequestTimeout = 15.0;

NSString *const kLastCheckAtKey = @"MoteLastUpdateCheckAt";
NSString *const kSkippedVersionKey = @"MoteSkippedUpdateVersion";

bool MoteUpdateLogEnabled()
{
    return std::getenv("MOTE_KEYLOG") != nullptr;
}

void MoteUpdateLog(const char *format, ...) __attribute__((format(printf, 1, 2)));

void MoteUpdateLog(const char *format, ...)
{
    if (!MoteUpdateLogEnabled())
        return;
    va_list args;
    va_start(args, format);
    std::fprintf(stderr, "NATIVE update ");
    std::vfprintf(stderr, format, args);
    std::fprintf(stderr, "\n");
    va_end(args);
}

NSString *MoteCurrentVersion()
{
    NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    return version.length > 0 ? version : @"0.0.0";
}

// 传给 core 的系统版本：只要主次版本，14.0.1 → 14.0，够 min_os 比较用
NSString *MoteCurrentOsVersion()
{
    const NSOperatingSystemVersion version = NSProcessInfo.processInfo.operatingSystemVersion;
    return [NSString stringWithFormat:@"%ld.%ld", (long)version.majorVersion,
                                      (long)version.minorVersion];
}

// latest.json 与 appcast.xml 同目录，从 SUFeedURL 推导，避免再多一个配置项。
// MOTE_UPDATE_URL 可覆盖，用于本地联调。
NSURL *MoteManifestUrl()
{
    const char *override = std::getenv("MOTE_UPDATE_URL");
    if (override && *override)
        return [NSURL URLWithString:[NSString stringWithUTF8String:override]];

    NSString *feed = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"SUFeedURL"];
    if (feed.length == 0)
        return nil;
    NSURL *feedUrl = [NSURL URLWithString:feed];
    if (!feedUrl)
        return nil;
    return [[feedUrl URLByDeletingLastPathComponent] URLByAppendingPathComponent:@"latest.json"];
}

NSString *MoteHumanSize(long long bytes)
{
    if (bytes <= 0)
        return nil;
    return [NSByteCountFormatter stringFromByteCount:bytes
                                          countStyle:NSByteCountFormatterCountStyleFile];
}

// core 里的字符串都是 UTF-8，转 NSString 统一走这里，避免 %s 受系统编码影响
NSString *MoteString(const std::string &text)
{
    return [NSString stringWithUTF8String:text.c_str()] ?: @"";
}

// Gatekeeper 会把带 quarantine 的应用放到 AppTranslocation 只读路径运行，
// 此时 Sparkle 无法替换 bundle。提前识别，给出可执行的指引。
bool MoteIsTranslocated()
{
    return [NSBundle.mainBundle.bundlePath containsString:@"/AppTranslocation/"];
}

void MoteRunAlert(NSString *title, NSString *message)
{
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = message ?: @"";
    alert.alertStyle = NSAlertStyleInformational;
    [alert addButtonWithTitle:@"好"];
    [NSApp activateIgnoringOtherApps:YES];
    [alert runModal];
}

// 用户同意安装后交给 Sparkle：它自己读 appcast、验 EdDSA 签名、下载并替换。
// 没有 Sparkle.framework 时退回浏览器下载，保证仍能手动升级。
void MoteInstallWithSparkle(const mote::UpdateManifest &manifest)
{
    Class updaterClass = NSClassFromString(@"SUUpdater");
    if (updaterClass) {
        MoteUpdateLog("install via Sparkle version=%s", manifest.version.c_str());
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        // sharedUpdater 是单例；checkForUpdates: 的参数是菜单发送者，这里为 nil
        [[updaterClass performSelector:@selector(sharedUpdater)]
            performSelector:@selector(checkForUpdates:)
                 withObject:nil];
#pragma clang diagnostic pop
        return;
    }

    NSString *url = MoteString(manifest.url);
    if (url.length > 0)
        [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:url]];
    MoteRunAlert(@"未安装 Sparkle",
                 @"当前构建缺少 Sparkle.framework，已为你打开更新包下载地址，请手动安装。");
}

} // namespace

@implementation MoteUpdater {
    BOOL _started;
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

    __weak MoteUpdater *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStartupDelay * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     [weakSelf checkInBackground];
                   });

    [NSTimer scheduledTimerWithTimeInterval:kCheckInterval
                                    repeats:YES
                                      block:^(NSTimer *timer) {
                                        (void)timer;
                                        [weakSelf checkInBackground];
                                      }];
}

- (void)checkForUpdatesFromMenu:(id)sender
{
    (void)sender;
    [self checkWithInteractive:YES];
}

- (void)checkInBackground
{
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    const NSTimeInterval now = NSDate.date.timeIntervalSince1970;
    const NSTimeInterval last = [defaults doubleForKey:kLastCheckAtKey];
    if (last > 0 && now - last < kCheckInterval) {
        MoteUpdateLog("skip background check (last %.0fs ago)", now - last);
        return;
    }
    [self checkWithInteractive:NO];
}

- (void)checkWithInteractive:(BOOL)interactive
{
    NSURL *url = MoteManifestUrl();
    if (!url) {
        if (interactive)
            MoteRunAlert(@"无法检查更新", @"应用未配置更新地址（Info.plist 缺少 SUFeedURL）。");
        return;
    }

    MoteUpdateLog("GET %s", url.absoluteString.UTF8String);

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.timeoutInterval = kRequestTimeout;
    request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;

    __weak MoteUpdater *weakSelf = self;
    NSURLSessionDataTask *task = [NSURLSession.sharedSession
        dataTaskWithRequest:request
          completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            const NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                ? ((NSHTTPURLResponse *)response).statusCode
                : 0;
            NSData *body = data;
            NSError *netError = error;
            dispatch_async(dispatch_get_main_queue(), ^{
              [weakSelf handleResponse:body
                                status:status
                                 error:netError
                           interactive:interactive];
            });
          }];
    [task resume];
}

- (void)handleResponse:(NSData *)data
                status:(NSInteger)status
                 error:(NSError *)error
           interactive:(BOOL)interactive
{
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    [defaults setDouble:NSDate.date.timeIntervalSince1970 forKey:kLastCheckAtKey];

    if (error || status != 200 || data.length == 0) {
        NSString *reason = error.localizedDescription
            ?: [NSString stringWithFormat:@"服务器返回 HTTP %ld", (long)status];
        MoteUpdateLog("check failed: %s", reason.UTF8String);
        if (interactive)
            MoteRunAlert(@"检查更新失败", reason);
        return;
    }

    mote::UpdateManifest manifest;
    std::string parseError;
    const std::string text(static_cast<const char *>(data.bytes), data.length);
    if (!mote::parseUpdateManifest(text, manifest, &parseError)) {
        MoteUpdateLog("manifest invalid: %s", parseError.c_str());
        if (interactive)
            MoteRunAlert(@"检查更新失败",
                         [NSString stringWithFormat:@"更新清单格式错误：%@", MoteString(parseError)]);
        return;
    }

    const std::string currentVersion(MoteCurrentVersion().UTF8String);
    const std::string currentOs(MoteCurrentOsVersion().UTF8String);
    const mote::UpdateDecision decision =
        mote::decideUpdate(manifest, currentVersion, currentOs);
    MoteUpdateLog("current=%s latest=%s os=%s decision=%d", currentVersion.c_str(),
                  manifest.version.c_str(), currentOs.c_str(), static_cast<int>(decision));

    switch (decision) {
    case mote::UpdateDecision::Invalid:
        if (interactive)
            MoteRunAlert(@"检查更新失败", @"更新清单缺少版本号或下载地址。");
        return;
    case mote::UpdateDecision::UpToDate:
        if (interactive) {
            MoteRunAlert(@"已是最新版本",
                         [NSString stringWithFormat:@"当前版本 %@ 已经是最新版本。",
                                                    MoteCurrentVersion()]);
        }
        return;
    case mote::UpdateDecision::UnsupportedSystem:
        if (interactive) {
            MoteRunAlert(@"新版本不支持当前系统",
                         [NSString stringWithFormat:@"最新版本 %@ 需要 macOS %@ 或更高。",
                                                    MoteString(manifest.version),
                                                    MoteString(manifest.min_os)]);
        }
        return;
    case mote::UpdateDecision::Available:
        break;
    }

    // 后台检查不打扰用户：同一版本提醒过一次后，等下次发布再说
    NSString *skipped = [defaults stringForKey:kSkippedVersionKey];
    if (!interactive && [skipped isEqualToString:MoteString(manifest.version)]) {
        MoteUpdateLog("skip prompt for version=%s", manifest.version.c_str());
        return;
    }

    [self promptForManifest:manifest];
}

- (void)promptForManifest:(const mote::UpdateManifest &)manifest
{
    // 转译状态下交给 Sparkle 只会在安装阶段失败，先提示用户移动应用
    if (MoteIsTranslocated()) {
        MoteUpdateLog("translocated, cannot install version=%s", manifest.version.c_str());
        MoteRunAlert(@"需要先移动到“应用程序”",
                     [NSString stringWithFormat:
                                   @"发现新版本 %@，但 Mote 正在从系统临时位置运行，无法自动安装。\n\n"
                                    "请退出 Mote，把它拖到“应用程序”文件夹，重新打开后再检查更新。",
                                   MoteString(manifest.version)]);
        return;
    }

    NSMutableArray<NSString *> *details = [NSMutableArray array];
    if (!manifest.published_at.empty())
        [details addObject:[NSString stringWithFormat:@"发布时间：%@", MoteString(manifest.published_at)]];
    NSString *size = MoteHumanSize(manifest.size);
    if (size)
        [details addObject:[NSString stringWithFormat:@"安装包大小：%@", size]];

    NSString *message = [NSString stringWithFormat:@"当前版本 %@。", MoteCurrentVersion()];
    if (details.count > 0) {
        message = [message stringByAppendingFormat:@"\n%@", [details componentsJoinedByString:@"\n"]];
    }
    message = [message stringByAppendingString:@"\n\n安装过程会退出并重新打开 Mote。"];

    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = [NSString stringWithFormat:@"发现新版本 %@", MoteString(manifest.version)];
    alert.informativeText = message;
    alert.alertStyle = NSAlertStyleInformational;
    [alert addButtonWithTitle:@"下载并安装"];
    [alert addButtonWithTitle:@"稍后"];

    [NSApp activateIgnoringOtherApps:YES];
    const NSModalResponse choice = [alert runModal];
    if (choice != NSAlertFirstButtonReturn) {
        [NSUserDefaults.standardUserDefaults
            setObject:[NSString stringWithUTF8String:manifest.version.c_str()]
               forKey:kSkippedVersionKey];
        return;
    }

    [NSUserDefaults.standardUserDefaults removeObjectForKey:kSkippedVersionKey];
    MoteInstallWithSparkle(manifest);
}

@end
