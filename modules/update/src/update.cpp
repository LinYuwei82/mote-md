#include "mote/update.h"

#include "core/json.h"
#include "mote/sha256.h"

#include <algorithm>
#include <cctype>
#include <limits>
#include <vector>

namespace mote {

namespace {

// 只取每段前导数字：0.3.5-beta 里的 5-beta 视为 5，缺失段补 0。
// 每段超过 18 位就按饱和值处理，避免 long long 溢出（有符号整数溢出是 UB）。
std::vector<long long> versionSegments(std::string_view text)
{
    if (!text.empty() && (text.front() == 'v' || text.front() == 'V'))
        text.remove_prefix(1);

    std::vector<long long> segments;
    std::size_t pos = 0;
    while (pos <= text.size()) {
        const std::size_t dot = text.find('.', pos);
        const std::string_view segment =
            text.substr(pos, dot == std::string_view::npos ? std::string_view::npos : dot - pos);
        long long value = 0;
        bool hasDigit = false;
        bool saturated = false;
        for (const char c : segment) {
            if (!std::isdigit(static_cast<unsigned char>(c)))
                break;
            hasDigit = true;
            if (saturated)
                continue;
            constexpr long long kMaxDiv10 = std::numeric_limits<long long>::max() / 10;
            const int digit = c - '0';
            if (value > kMaxDiv10 || (value == kMaxDiv10 && digit > 7)) {
                value = std::numeric_limits<long long>::max();
                saturated = true;
                continue;
            }
            value = value * 10 + digit;
        }
        segments.push_back(hasDigit ? value : 0);
        if (dot == std::string_view::npos)
            break;
        pos = dot + 1;
    }
    return segments;
}

void setError(std::string *error, const char *message)
{
    if (error)
        *error = message;
}

// 解析一个已知 artifacts key（dmg / setup / portable）。缺席的 key 保持空，
// 是否必填由调用方按平台规则判断；未知 key 由调用方根本不来问，天然忽略。
bool parseArtifact(const JsonValue &artifacts, std::string_view key, UpdateArtifact *out,
                   std::string *error)
{
    const JsonValue *entry = artifacts.find(key);
    if (!entry || !entry->isObject())
        return true;

    out->url = entry->stringAt("url");
    out->sha256 = entry->stringAt("sha256");
    const double size = entry->numberAt("size", 0.0);
    if (size < 0.0) {
        setError(error, "更新清单的 size 不能为负数");
        return false;
    }
    out->size = static_cast<long long>(size);
    return true;
}

} // namespace

bool parseUpdateManifest(std::string_view text, UpdatePlatform platform, UpdateManifest &out,
                         std::string *error)
{
    out = UpdateManifest{};

    JsonValue root;
    if (!parseJson(text, root) || !root.isObject()) {
        setError(error, "更新清单不是合法的 JSON 对象");
        return false;
    }

    // 顶层只取展示用的 updated_at；manifest_version/product/channel/key_id 由
    // 验签层与发布端约束，这里不重复校验。
    out.updated_at = root.stringAt("updated_at");

    // 只取自己平台段：另一平台与一切未知字段一律忽略（保证未来可扩展）
    const JsonValue *platforms = root.find("platforms");
    if (!platforms || !platforms->isObject()) {
        setError(error, "更新清单缺少 platforms");
        return false;
    }
    const char *platformKey = platform == UpdatePlatform::Macos ? "macos" : "windows";
    const JsonValue *section = platforms->find(platformKey);
    if (!section || !section->isObject()) {
        setError(error, platform == UpdatePlatform::Macos ? "更新清单缺少 macos 平台"
                                                          : "更新清单缺少 windows 平台");
        return false;
    }

    out.version = section->stringAt("version");
    if (out.version.empty()) {
        setError(error, "更新清单缺少 version");
        return false;
    }
    const double build = section->numberAt("build", 0.0);
    if (build < 0.0) {
        setError(error, "更新清单的 build 不能为负数");
        return false;
    }
    out.build = static_cast<long long>(build);
    out.min_os = section->stringAt("min_os");
    out.notes_url = section->stringAt("notes_url");

    // 灰度：缺省全量；越界值按边界截断，宁可全量也不因一个坏字段让整份清单失效
    const double rollout = section->numberAt("rollout_percent", 100.0);
    out.rollout_percent = static_cast<int>(std::clamp(rollout, 0.0, 100.0));
    out.mandatory = section->boolAt("mandatory", false);
    out.mandatory_deadline = section->stringAt("mandatory_deadline");
    out.mandatory_reason = section->stringAt("mandatory_reason");
    if (!out.mandatory) {
        // 与小兔口径一致：非强制更新不携带期限/原因，避免 UI 误显示升级期限
        out.mandatory_deadline.clear();
        out.mandatory_reason.clear();
    }

    const JsonValue *artifacts = section->find("artifacts");
    if (!artifacts || !artifacts->isObject()) {
        setError(error, "更新清单缺少 artifacts");
        return false;
    }
    if (!parseArtifact(*artifacts, "dmg", &out.dmg, error)
        || !parseArtifact(*artifacts, "setup", &out.setup, error)
        || !parseArtifact(*artifacts, "portable", &out.portable, error))
        return false;

    // 平台必填产物：macOS 至少 dmg，Windows 至少 setup 或 portable 之一
    if (platform == UpdatePlatform::Macos) {
        if (out.dmg.url.empty()) {
            setError(error, "更新清单缺少 dmg 产物");
            return false;
        }
    } else if (out.setup.url.empty() && out.portable.url.empty()) {
        setError(error, "更新清单至少需要 setup 或 portable 产物");
        return false;
    }
    return true;
}

int compareVersions(std::string_view left, std::string_view right)
{
    const std::vector<long long> a = versionSegments(left);
    const std::vector<long long> b = versionSegments(right);
    const std::size_t count = a.size() > b.size() ? a.size() : b.size();
    for (std::size_t i = 0; i < count; ++i) {
        const long long av = i < a.size() ? a.at(i) : 0;
        const long long bv = i < b.size() ? b.at(i) : 0;
        if (av != bv)
            return av < bv ? -1 : 1;
    }
    return 0;
}

int rolloutBucket(std::string_view installId, long long build)
{
    const std::string material = std::string(installId) + ":" + std::to_string(build);
    const std::array<std::uint8_t, 32> digest = sha256Digest(material);
    const std::uint32_t value = (static_cast<std::uint32_t>(digest[0]) << 24)
        | (static_cast<std::uint32_t>(digest[1]) << 16)
        | (static_cast<std::uint32_t>(digest[2]) << 8)
        | static_cast<std::uint32_t>(digest[3]);
    return static_cast<int>(value % 100u);
}

bool rolloutAllows(int percent, int bucket)
{
    return bucket >= 0 && bucket < std::clamp(percent, 0, 100);
}

std::string mandatoryReasonLabel(std::string_view reason)
{
    // 与 xiaotu web/app.js 的 mandatoryReasonText、DevCard 前端文案逐字一致
    if (reason == "SECURITY")
        return "安全漏洞修复";
    if (reason == "PROTOCOL")
        return "协议不兼容";
    if (reason == "REGULATORY")
        return "法规或税控要求";
    if (reason == "MIN_SUPPORTED")
        return "低于服务端最低支持版本";
    return std::string();
}

UpdateDecision decideUpdate(const UpdateManifest &manifest, UpdatePlatform platform,
                            std::string_view currentVersion, std::string_view currentOs,
                            long long currentBuild, std::string_view installId)
{
    if (manifest.version.empty())
        return UpdateDecision::Invalid;

    // 平台产物必须存在，否则清单不可用（与解析的必填规则一致，双保险）
    const UpdateArtifact *artifact = nullptr;
    if (platform == UpdatePlatform::Macos) {
        artifact = &manifest.dmg;
    } else {
        artifact = !manifest.portable.url.empty() ? &manifest.portable : &manifest.setup;
    }
    if (artifact->url.empty())
        return UpdateDecision::Invalid;

    const int comparison = compareVersions(manifest.version, currentVersion);
    if (comparison < 0)
        return UpdateDecision::UpToDate;
    if (comparison == 0) {
        // Windows / macOS：同版本再比构建号
        // Windows 和 macOS 现在都有 build（MOTE_BUILD compile_def + Info.plist CFBundleVersion）；
        // 本机 build 未知（<=0）时跳过，仅按 version 判定。
        // 2026-11-20 起：macOS 也支持同版本重发靠 build 区分（之前 macOS 直接 return UpToDate）。
        if (currentBuild <= 0 || manifest.build <= currentBuild)
            return UpdateDecision::UpToDate;
    }
    if (!manifest.min_os.empty() && compareVersions(currentOs, manifest.min_os) < 0)
        return UpdateDecision::UnsupportedSystem;

    // 灰度分批：mandatory 直接放行；未提供 install_id 的调用方保持旧行为（不灰度）
    if (!manifest.mandatory && !installId.empty()
        && !rolloutAllows(manifest.rollout_percent, rolloutBucket(installId, manifest.build)))
        return UpdateDecision::RolloutHold;

    return UpdateDecision::Available;
}

} // namespace mote
