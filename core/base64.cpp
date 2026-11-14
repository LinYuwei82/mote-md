#include "core/base64.h"

namespace mote {

namespace {

int decodeChar(char c)
{
    if (c >= 'A' && c <= 'Z')
        return c - 'A';
    if (c >= 'a' && c <= 'z')
        return c - 'a' + 26;
    if (c >= '0' && c <= '9')
        return c - '0' + 52;
    if (c == '+' || c == '-')
        return 62;
    if (c == '/' || c == '_')
        return 63;
    return -1;
}

} // namespace

std::vector<std::uint8_t> base64Decode(std::string_view text)
{
    std::vector<std::uint8_t> out;
    out.reserve(text.size() * 3 / 4 + 3);
    int bits = 0;
    int accumulated = 0;
    for (const char c : text) {
        if (c == '=')
            break;
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
            continue;
        const int value = decodeChar(c);
        if (value < 0)
            continue;
        accumulated = (accumulated << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<std::uint8_t>((accumulated >> bits) & 0xFF));
            // 只保留尚未凑满一字节的低位，避免 int 随输入长度溢出
            accumulated &= (1 << bits) - 1;
        }
    }
    return out;
}

} // namespace mote
