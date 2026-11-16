#pragma once

#include <string>
#include <string_view>

namespace mote {

// 在线更新：只负责「策略」——清单解析、版本比较、是否提示更新。
// 下载与安装由平台层负责（macOS 交给 Sparkle），因此这里不碰网络和文件系统，
// macOS 与 Windows 共用同一套判定，保证两端看到的结果一致。
struct UpdateManifest
{
    std::string version;      // 必填，形如 0.3.6
    std::string url;          // 必填，安装包直链
    std::string sha256;       // 可选，安装包摘要（小写十六进制）
    std::string min_os;       // 可选，最低系统版本，形如 14.0
    std::string published_at; // 可选，发布时间（原样透传，仅用于展示）
    long long size = 0;       // 可选，安装包字节数；0 表示清单未提供

    // 可选：安装版的安装包。Windows 客户端按自身安装形态二选一，
    // 缺失时回落到 url，老清单仍然可用。
    std::string setup_url;
    std::string setup_sha256;
    long long setup_size = 0;
};

// 解析 latest.json。缺少必填字段或类型不符返回 false，error 给出中文原因。
bool parseUpdateManifest(std::string_view text, UpdateManifest &out, std::string *error);

// 按数字段比较版本号（忽略前缀 v 与非数字后缀），返回 -1 / 0 / 1。
int compareVersions(std::string_view left, std::string_view right);

enum class UpdateDecision {
    Invalid,           // 清单不可用（解析失败或字段缺失）
    UpToDate,          // 当前版本已经不比清单旧
    Available,         // 有新版本可安装
    UnsupportedSystem, // 有新版本，但当前系统低于 min_os
};

// 结合当前版本与当前系统版本得出该提示什么。
UpdateDecision decideUpdate(const UpdateManifest &manifest, std::string_view currentVersion,
                            std::string_view currentOs);

} // namespace mote
