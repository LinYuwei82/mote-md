#import "updater.h"

#include "mote/update.h"
#include "mote/verify_signature.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>

// Sparkle 2（与小兔 / DevCard 同一套接法）：客户端只用它做下载、验签与替换，
// 「有没有新版本」由下面的自研 manifest 检查决定，不用 Sparkle 自己的 UI。
// 未链接 Sparkle 的构建（本地开发）保留浏览器下载兜底。
#if __has_include(<Sparkle/Sparkle.h>)
#import <Sparkle/Sparkle.h>
#define MOTE_HAS_SPARKLE 1
#else
#define MOTE_HAS_SPARKLE 0
#endif

namespace {

// 检查节奏由自研模块决定：启动后延迟一次，之后每 24 小时一次
const NSTimeInterval kCheckInterval = 24 * 60 * 60;
const NSTimeInterval kStartupDelay = 10.0;

// 后台检查网络请求超时：更新清单很小，卡住就不必等太久
const NSTimeInterval kRequestTimeout = 15.0;

NSString *const kLastCheckAtKey = @"MoteLastUpdateCheckAt";
NSString *const kSkippedVersionKey = @"MoteSkippedUpdateVersion";
// 灰度分桶用的安装实例标识：首次生成后长期复用，保证同一台机器落在同一桶
NSString *const kInstallIdKey = @"MoteInstallId";

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

// 安装实例标识（灰度分桶用）：首次生成 UUID 后写入 NSUserDefaults 长期复用。
NSString *MoteInstallId()
{
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    NSString *identifier = [defaults stringForKey:kInstallIdKey];
    if (identifier.length == 0) {
        identifier = NSUUID.UUID.UUIDString;
        [defaults setObject:identifier forKey:kInstallIdKey];
    }
    return identifier;
}

// manifest.json（v2 统一清单）与 appcast.xml 同目录，从 SUFeedURL 推导，
// 避免再多一个配置项。MOTE_UPDATE_URL 可覆盖，用于本地联调。
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
    return [[feedUrl URLByDeletingLastPathComponent] URLByAppendingPathComponent:@"manifest.json"];
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

} // namespace

#if MOTE_HAS_SPARKLE
@interface MoteUpdater () <SPUUpdaterDelegate>
@end
#endif

@implementation MoteUpdater {
    BOOL _started;
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

    const std::string text(static_cast<const char *>(data.bytes), data.length);

    // 先验清单 Ed25519 签名：公钥编译进客户端，签名不对说明清单被篡改或非官方发布
    std::string verifyError;
    if (!mote::verifyUpdateManifestSignature(text, mote::kUpdateManifestPublicKey, &verifyError)) {
        MoteUpdateLog("manifest signature invalid: %s", verifyError.c_str());
        if (interactive)
            MoteRunAlert(@"检查更新失败", @"更新清单验签失败，已放弃本次更新检查。");
        return;
    }

    mote::UpdateManifest manifest;
    std::string parseError;
    if (!mote::parseUpdateManifest(text, mote::UpdatePlatform::Macos, manifest, &parseError)) {
        MoteUpdateLog("manifest invalid: %s", parseError.c_str());
        if (interactive)
            MoteRunAlert(@"检查更新失败",
                         [NSString stringWithFormat:@"更新清单格式错误：%@", MoteString(parseError)]);
        return;
    }

    const std::string currentVersion(MoteCurrentVersion().UTF8String);
    const std::string currentOs(MoteCurrentOsVersion().UTF8String);
    const std::string installId(MoteInstallId().UTF8String);
    // 本机构建号用编译期内嵌的 MOTE_BUILD（与 Info.plist 的 CFBundleVersion 同源），
    // 同版本重发时靠它区分，避免装完仍反复提示同一版本
    const mote::UpdateDecision decision = mote::decideUpdate(
        manifest, mote::UpdatePlatform::Macos, currentVersion, currentOs, MOTE_BUILD, installId);
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
    case mote::UpdateDecision::RolloutHold:
        // 灰度分批：后台静默等待下一轮，用户主动检查时说明原因
        MoteUpdateLog("rollout hold: version=%s percent=%d", manifest.version.c_str(),
                      manifest.rollout_percent);
        if (interactive) {
            MoteRunAlert(@"暂无可用更新",
                         [NSString stringWithFormat:@"新版本 %@ 正在分批推送中，请稍后再试。",
                                                    MoteString(manifest.version)]);
        }
        return;
    case mote::UpdateDecision::Available:
        break;
    }

    // 后台检查不打扰用户：同一版本提醒过一次后，等下次发布再说；
    // 强制更新到期后不受「稍后」记录限制，每次检查都要提示（截止前仍可稍后）
    NSString *skipped = [defaults stringForKey:kSkippedVersionKey];
    if (!interactive && !mote::mandatoryActive(manifest, std::time(nullptr))
        && [skipped isEqualToString:MoteString(manifest.version)]) {
        MoteUpdateLog("skip prompt for version=%s", manifest.version.c_str());
        return;
    }

    [self promptForManifest:manifest];
}

