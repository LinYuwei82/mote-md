#include "core/inject_chunks.h"

namespace mote {

namespace {

// 一个字节在 JSON 字符串字面量里占几个字节：
// 引号与反斜杠要加转义，控制字符变成 \u00XX，其余原样（UTF-8 多字节不转义）
std::size_t escaped_size(unsigned char byte)
{
    if (byte == '"' || byte == '\\')
        return 2;
    if (byte < 0x20)
        return 6;
    return 1;
}

// 返回该位置 UTF-8 码点的字节数；非法序列按 1 字节前进，保证总能收敛
std::size_t utf8_length(std::string_view text, std::size_t index)
{
    const unsigned char lead = static_cast<unsigned char>(text[index]);
    std::size_t length = 1;
    if ((lead & 0xE0) == 0xC0)
        length = 2;
    else if ((lead & 0xF0) == 0xE0)
        length = 3;
    else if ((lead & 0xF8) == 0xF0)
        length = 4;
    if (index + length > text.size())
        return 1;
    return length;
}

} // namespace

std::vector<std::string> splitUtf8ByBudget(std::string_view text, std::size_t budget)
{
    std::vector<std::string> chunks;
    if (text.empty() || budget == 0)
        return chunks;

    std::string current;
    std::size_t current_size = 0;
    std::size_t index = 0;
    while (index < text.size()) {
        const std::size_t length = utf8_length(text, index);
        std::size_t cost = 0;
        for (std::size_t offset = 0; offset < length; ++offset)
            cost += escaped_size(static_cast<unsigned char>(text[index + offset]));

        // 单个码点就超预算时仍独占一片，否则会永远切不动
        if (!current.empty() && current_size + cost > budget) {
            chunks.push_back(std::move(current));
            current.clear();
            current_size = 0;
        }
        current.append(text.data() + index, length);
        current_size += cost;
        index += length;
    }
    if (!current.empty())
        chunks.push_back(std::move(current));
    return chunks;
}

} // namespace mote
