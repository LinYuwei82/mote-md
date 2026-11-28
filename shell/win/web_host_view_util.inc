std::string html_escape(const std::string &text)
{
    std::string escaped;
    escaped.reserve(text.size());
    for (const char ch : text) {
        switch (ch) {
        case '&': escaped += "&amp;"; break;
        case '"': escaped += "&quot;"; break;
        case '<': escaped += "&lt;"; break;
        case '>': escaped += "&gt;"; break;
        default: escaped += ch; break;
        }
    }
    return escaped;
}

std::string base64_encode(const std::string &bytes)
{
    static const char table[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((bytes.size() + 2) / 3) * 4);
    size_t index = 0;
    while (index + 2 < bytes.size()) {
        const unsigned int value = (static_cast<unsigned char>(bytes[index]) << 16)
            | (static_cast<unsigned char>(bytes[index + 1]) << 8)
            | static_cast<unsigned char>(bytes[index + 2]);
        out += table[(value >> 18) & 0x3F];
        out += table[(value >> 12) & 0x3F];
        out += table[(value >> 6) & 0x3F];
        out += table[value & 0x3F];
        index += 3;
    }
    if (index < bytes.size()) {
        const unsigned int value = (static_cast<unsigned char>(bytes[index]) << 16)
            | (index + 1 < bytes.size() ? static_cast<unsigned char>(bytes[index + 1]) << 8 : 0);
        out += table[(value >> 18) & 0x3F];
        out += table[(value >> 12) & 0x3F];
        out += index + 1 < bytes.size() ? table[(value >> 6) & 0x3F] : '=';
        out += '=';
    }
    return out;
}

bool inline_proto_enabled()
{
    const std::string text = env_value("MOTE_INLINE_PROTO");
    return text != "0" && text != "false" && text != "off";
}

std::wstring directory_of(const std::wstring &path)
{
    const size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

// 文档目录为 baseURL 时，相对图片/资源才能解析；目录 URL 必须以 / 结尾
std::string directory_url(const std::string &directory)
{
    const std::wstring wide = utf8_to_wide(directory);
    wchar_t url[2048] = {};
    DWORD length = 2048;
    std::string result;
    if (SUCCEEDED(UrlCreateFromPathW(wide.c_str(), url, &length, 0)))
        result = wide_to_utf8(url);
    if (result.empty())
        return result;
    if (result.back() != '/')
        result += '/';
    return result;
}

std::wstring font_face_css()
{
    const std::string font = read_file(exe_directory() + L"\\fonts\\JetBrainsMono-Light.ttf");
    if (font.empty())
        return std::wstring();
    const std::string css =
        "@font-face{font-family:'JetBrains Mono';src:url(data:font/ttf;base64,"
        + base64_encode(font)
        + ") format('truetype');font-weight:300;font-style:normal;font-display:block;}";
    return utf8_to_wide(css);
}

