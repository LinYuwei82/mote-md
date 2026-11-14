#pragma once

#include <string>
#include <string_view>

namespace mote {

std::string toLowerAscii(std::string_view text);

// 路径工具：同时接受 '/' 与 '\\'，不依赖平台的文件名语义
std::string fileNameOf(std::string_view path);
std::string stemOf(std::string_view path);       // 去掉最后一个扩展名
std::string extensionOf(std::string_view path);  // 不含点；隐藏文件返回空

bool isMarkdownPath(std::string_view path);
bool isImagePath(std::string_view path);

// 本地目录 → file:// URL（供页面 <base href>）；保留中文与空格的百分号编码
std::string fileUrlForDirectory(std::string_view dir);

} // namespace mote
