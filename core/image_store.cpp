#include "core/image_store.h"

#include "core/paths.h"

#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>

namespace mote {

namespace {

namespace fs = std::filesystem;

bool isPlainChar(char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
        || c == '.' || c == '_' || c == '-';
}

std::string lowerAsciiCopy(std::string text)
{
    for (char &c : text) {
        if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c - 'A' + 'a');
    }
    return text;
}

bool contains(const std::string &text, const char *needle)
{
    return text.find(needle) != std::string::npos;
}

} // namespace

std::string imageExtension(const std::string &mime, const std::string &name)
{
    std::string suffix = lowerAsciiCopy(extensionOf(name));
    if (suffix == "jpeg")
        return "jpg";
    if (!suffix.empty())
        return suffix;
    const std::string type = lowerAsciiCopy(mime);
    if (contains(type, "jpeg"))
        return "jpg";
    if (contains(type, "gif"))
        return "gif";
    if (contains(type, "webp"))
        return "webp";
    if (contains(type, "tiff"))
        return "tiff";
    return "png";
}

std::string sanitizedBase(const std::string &name)
{
    const std::string stem = stemOf(fileNameOf(name));
    std::string base;
    base.reserve(stem.size());
    for (const char c : stem) {
        if (isPlainChar(c)) {
            base.push_back(c);
        } else if (base.empty() || base.back() != '-') {
            // 连续非法字符折叠成一个 '-'
            base.push_back('-');
        }
    }
    // 去掉开头连续的点与横线：避免生成 .hidden 或 -x 这样的文件名
    const size_t keep = base.find_first_not_of("-.");
    base = keep == std::string::npos ? std::string() : base.substr(keep);
    if (base.empty())
        base = "image";
    return base;
}

std::string uniqueAssetName(const std::string &assetsDir, const std::string &base,
                            const std::string &extension)
{
    std::error_code error;
    std::string candidate = base + "." + extension;
    int serial = 2;
    while (fs::exists(fs::path(assetsDir) / candidate, error))
        candidate = base + "-" + std::to_string(serial++) + "." + extension;
    return candidate;
}

std::string imageTimestamp()
{
    const std::time_t now = std::time(nullptr);
    std::tm local {};
#ifdef _WIN32
    localtime_s(&local, &now);
#else
    localtime_r(&now, &local);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y%m%d-%H%M%S", &local);
    return buffer;
}

StoredImage storeImage(const std::string &documentDir, const std::vector<std::uint8_t> &bytes,
                       const std::string &mime, const std::string &hint, bool isPaste,
                       const std::string &timestamp)
{
    StoredImage result;
    std::error_code error;
    if (documentDir.empty() || !fs::is_directory(documentDir, error)) {
        result.error = "图片未插入：当前文档还没有保存位置，请先保存 .md 文件";
        return result;
    }

    const fs::path assets = fs::path(documentDir) / "assets";
    fs::create_directories(assets, error);
    if (!fs::is_directory(assets, error)) {
        result.error = "图片未插入：无法创建 assets 目录（" + assets.string() + "）";
        return result;
    }

    const std::string extension = imageExtension(mime, hint);
    const std::string base = (isPaste || hint.empty())
        ? "paste-" + (timestamp.empty() ? imageTimestamp() : timestamp)
        : sanitizedBase(hint);
    const std::string name = uniqueAssetName(assets.string(), base, extension);
    const fs::path target = assets / name;

    std::ofstream out(target, std::ios::binary | std::ios::trunc);
    if (!out.is_open()) {
        result.error = "图片未插入：无法写入 assets/" + name;
        return result;
    }
    out.write(reinterpret_cast<const char *>(bytes.data()),
              static_cast<std::streamsize>(bytes.size()));
    if (!out.good()) {
        // 短写会在用户目录里留下一个坏 png，还会让下次同名退化成 -2，
        // 所以先删掉残缺文件再报错
        out.close();
        fs::remove(target, error);
        result.error = "图片未插入：写入不完整（assets/" + name + "），已删除残缺文件";
        return result;
    }
    out.close();

    result.ok = true;
    result.relativePath = "assets/" + name;
    return result;
}

std::vector<std::uint8_t> readFileBytes(const std::string &path, bool *ok)
{
    std::ifstream in(path, std::ios::binary);
    if (!in.is_open()) {
        if (ok)
            *ok = false;
        return {};
    }
    in.seekg(0, std::ios::end);
    const std::streamoff size = in.tellg();
    in.seekg(0, std::ios::beg);
    std::vector<std::uint8_t> bytes;
    if (size > 0) {
        bytes.resize(static_cast<size_t>(size));
        in.read(reinterpret_cast<char *>(bytes.data()), size);
        if (!in) {
            bytes.clear();
            if (ok)
                *ok = false;
            return bytes;
        }
    }
    if (ok)
        *ok = true;
    return bytes;
}

} // namespace mote
