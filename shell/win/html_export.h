#pragma once

#include <string>

// 导出 HTML 前的图片内联（阶段 B N4）：把本地图片 src 换成 data: URI，
// 保证导出文件自包含；读不到的文件替换为「[图片缺失]」提示。
std::string MoteInlineLocalImages(const std::string &html, const std::string &base_dir,
                                  int *missing_count);