- (void)promptForManifest:(const mote::UpdateManifest &)manifest
{
    // App Translocation 隔离路径下交给 Sparkle 只会在安装阶段失败，先提示用户移动应用
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
    if (!manifest.updated_at.empty())
        [details addObject:[NSString stringWithFormat:@"更新时间：%@", MoteString(manifest.updated_at)]];
    NSString *size = MoteHumanSize(manifest.dmg.size);
    if (size)
        [details addObject:[NSString stringWithFormat:@"安装包大小：%@", size]];

    NSString *message = [NSString stringWithFormat:@"当前版本 %@。", MoteCurrentVersion()];
    if (details.count > 0) {
        message = [message stringByAppendingFormat:@"\n%@", [details componentsJoinedByString:@"\n"]];
    }
    const bool force = mote::mandatoryActive(manifest, std::time(nullptr));
    if (manifest.mandatory) {
        // 强制更新：原因始终显示；期限在截止前提示「到期后不能跳过」，到期后直接强制
        NSMutableString *notice = [NSMutableString stringWithString:
            force ? @"当前版本必须升级。" : @"该版本为强制更新。"];
        NSString *reason = MoteString(mote::mandatoryReasonLabel(manifest.mandatory_reason));
        if (reason.length > 0)
            [notice appendFormat:@"原因：%@。", reason];
        if (!manifest.mandatory_deadline.empty()) {
            if (force) {
                [notice appendFormat:@"已到截止时间（%@），无法跳过。",
                                     MoteString(manifest.mandatory_deadline)];
            } else {
                [notice appendFormat:@"请在 %@ 前完成升级，到期后将无法跳过。",
                                     MoteString(manifest.mandatory_deadline)];
            }
        }
        message = [notice stringByAppendingFormat:@"\n\n%@", message];
    }
    message = [message stringByAppendingString:@"\n\n安装过程会退出并重新打开 Mote。"];

    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = force
        ? [NSString stringWithFormat:@"必须更新到 %@", MoteString(manifest.version)]
        : [NSString stringWithFormat:@"发现新版本 %@", MoteString(manifest.version)];
    alert.informativeText = message;
    alert.alertStyle = force ? NSAlertStyleCritical : NSAlertStyleInformational;
    [alert addButtonWithTitle:force ? @"立即更新" : @"下载并安装"];
    if (!force)
        [alert addButtonWithTitle:@"稍后"];

    // notes_url 非空时加一行可点击的「查看完整更新说明…」链接
    if (!manifest.notes_url.empty()) {
        NSURL *notesUrl = [NSURL URLWithString:MoteString(manifest.notes_url)];
        if (notesUrl) {
            NSString *linkText = @"查看完整更新说明…";
            NSMutableAttributedString *attr =
                [[NSMutableAttributedString alloc] initWithString:linkText];
            [attr addAttribute:NSLinkAttributeName value:notesUrl
                        range:NSMakeRange(0, linkText.length)];
            [attr addAttribute:NSFontAttributeName value:[NSFont systemFontOfSize:[NSFont smallSystemFontSize]]
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
    const NSModalResponse choice = [alert runModal];
    if (!force && choice != NSAlertFirstButtonReturn) {
        [NSUserDefaults.standardUserDefaults
            setObject:[NSString stringWithUTF8String:manifest.version.c_str()]
               forKey:kSkippedVersionKey];
        return;
    }

    [NSUserDefaults.standardUserDefaults removeObjectForKey:kSkippedVersionKey];
    [self installWithManifest:manifest];
}

- (void)installWithManifest:(const mote::UpdateManifest &)manifest
{
#if MOTE_HAS_SPARKLE
    // 清单检查已经确认有新版本，这里只让 Sparkle 走 appcast → 验签 → 下载 → 替换
    MoteUpdateLog("install via Sparkle version=%s", manifest.version.c_str());
    [[[self sparkleController] updater] checkForUpdates];
#else
    MoteUpdateLog("Sparkle 未链接，退回浏览器下载 version=%s", manifest.version.c_str());
    NSString *url = MoteString(manifest.dmg.url);
    if (url.length > 0)
        [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:url]];
    MoteRunAlert(@"未安装 Sparkle",
                 @"当前构建缺少 Sparkle.framework，已为你打开更新包下载地址，请手动安装。");
#endif
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

// 与小兔 / DevCard 一致：更新 UI 由自研清单链路负责，Sparkle 的默认弹窗全部静音，
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
