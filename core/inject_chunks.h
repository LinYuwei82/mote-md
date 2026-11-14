#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace mote {

// 按「JSON 转义后的字节预算」切分正文，用于大文档分片注入。
// 只按 UTF-8 码点边界切，不会把中文或 emoji 拆成半个字符；
// 引号、反斜杠与控制字符按转义后的长度计入预算。
std::vector<std::string> splitUtf8ByBudget(std::string_view text, std::size_t budget);

} // namespace mote
