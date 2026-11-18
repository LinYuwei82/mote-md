#include "core/text_encoding.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace mote {
namespace {

void appendUtf8(std::string &out, std::uint32_t code)
{
    if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF))
        code = 0xFFFD; // 孤立代理或越界码点：替换字符，避免产出非法 UTF-8
    if (code < 0x80) {
        out += static_cast<char>(code);
    } else if (code < 0x800) {
        out += static_cast<char>(0xC0 | (code >> 6));
        out += static_cast<char>(0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
        out += static_cast<char>(0xE0 | (code >> 12));
        out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (code & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (code >> 18));
        out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (code & 0x3F));
    }
}

std::uint16_t readUnit(const std::string &bytes, std::size_t offset, bool little_endian)
{
    const auto low = static_cast<std::uint8_t>(bytes[offset]);
    const auto high = static_cast<std::uint8_t>(bytes[offset + 1]);
    return little_endian ? static_cast<std::uint16_t>(low | (high << 8))
                         : static_cast<std::uint16_t>((low << 8) | high);
}

std::string utf16ToUtf8(const std::string &bytes, std::size_t offset, bool little_endian)
{
    std::string out;
    out.reserve(bytes.size());
    for (std::size_t i = offset; i + 1 < bytes.size(); i += 2) {
        const std::uint16_t unit = readUnit(bytes, i, little_endian);
        if (unit >= 0xD800 && unit <= 0xDBFF && i + 3 < bytes.size()) {
            const std::uint16_t next = readUnit(bytes, i + 2, little_endian);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                const std::uint32_t code =
                    0x10000 + ((static_cast<std::uint32_t>(unit) - 0xD800) << 10)
                    + (static_cast<std::uint32_t>(next) - 0xDC00);
                appendUtf8(out, code);
                i += 2;
                continue;
            }
        }
        appendUtf8(out, unit);
    }
    return out;
}

} // namespace

bool isValidUtf8(const std::string &bytes)
{
    std::size_t i = 0;
    while (i < bytes.size()) {
        const auto lead = static_cast<std::uint8_t>(bytes[i]);
        if (lead < 0x80) {
            ++i;
            continue;
        }
        std::size_t extra = 0;
        std::uint32_t code = 0;
        if ((lead & 0xE0) == 0xC0) {
            extra = 1;
            code = lead & 0x1F;
        } else if ((lead & 0xF0) == 0xE0) {
            extra = 2;
            code = lead & 0x0F;
        } else if ((lead & 0xF8) == 0xF0) {
            extra = 3;
            code = lead & 0x07;
        } else {
            return false;
        }
        if (i + extra >= bytes.size())
            return false;
        for (std::size_t k = 1; k <= extra; ++k) {
            const auto next = static_cast<std::uint8_t>(bytes[i + k]);
            if ((next & 0xC0) != 0x80)
                return false;
            code = (code << 6) | (next & 0x3F);
        }
        // 拒绝过长编码、代理区与越界码点
        if ((extra == 1 && code < 0x80) || (extra == 2 && code < 0x800)
            || (extra == 3 && code < 0x10000) || code > 0x10FFFF
            || (code >= 0xD800 && code <= 0xDFFF))
            return false;
        i += extra + 1;
    }
    return true;
}

std::string normalizeTextEncoding(const std::string &bytes)
{
    if (bytes.size() >= 3 && static_cast<std::uint8_t>(bytes[0]) == 0xEF
        && static_cast<std::uint8_t>(bytes[1]) == 0xBB
        && static_cast<std::uint8_t>(bytes[2]) == 0xBF)
        return bytes.substr(3);
    if (bytes.size() >= 2 && static_cast<std::uint8_t>(bytes[0]) == 0xFF
        && static_cast<std::uint8_t>(bytes[1]) == 0xFE)
        return utf16ToUtf8(bytes, 2, true);
    if (bytes.size() >= 2 && static_cast<std::uint8_t>(bytes[0]) == 0xFE
        && static_cast<std::uint8_t>(bytes[1]) == 0xFF)
        return utf16ToUtf8(bytes, 2, false);
    return bytes;
}

} // namespace mote
