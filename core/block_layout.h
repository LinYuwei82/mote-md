#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace mote {

// 块与块之间的空行布局。所见即所得编辑器把整篇文档拆成块，块之间用空行分隔；
// 这里只做「块文本 + 间隔 → 整篇文本」的字节换算，不解析 Markdown——
// 代码块内部的换行留在块文本里，不参与间隔计算。
struct BlockLayout {
    // between[i] 是 blocks[i] 与 blocks[i+1] 之间的换行数（正常文档至少 1）
    std::vector<int> between;
    int leading = 0;  // 文首空行数
    int trailing = 0; // 文末空行数
};

// 从原文量出的结果：ok 为 true 表示每个块都按顺序找到、且块外只有换行，
// 此时 joinBlocks(blocks, layout) 能逐字节还原原文。
struct MeasuredLayout {
    BlockLayout layout;
    bool ok = false;
};

// 拼接：leading 个换行 + blocks[0] + between[0] 个换行 + blocks[1] + …
// + trailing 个换行。between 少于 blocks.size()-1 时缺的部分按 0 处理，
// 负数同样按 0。
std::string joinBlocks(const std::vector<std::string> &blocks, const BlockLayout &layout);

// 从原文里量出间隔：按顺序定位每个块（允许块文本含内部换行，如代码块），
// 统计块与块之间、文首与文末的连续 '\n'。块文本被改动或顺序不一致时返回
// ok = false，调用方据此回退到默认间隔。
MeasuredLayout measureBlockGaps(const std::string &text, const std::vector<std::string> &blocks);

// 第 index 块在 joinBlocks 结果里的起始偏移；越界返回 std::string::npos。
// 前端原来按「每块固定 +2 字符」累加，替换成按实际间隔计算后用它核对位置。
std::size_t blockStartOffset(const std::vector<std::string> &blocks, const BlockLayout &layout,
                             std::size_t index);

} // namespace mote
