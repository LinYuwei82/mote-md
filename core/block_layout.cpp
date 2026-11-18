#include "core/block_layout.h"

namespace mote {
namespace {

void appendNewlines(std::string *out, int count)
{
    if (count > 0)
        out->append(static_cast<std::size_t>(count), '\n');
}

bool onlyNewlines(const std::string &text, std::size_t begin, std::size_t end)
{
    for (std::size_t i = begin; i < end && i < text.size(); ++i) {
        if (text[i] != '\n')
            return false;
    }
    return true;
}

} // namespace

std::string joinBlocks(const std::vector<std::string> &blocks, const BlockLayout &layout)
{
    std::string out;
    appendNewlines(&out, layout.leading);
    for (std::size_t i = 0; i < blocks.size(); ++i) {
        if (i > 0)
            appendNewlines(&out, i - 1 < layout.between.size() ? layout.between[i - 1] : 0);
        out += blocks[i];
    }
    appendNewlines(&out, layout.trailing);
    return out;
}

MeasuredLayout measureBlockGaps(const std::string &text, const std::vector<std::string> &blocks)
{
    MeasuredLayout result;
    if (blocks.empty()) {
        // 整篇只有空行：全部计入文末，拼接回来仍与原文一致
        if (!onlyNewlines(text, 0, text.size()))
            return result;
        result.layout.trailing = static_cast<int>(text.size());
        result.ok = true;
        return result;
    }

    std::size_t cursor = 0;
    std::size_t anchor = text.find(blocks[0], cursor);
    if (anchor == std::string::npos || !onlyNewlines(text, cursor, anchor))
        return result;
    result.layout.leading = static_cast<int>(anchor - cursor);
    cursor = anchor + blocks[0].size();

    for (std::size_t i = 1; i < blocks.size(); ++i) {
        anchor = text.find(blocks[i], cursor);
        if (anchor == std::string::npos || !onlyNewlines(text, cursor, anchor))
            return result;
        result.layout.between.push_back(static_cast<int>(anchor - cursor));
        cursor = anchor + blocks[i].size();
    }

    if (!onlyNewlines(text, cursor, text.size()))
        return result;
    result.layout.trailing = static_cast<int>(text.size() - cursor);
    result.ok = true;
    return result;
}

std::size_t blockStartOffset(const std::vector<std::string> &blocks, const BlockLayout &layout,
                             std::size_t index)
{
    if (index >= blocks.size())
        return std::string::npos;
    std::size_t offset =
        layout.leading > 0 ? static_cast<std::size_t>(layout.leading) : std::size_t(0);
    for (std::size_t i = 0; i < index; ++i) {
        offset += blocks[i].size();
        const int count = i < layout.between.size() ? layout.between[i] : 0;
        if (count > 0)
            offset += static_cast<std::size_t>(count);
    }
    return offset;
}

} // namespace mote
