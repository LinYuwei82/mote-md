#include "core/paths.h"

#include <cstdio>
#include <initializer_list>

namespace mote {

namespace {

size_t fileNameStart(std::string_view path)
{
    const size_t sep = path.find_last_of("/\\");
    return sep == std::string_view::npos ? 0 : sep + 1;
}

bool extensionIn(std::string_view extension, std::initializer_list<std::string_view> known)
{
    for (const std::string_view item : known) {
        if (extension == item)
            return true;
    }
    return false;
}

} // namespace

std::string toLowerAscii(std::string_view text)
{
    std::string out(text);
    for (char &c : out) {
        if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string fileNameOf(std::string_view path)
{
    return std::string(path.substr(fileNameStart(path)));
}

std::string extensionOf(std::string_view path)
{
    const size_t start = fileNameStart(path);
    const size_t dot = path.find_last_of('.');
    if (dot == std::string_view::npos || dot < start || dot + 1 >= path.size())
        return {};
    // ".gitignore" 这类隐藏文件不算有扩展名（与 QFileInfo 口径一致）
    if (dot == start)
        return {};
    return std::string(path.substr(dot + 1));
}

std::string stemOf(std::string_view path)
{
    const size_t start = fileNameStart(path);
    const size_t dot = path.find_last_of('.');
    if (dot == std::string_view::npos || dot < start || dot == start)
        return std::string(path);
    return std::string(path.substr(0, dot));
}

bool isMarkdownPath(std::string_view path)
{
    const std::string extension = toLowerAscii(extensionOf(path));
    return extensionIn(extension, {"md", "markdown", "mdown", "mkd", "txt"});
}

bool isImagePath(std::string_view path)
{
    const std::string extension = toLowerAscii(extensionOf(path));
    return extensionIn(extension, {"png", "jpg", "jpeg", "gif", "webp", "heic",
                                   "tif", "tiff", "bmp"});
}

std::string fileUrlForDirectory(std::string_view dir)
{
    std::string path(dir);
    while (path.size() > 1 && (path.back() == '/' || path.back() == '\\'))
        path.pop_back();
    for (char &c : path) {
        if (c == '\\')
            c = '/';
    }

    std::string encoded;
    encoded.reserve(path.size());
    for (const unsigned char byte : path) {
        const bool plain = (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z')
            || (byte >= '0' && byte <= '9')
            || byte == '/' || byte == '-' || byte == '_' || byte == '.' || byte == '~'
            || byte == ':';
        if (plain) {
            encoded.push_back(static_cast<char>(byte));
            continue;
        }
        char buffer[4];
        std::snprintf(buffer, sizeof(buffer), "%%%02X", byte);
        encoded += buffer;
    }

    // Windows 的 "C:/dir" 也补上前导斜杠，组成 file:///C:/dir/
    if (encoded.empty() || encoded.front() != '/')
        encoded.insert(encoded.begin(), '/');
    return "file://" + encoded + "/";
}

} // namespace mote
