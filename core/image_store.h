#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mote {

struct StoredImage {
    bool ok = false;
    std::string relativePath; // 成功时形如 assets/paste-20260101-120000.png
    std::string error;        // 失败时是可直接展示的中文提示
};

// 扩展名优先取原文件名，其次按 MIME；都没命中就按 PNG
std::string imageExtension(const std::string &mime, const std::string &name);

// 只保留安全字符；为空时退回 image
std::string sanitizedBase(const std::string &name);

// 重名不覆盖：已存在就依次试 -2、-3……
std::string uniqueAssetName(const std::string &assetsDir, const std::string &base,
                            const std::string &extension);

// yyyyMMdd-HHmmss，本地时间
std::string imageTimestamp();

// 把图片字节写进「md 同目录/assets/」；timestamp 为空时取当前时间（便于单测固定文件名）
StoredImage storeImage(const std::string &documentDir, const std::vector<std::uint8_t> &bytes,
                       const std::string &mime, const std::string &hint, bool isPaste,
                       const std::string &timestamp = std::string());

// 整文件读取；失败时 ok=false
std::vector<std::uint8_t> readFileBytes(const std::string &path, bool *ok);

} // namespace mote
