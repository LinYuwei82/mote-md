#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace mote {

class SettingsStore;

// 「最近打开」列表：单键 JSON 字符串数组（绝对路径，新项置顶）。
// 去重按「分隔符统一 + 大小写不敏感」比较（APFS/NTFS 默认大小写不敏感），
// 上限 kMaxEntries 条；存储损坏时按空列表容错。
// core 不碰文件系统——路径存在性检查留在壳侧，保持可测性。
class RecentFiles
{
public:
    // 两平台共用的默认存储键
    static inline constexpr const char *kDefaultKey = "recent_files";
    static inline constexpr std::size_t kMaxEntries = 10;

    RecentFiles(SettingsStore &store, std::string key = kDefaultKey);

    // 置顶加入 path（已存在则先移除旧项）；空路径忽略
    void add(const std::string &path);
    // 当前列表（新→旧）；损坏存储返回空
    std::vector<std::string> list() const;
    void clear();

private:
    std::vector<std::string> load() const;

    SettingsStore *m_store;
    std::string m_key;
};

} // namespace mote
