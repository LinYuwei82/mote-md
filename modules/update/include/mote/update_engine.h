#pragma once

// 自动更新编排层：唯一一份「更新状态机」，mac 壳与 win 壳只实现平台适配器。
//
// 分层：
//   检测层（mote/update.h + mote/verify_signature.h）
//     清单解析、验签、版本比较、灰度、强制更新——纯策略，无状态。
//   编排层（本文件）
//     检查时机与节流、并发防重、验签→解析→判定统一顺序、
//     「稍后」跳过规则、提示文案（PromptSpec）生成、统一日志。
//   平台安装层（shell/mac/updater.mm、shell/win/updater_win.cpp）
//     网络、持久化、原生弹窗渲染、安装执行（Sparkle / 下载+SHA256+静默安装）。
//
// 历史教训：两端曾各写一份状态机，出现「win 判定前不验清单签名」等双胞胎偏差；
// 所有判定与文案逻辑只允许存在于本引擎，壳内不得复制。

#include <functional>
#include <string>
#include <ctime>

#include "mote/update.h"

namespace mote {

// 引擎注入的设置键（壳负责落到 NSUserDefaults / 注册表，值一律字符串化）
namespace update_keys {
inline constexpr const char *kLastCheckAt = "last_check_at";
inline constexpr const char *kSkippedVersion = "skipped_version";
inline constexpr const char *kInstallId = "install_id";
} // namespace update_keys

// 「发现新版本」弹窗的完整内容，由引擎生成，壳只做渲染。
struct PromptSpec {
    std::string title;        // 「发现新版本 X」/「必须更新到 X」
    std::string body;         // 多行中文正文（强制提示、当前版本、更新时间、包体大小、安装说明）
    std::string notes_url;    // 可空：查看完整更新说明链接
    bool force = false;       // 强制更新已生效：不给「稍后」
    bool allow_later = true;  // 是否显示「稍后」按钮（force 为 true 时为 false）
};

// 清单拉取：异步执行，结果必须投递回引擎所在线程再调 UpdateEngine::onManifest。
class ManifestFetcher {
public:
    virtual ~ManifestFetcher() = default;
    using Callback = std::function<void(int status, std::string body, std::string error)>;
    virtual void asyncGet(const std::string &url, Callback done) = 0;
};

// 键值持久化（字符串）。newInstallId 由平台用 CSPRNG 生成 32 位十六进制串，
// 失败返回空串（此时引擎跳过灰度，不阻断更新主流程）。
class SettingsStore {
public:
    virtual ~SettingsStore() = default;
    virtual std::string getString(const std::string &key) = 0;
    virtual void setString(const std::string &key, const std::string &value) = 0;
    virtual void clearString(const std::string &key) = 0;
    virtual std::string newInstallId() = 0;
};

// 更新 UI：alert 用于结果告知；prompt 渲染 PromptSpec 并返回用户选择。
class UpdateUi {
public:
    virtual ~UpdateUi() = default;
    enum class Choice { Install, Later };
    virtual void showAlert(const std::string &title, const std::string &body) = 0;
    virtual Choice showPrompt(const PromptSpec &spec) = 0;
};

// 平台安装链。preflight 在弹窗前调用：返回 false 时引擎用 ui 展示
// title/body 的引导提示（如 mac App Translocation），并跳过本次安装。
// install 在用户确认后调用；manifest_text 为已验签的原始清单 JSON，
// 供平台侧纵深防御（如 win 下载后复验）。
class PlatformInstaller {
public:
    virtual ~PlatformInstaller() = default;
    virtual bool preflight(std::string *title, std::string *body) = 0;
    // 本机实际会用的更新包字节数（mac=dmg；win=按安装形态选 setup/portable），0 表示未知
    virtual long long preferredArtifactSize(const UpdateManifest &manifest) = 0;
    virtual void install(const UpdateManifest &manifest, const std::string &manifest_text) = 0;
};

struct UpdateEngineConfig {
    UpdatePlatform platform = UpdatePlatform::Macos;
    std::string manifest_url;      // 清单地址（壳推导：SUFeedURL / 编译期常量 / 环境变量覆盖）
    std::string current_version;   // 本机版本，如 1.0.25
    std::string current_os;        // 本机系统版本，如 15.0 / 10.0
    std::string os_label;          // 提示文案用系统名："macOS" / "Windows"
    long long current_build = 0;   // 本机构建号；0 表示跳过 build 比较
    std::string install_note;      // 弹窗尾部的安装行为说明（平台语义不同）
    std::time_t check_interval = 24 * 60 * 60; // 后台检查节流间隔
    // 清单验签可插拔：默认走编译期内嵌公钥的 Ed25519 验签；单测注入假验签。
    std::function<bool(const std::string &text, std::string *error)> verifier;
};

// 更新状态机。非线程安全：所有方法（含 onManifest）必须在同一主线程调用。
// 生命周期必须长于在途 fetch（壳侧用进程级单例即可）。
class UpdateEngine {
public:
    using Logger = std::function<void(const std::string &line)>;

    UpdateEngine(UpdateEngineConfig config, ManifestFetcher &fetcher, SettingsStore &store,
                 UpdateUi &ui, PlatformInstaller &installer, Logger logger = {});

    // 定时入口（启动延迟后首次、之后周期性）：内含 last_check_at 节流。
    void tick(std::time_t now);

    // 菜单「检查更新…」：立即检查，无视节流与「稍后」记录，
    // 无论结果如何都给出明确提示。
    void checkNow(std::time_t now);

    // fetch 结果回流（主线程）。提示行为由触发来源（tick/checkNow）决定。
    void onManifest(int status, const std::string &body, const std::string &error);

    bool isChecking() const { return checking_; }

    // 包体大小人性化（引擎统一口径，PromptSpec 已内嵌结果，此函数供测试与复用）
    static std::string formatSize(long long bytes);

private:
    void startCheck(bool interactive);
    void handleFailure(bool interactive, const std::string &reason);
    void handleDecision(bool interactive, const UpdateManifest &manifest,
                        const std::string &manifest_text, std::time_t now);
    PromptSpec buildPrompt(const UpdateManifest &manifest, std::time_t now) const;
    std::string installId();
    void log(const char *format, ...) const;

    UpdateEngineConfig config_;
    ManifestFetcher &fetcher_;
    SettingsStore &store_;
    UpdateUi &ui_;
    PlatformInstaller &installer_;
    Logger logger_;
    bool checking_ = false;
    bool interactive_ = false; // 当前在途检查的触发来源
};

} // namespace mote
