#pragma once

#include <array>
#include <cstdint>
#include <string_view>

namespace mote {

// SHA-256 摘要（32 字节）。当前只服务于灰度分桶：三仓库用同一算法把
// install_id + build 映射到 0–99，必须逐位一致，因此自带一份实现而不依赖
// 系统库（macOS CommonCrypto / Windows BCrypt 的接口不同，容易写偏）。
std::array<std::uint8_t, 32> sha256Digest(std::string_view input);

} // namespace mote
