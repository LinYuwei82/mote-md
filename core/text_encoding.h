#pragma once

#include <string>

namespace mote {

// 判断字节串是否为合法 UTF-8（不接受过长编码、代理区与超过 U+10FFFF 的码点）。
bool isValidUtf8(const std::string &bytes);

// 读取文本后的编码归一：
//   - 去掉 UTF-8 BOM；
//   - 带 UTF-16 LE/BE BOM 时转成 UTF-8；
//   - 其余原样返回，是否再按系统代码页兜底由调用方决定。
std::string normalizeTextEncoding(const std::string &bytes);

} // namespace mote
