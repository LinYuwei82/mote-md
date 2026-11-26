#include "mote/update_engine.h"
#include "mote/verify_signature.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>

namespace mote {

namespace {

// 决策/失败提示的标题与正文（唯一一份，两端共用）
const char *kCheckFailedTitle = "检查更新失败";

} // namespace

UpdateEngine::UpdateEngine(UpdateEngineConfig config, ManifestFetcher &fetcher,
                           SettingsStore &store, UpdateUi &ui, PlatformInstaller &installer,
                           Logger logger)
    : config_(std::move(config)), fetcher_(fetcher), store_(store), ui_(ui),
      installer_(installer), logger_(std::move(logger))
{
}

void UpdateEngine::log(const char *format, ...) const
{
    if (!logger_)
        return;
    char buffer[512] = {};
    va_list args;
    va_start(args, format);
    std::vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    logger_(std::string("NATIVE update ") + buffer);
}

std::string UpdateEngine::formatSize(long long bytes)
{
    if (bytes <= 0)
        return std::string();
    char buffer[64] = {};
    const double mb = static_cast<double>(bytes) / (1024.0 * 1024.0);
    if (mb >= 1.0)
        std::snprintf(buffer, sizeof(buffer), "%.1f MB", mb);
    else
        std::snprintf(buffer, sizeof(buffer), "%.0f KB", mb * 1024.0);
    return buffer;
}

std::string UpdateEngine::installId()
{
    std::string id = store_.getString(update_keys::kInstallId);
    if (id.empty()) {
        id = store_.newInstallId();
        if (!id.empty())
            store_.setString(update_keys::kInstallId, id);
    }
    return id;
}

void UpdateEngine::tick(std::time_t now)
{
    if (checking_) {
        log("skip background check (check in flight)");
        return;
    }
    const std::string lastText = store_.getString(update_keys::kLastCheckAt);
    if (!lastText.empty()) {
        const long long last = std::strtoll(lastText.c_str(), nullptr, 10);
        if (last > 0 && static_cast<std::time_t>(last) <= now
            && now - static_cast<std::time_t>(last) < config_.check_interval) {
            log("skip background check (last %lld s ago)",
                static_cast<long long>(now - static_cast<std::time_t>(last)));
            return;
        }
    }
    startCheck(false);
}

void UpdateEngine::checkNow(std::time_t now)
{
    (void)now;
    startCheck(true);
}

void UpdateEngine::startCheck(bool interactive)
{
    if (checking_) {
        log(interactive ? "manual check ignored (check in flight)"
                        : "skip check (check in flight)");
        if (interactive)
            ui_.showAlert(kCheckFailedTitle, "已有一次更新检查正在进行，请稍候再试。");
        return;
    }
    if (config_.manifest_url.empty()) {
        log("no manifest url configured");
        if (interactive)
            ui_.showAlert(kCheckFailedTitle, "应用未配置更新地址。");
        return;
    }
    checking_ = true;
    interactive_ = interactive;
    log("GET %s", config_.manifest_url.c_str());
    fetcher_.asyncGet(config_.manifest_url,
                      [this](int status, std::string body, std::string error) {
                          onManifest(status, body, error);
                      });
}

void UpdateEngine::handleFailure(bool interactive, const std::string &reason)
{
    log("check failed: %s", reason.c_str());
    if (interactive)
        ui_.showAlert(kCheckFailedTitle, reason);
}

void UpdateEngine::onManifest(int status, const std::string &body, const std::string &error)
{
    if (!checking_) {
        log("ignore out-of-band manifest result");
        return;
    }
    checking_ = false;
    const bool interactive = interactive_;

    // 检查时间戳在拿到响应后写入（无论成败）：失败也节流，避免断网时每次定时器都打服务器
    store_.setString(update_keys::kLastCheckAt,
                     std::to_string(static_cast<long long>(std::time(nullptr))));

    if (!error.empty() || status != 200 || body.empty()) {
        const std::string reason =
            !error.empty() ? error
                           : "服务器返回 HTTP " + std::to_string(status);
        handleFailure(interactive, reason);
        return;
    }

    // 统一顺序：验签 → 解析 → 判定。历史上 win 先判定后验签，属双胞胎偏差。
    std::string verifyError;
    const bool verified = config_.verifier
        ? config_.verifier(body, &verifyError)
        : verifyUpdateManifestSignature(body, kUpdateManifestPublicKey, &verifyError);
    if (!verified) {
        log("manifest signature invalid: %s", verifyError.c_str());
        handleFailure(interactive, "更新清单验签失败，已放弃本次更新检查。");
        return;
    }

    UpdateManifest manifest;
    std::string parseError;
    if (!parseUpdateManifest(body, config_.platform, manifest, &parseError)) {
        log("manifest invalid: %s", parseError.c_str());
        handleFailure(interactive, "更新清单格式错误：" + parseError);
        return;
    }

    handleDecision(interactive, manifest, body, std::time(nullptr));
}

void UpdateEngine::handleDecision(bool interactive, const UpdateManifest &manifest,
                                  const std::string &manifest_text, std::time_t now)
{
    const std::string id = installId();
    const UpdateDecision decision =
        decideUpdate(manifest, config_.platform, config_.current_version, config_.current_os,
                     config_.current_build, id);
    log("current=%s latest=%s os=%s decision=%d", config_.current_version.c_str(),
        manifest.version.c_str(), config_.current_os.c_str(), static_cast<int>(decision));

    switch (decision) {
    case UpdateDecision::Invalid:
        handleFailure(interactive, "更新清单缺少版本号或下载地址。");
        return;
    case UpdateDecision::UpToDate:
        if (interactive)
            ui_.showAlert("已是最新版本",
                          "当前版本 " + config_.current_version + " 已经是最新版本。");
        return;
    case UpdateDecision::UnsupportedSystem: {
        if (!interactive)
            return;
        std::string body = "最新版本 " + manifest.version + " 不支持当前系统。";
        if (!manifest.min_os.empty())
            body = "最新版本 " + manifest.version + " 需要 " + config_.os_label + " "
                + manifest.min_os + " 或更高。";
        ui_.showAlert("新版本不支持当前系统", body);
        return;
    }
    case UpdateDecision::RolloutHold:
        log("rollout hold: version=%s percent=%d", manifest.version.c_str(),
            manifest.rollout_percent);
        if (interactive)
            ui_.showAlert("暂无可用更新",
                          "新版本 " + manifest.version + " 正在分批推送中，请稍后再试。");
        return;
    case UpdateDecision::Available:
        break;
    }

    const bool force = mandatoryActive(manifest, now);
    // 后台检查不打扰用户：同一版本点过「稍后」后，等下次发布再说；
    // 强制更新到期后不受「稍后」记录限制，每次检查都要提示（截止前仍可稍后）
    if (!interactive && !force
        && store_.getString(update_keys::kSkippedVersion) == manifest.version) {
        log("skip prompt for version=%s", manifest.version.c_str());
        return;
    }

    std::string preTitle, preBody;
    if (!installer_.preflight(&preTitle, &preBody)) {
        log("preflight blocked: %s", preTitle.c_str());
        ui_.showAlert(preTitle, preBody);
        return;
    }

    const PromptSpec spec = buildPrompt(manifest, now);
    if (ui_.showPrompt(spec) == UpdateUi::Choice::Later) {
        store_.setString(update_keys::kSkippedVersion, manifest.version);
        return;
    }
    store_.clearString(update_keys::kSkippedVersion);
    installer_.install(manifest, manifest_text);
}

PromptSpec UpdateEngine::buildPrompt(const UpdateManifest &manifest, std::time_t now) const
{
    const bool force = mandatoryActive(manifest, now);
    PromptSpec spec;
    spec.title = (force ? "必须更新到 " : "发现新版本 ") + manifest.version;
    spec.notes_url = manifest.notes_url;
    spec.force = force;
    spec.allow_later = !force;

    std::string body;
    if (manifest.mandatory) {
        // 强制更新：原因始终显示；期限在截止前提示「到期后不能跳过」，到期后直接强制
        body += force ? "当前版本必须升级。" : "该版本为强制更新。";
        const std::string reason = mandatoryReasonLabel(manifest.mandatory_reason);
        if (!reason.empty())
            body += "原因：" + reason + "。";
        if (!manifest.mandatory_deadline.empty()) {
            body += force
                ? "\n已到截止时间（" + manifest.mandatory_deadline + "），无法跳过。"
                : "\n请在 " + manifest.mandatory_deadline + " 前完成升级，到期后将无法跳过。";
        }
        body += "\n";
    }
    body += "当前版本 " + config_.current_version + "。";
    if (!manifest.updated_at.empty())
        body += "\n更新时间：" + manifest.updated_at;
    const std::string size = formatSize(installer_.preferredArtifactSize(manifest));
    if (!size.empty())
        body += "\n安装包大小：" + size;
    if (!config_.install_note.empty())
        body += "\n\n" + config_.install_note;
    spec.body = body;
    return spec;
}

} // namespace mote
