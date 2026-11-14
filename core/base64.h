#pragma once

#include <cstdint>
#include <string_view>
#include <vector>

namespace mote {

// 解码页面回传的 base64 图片数据：忽略空白，遇到 '=' 或非法字符即停止。
// 与 Qt 的 QByteArray::fromBase64 行为一致（容错，不抛错）。
std::vector<std::uint8_t> base64Decode(std::string_view text);

} // namespace mote
