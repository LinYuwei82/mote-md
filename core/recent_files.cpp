#include "core/recent_files.h"

#include "core/json.h"
#include "core/paths.h"
#include "mote/update_engine.h"

namespace mote {

namespace {

// 去重比较键：'\\' 统一为 '/' 后 ASCII 小写
std::string dedupKey(const std::string &path)
{
    std::string normalized;
    normalized.reserve(path.size());
    for (char c : path)
        normalized.push_back(c == '\\' ? '/' : c);
    return toLowerAscii(normalized);
}

std::string encodeList(const std::vector<std::string> &items)
{
    std::string out = "[";
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i != 0)
            out += ',';
        out += quoteJson(items[i]);
    }
    out += ']';
    return out;
}

} // namespace

RecentFiles::RecentFiles(SettingsStore &store, std::string key)
    : m_store(&store), m_key(std::move(key))
{
}

void RecentFiles::add(const std::string &path)
{
    if (path.empty())
        return;
    std::vector<std::string> items = load();
    const std::string key = dedupKey(path);
    std::vector<std::string> kept;
    kept.reserve(items.size());
    for (const std::string &item : items) {
        if (dedupKey(item) != key)
            kept.push_back(item);
    }
    kept.insert(kept.begin(), path);
    if (kept.size() > kMaxEntries)
        kept.resize(kMaxEntries);
    m_store->setString(m_key, encodeList(kept));
}

std::vector<std::string> RecentFiles::list() const { return load(); }

void RecentFiles::clear() { m_store->clearString(m_key); }

std::vector<std::string> RecentFiles::load() const
{
    std::vector<std::string> items;
    const std::string raw = m_store->getString(m_key);
    if (raw.empty())
        return items;
    JsonValue value;
    if (!parseJson(raw, value) || !value.isArray())
        return items; // 损坏存储按空列表处理
    for (const JsonValue &entry : value.asArray()) {
        if (!entry.isString())
            continue;
        const std::string &path = entry.asString();
        if (!path.empty())
            items.push_back(path);
    }
    if (items.size() > kMaxEntries)
        items.resize(kMaxEntries);
    return items;
}

} // namespace mote
