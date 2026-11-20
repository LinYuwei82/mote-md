#pragma once

#include <ctime>
#include <string>
#include <string_view>

namespace mote {

// 清单 v2 的产物条目（platforms.<平台>.artifacts.<key>）。
struct UpdateArtifact
{
    std::string url;    // 必填，安装包直链
    std::string sha256; // 可选，安装包摘要（小写十六进制）
    long long size = 0; // 可选，安装包字节数；0 表示清单未提供
};

// 客户端所在平台：决定读 platforms.macos 还是 platforms.windows，
// 以及更新判定是否比较构建号。
enum class UpdatePlatform { Macos, Windows };

// 在线更新：只负责「策略」——清单解析、版本比较、是否提示更新。
// 下载与安装由平台层负责（macOS 交给 Sparkle），因此这里不碰网络和文件系统，
// macOS 与 Windows 共用同一套判定，保证两端看到的结果一致。
//
// v2 清单是统一的 manifest.json：macOS 与 Windows 各取自己的平台段，
// 签名验证由 core/verify_signature 负责，这里不重复做。
struct UpdateManifest
{
    // 顶层字段：清单更新时间（ISO 8601 UTC，原样透传，仅用于展示）。
    // 替代 v1 的 published_at。
    std::string updated_at;

    // 平台段字段（platforms.<自己的平台>）
    std::string version;      // 必填，形如 1.0.2
    long long build = 0;      // 构建号；macOS 恒为 0，Windows 同版本时参与比较
    std::string min_os;       // 可选，最低系统版本，形如 14.0
    std::string notes_url;    // 可选，本次更新的发布说明 URL（release notes 页面）
    int rollout_percent = 100; // 可选，灰度比例 0–100；缺省 100 表示全量
    bool mandatory = false;    // 可选，强制更新；为 true 时跳过灰度与「稍后」
    std::string mandatory_deadline; // 可选，ISO 8601 UTC，仅用于提示升级期限
    std::string mandatory_reason;   // 可选，SECURITY / PROTOCOL / REGULATORY / MIN_SUPPORTED

    // artifacts.<key>：key 枚举 dmg / setup / portable；未知 key 一律忽略。
    UpdateArtifact dmg;      // macOS 安装包
    UpdateArtifact setup;    // Windows 安装版
    UpdateArtifact portable; // Windows 绿色包
};

// 解析 manifest.json v2。只取 platforms.<platform> 平台段，另一平台与一切未知
// 字段/未知 artifacts key 一律忽略；缺少必填字段或类型不符返回 false，error
// 给出中文原因。
bool parseUpdateManifest(std::string_view text, UpdatePlatform platform,
                         UpdateManifest &out, std::string *error);

// 按数字段比较版本号（忽略前缀 v 与非数字后缀），返回 -1 / 0 / 1。
int compareVersions(std::string_view left, std::string_view right);

enum class UpdateDecision {
    Invalid,           // 清单不可用（解析失败或字段缺失）
    UpToDate,          // 当前版本已经不比清单旧
    Available,         // 有新版本可安装
    UnsupportedSystem, // 有新版本，但当前系统低于 min_os
    RolloutHold,       // 有新版本，但本机不在本轮灰度范围
};

// 灰度分桶：SHA-256(install_id + ":" + build) 取前 4 字节按大端拼成 uint32，
// 再对 100 取模。小兔 / DevCard / Mote 三仓库唯一口径，任何一端改动都必须同步
// 另两端与文档（见 docs/更新清单Schema-v2.md 6.1）。
int rolloutBucket(std::string_view installId, long long build);

// percent 超出 0–100 时按边界截断；bucket 为负（无 install_id）一律不放行。
bool rolloutAllows(int percent, int bucket);

// mandatory_reason 四类原因的中文文案（与小兔 / DevCard 客户端一致）；
// 未知或空串返回空（UI 不显示原因，不因此判清单无效）。
std::string mandatoryReasonLabel(std::string_view reason);

// 解析 ISO 8601 UTC（YYYY-MM-DDTHH:MM:SSZ）为 Unix 时间戳；格式非法返回 false。
bool parseIso8601Utc(std::string_view text, std::time_t *out);

// 强制更新是否已生效：未设期限 → 立即强制；设了期限 → 到期才强制
// （截止前仍可稍后）；期限非法按「已到期」处理，避免格式问题被绕过。
// mandatory 为 false 时恒为 false。三端（小兔 / DevCard / Mote）同一口径。
bool mandatoryActive(const UpdateManifest &manifest, std::time_t now);

// 结合当前版本与当前系统版本得出该提示什么。
// macOS 只比 version；Windows 先比 version，同版本再比 build（build 小于等于
// 本机 → 无更新）。currentBuild 是本机构建号，来自编译期宏 MOTE_BUILD（见
// native/CMakeLists.txt；0 表示未知，此时跳过 build 比较仅按 version），
// macOS 恒传 0。
//
// installId 是本机安装实例标识（首次检查更新时生成并持久化）：非空时参与
// 灰度分桶，命中 rollout_percent 才返回 Available，否则 RolloutHold；
// 为空则跳过灰度（兼容尚未接入 install_id 的旧调用方）。
UpdateDecision decideUpdate(const UpdateManifest &manifest, UpdatePlatform platform,
                            std::string_view currentVersion, std::string_view currentOs,
                            long long currentBuild, std::string_view installId = {});

} // namespace mote
