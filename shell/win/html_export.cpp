#include "html_export.h"

#include "win_encoding/encoding.h"

#include <windows.h>

#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string_view>
#include <vector>

namespace {

using win_encoding::utf8_to_wide;

std::string percent_decode(const std::string &text)
{
    std::string out;
    out.reserve(text.size());
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '%' && i + 2 < text.size()
            && std::isxdigit(static_cast<unsigned char>(text[i + 1]))
            && std::isxdigit(static_cast<unsigned char>(text[i + 2]))) {
            out.push_back(static_cast<char>(std::stoi(text.substr(i + 1, 2), nullptr, 16)));
            i += 2;
        } else {
            out.push_back(text[i]);
        }
    }
    return out;
}

std::string to_lower(std::string text)
{
    for (char &ch : text)
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return text;
}

std::string base64_encode(const std::vector<std::uint8_t> &bytes)
{
    static const char table[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((bytes.size() + 2) / 3 * 4);
    for (size_t i = 0; i < bytes.size(); i += 3) {
        const std::uint32_t a = bytes[i];
        const std::uint32_t b = i + 1 < bytes.size() ? bytes[i + 1] : 0;
        const std::uint32_t c = i + 2 < bytes.size() ? bytes[i + 2] : 0;
        const std::uint32_t triple = (a << 16) | (b << 8) | c;
        out.push_back(table[(triple >> 18) & 0x3F]);
        out.push_back(table[(triple >> 12) & 0x3F]);
        out.push_back(i + 1 < bytes.size() ? table[(triple >> 6) & 0x3F] : '=');
        out.push_back(i + 2 < bytes.size() ? table[triple & 0x3F] : '=');
    }
    return out;
}

std::string mime_for(const std::string &path)
{
    const std::string lower = to_lower(path);
    if (lower.ends_with(".png"))
        return "image/png";
    if (lower.ends_with(".jpg") || lower.ends_with(".jpeg"))
        return "image/jpeg";
    if (lower.ends_with(".gif"))
        return "image/gif";
    if (lower.ends_with(".webp"))
        return "image/webp";
    if (lower.ends_with(".svg"))
        return "image/svg+xml";
    if (lower.ends_with(".bmp"))
        return "image/bmp";
    return "application/octet-stream";
}

std::string join_path(const std::string &dir, const std::string &name)
{
    if (dir.empty())
        return name;
    if (dir.back() == '\\' || dir.back() == '/')
        return dir + name;
    return dir + "/" + name;
}

bool read_bytes(const std::string &path, std::vector<std::uint8_t> *bytes)
{
    std::ifstream file(std::filesystem::path(utf8_to_wide(path)), std::ios::binary);
    if (!file)
        return false;
    bytes->assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    return true;
}

bool has_prefix(const std::string &text, std::string_view prefix)
{
    return text.rfind(prefix, 0) == 0;
}

} // namespace

std::string MoteInlineLocalImages(const std::string &html, const std::string &base_dir,
                                  int *missing_count)
{
    if (missing_count)
        *missing_count = 0;
    if (html.empty())
        return html;

    const std::string base = base_dir.empty() ? "." : base_dir;
    std::string output;
    output.reserve(html.size());
    int missing = 0;
    size_t cursor = 0;

    while (true) {
        const size_t tag_start = html.find("<img", cursor);
        if (tag_start == std::string::npos)
            break;
        const size_t tag_end = html.find('>', tag_start);
        if (tag_end == std::string::npos)
            break;

        // src 必须落在标签内部
        const std::string tag = html.substr(tag_start, tag_end - tag_start + 1);
        const size_t src_at = tag.find("src=\"");
        output.append(html, cursor, tag_start - cursor);
        cursor = tag_end + 1;
        if (src_at == std::string::npos) {
            output += tag;
            continue;
        }
        const size_t value_start = src_at + 5;
        const size_t value_end = tag.find('"', value_start);
        if (value_end == std::string::npos) {
            output += tag;
            continue;
        }
        const std::string src = tag.substr(value_start, value_end - value_start);
        const std::string lowered = to_lower(src);
        if (src.empty() || has_prefix(lowered, "data:") || has_prefix(lowered, "http:")
            || has_prefix(lowered, "https:")) {
            output += tag;
            continue;
        }

        std::string path;
        if (has_prefix(lowered, "file:")) {
            path = percent_decode(src.substr(5)); // 去掉 scheme
            if (path.rfind("///", 0) == 0)
                path.erase(0, 3);
            else if (path.rfind("//", 0) == 0)
                path.erase(0, 2);
        } else if (percent_decode(src).rfind("/", 0) == 0) {
            path = percent_decode(src);
        } else {
            path = join_path(base, percent_decode(src));
        }

        std::vector<std::uint8_t> bytes;
        if (!read_bytes(path, &bytes) || bytes.empty()) {
            ++missing;
            output += "<span class=\"mote-img-missing\">[图片缺失] " + src + "</span>";
            continue;
        }
        const std::string data_uri =
            "data:" + mime_for(path) + ";base64," + base64_encode(bytes);
        std::string replacement = tag;
        replacement.replace(value_start, value_end - value_start, data_uri);
        output += replacement;
    }

    output.append(html, cursor);
    if (missing_count)
        *missing_count = missing;
    return output;
}
