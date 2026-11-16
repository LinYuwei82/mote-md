#include "core/update.h"

#include "core/json.h"

#include <cctype>
#include <vector>

namespace mote {

namespace {

// 只取每段前导数字：0.3.5-beta 里的 5-beta 视为 5，缺失段补 0。
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
        for (const char c : segment) {
            if (!std::isdigit(static_cast<unsigned char>(c)))
                break;
            hasDigit = true;
            value = value * 10 + (c - '0');
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

} // namespace

bool parseUpdateManifest(std::string_view text, UpdateManifest &out, std::string *error)
{
    out = UpdateManifest{};

    JsonValue root;
    if (!parseJson(text, root) || !root.isObject()) {
        setError(error, "更新清单不是合法的 JSON 对象");
        return false;
    }

    out.version = root.stringAt("version");
    if (out.version.empty()) {
        setError(error, "更新清单缺少 version");
        return false;
    }
    out.url = root.stringAt("url");
    if (out.url.empty()) {
        setError(error, "更新清单缺少 url");
        return false;
    }

    out.sha256 = root.stringAt("sha256");
    out.min_os = root.stringAt("min_os");
    out.published_at = root.stringAt("published_at");

    const double size = root.numberAt("size", 0.0);
    if (size < 0.0) {
        setError(error, "更新清单的 size 不能为负数");
        return false;
    }
    out.size = static_cast<long long>(size);
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

UpdateDecision decideUpdate(const UpdateManifest &manifest, std::string_view currentVersion,
                            std::string_view currentOs)
{
    if (manifest.version.empty() || manifest.url.empty())
        return UpdateDecision::Invalid;
    if (compareVersions(manifest.version, currentVersion) <= 0)
        return UpdateDecision::UpToDate;
    if (!manifest.min_os.empty() && compareVersions(currentOs, manifest.min_os) < 0)
        return UpdateDecision::UnsupportedSystem;
    return UpdateDecision::Available;
}

} // namespace mote
