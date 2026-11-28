void log_line(const wchar_t *text)
{
    OutputDebugStringW(text);
    OutputDebugStringW(L"\n");
    const std::string path = env_value("MOTE_LOG");
    if (!path.empty()) {
        std::ofstream file(std::filesystem::path(utf8_to_wide(path)),
                           std::ios::app | std::ios::binary);
        if (file)
            file << wide_to_utf8(text) << "\n";
    }
}

std::wstring exe_directory()
{
    wchar_t buffer[MAX_PATH] = {};
    const DWORD length = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    std::wstring path(buffer, length);
    const size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? path : path.substr(0, slash);
}

std::wstring user_data_directory()
{
    // 诊断覆盖：SSH 无头会话的 KnownFolder 可能指向不可写配置的用户目录，
    // 设 MOTE_WEBVIEW2_DATA 可把 WebView2 数据目录指到可写位置。
    const std::string override_dir = env_value("MOTE_WEBVIEW2_DATA");
    if (!override_dir.empty())
        return utf8_to_wide(override_dir);
    PWSTR local_app_data = nullptr;
    std::wstring result;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local_app_data))
        && local_app_data) {
        result = local_app_data;
        result += L"\\Mote\\WebView2";
    }
    if (local_app_data)
        CoTaskMemFree(local_app_data);
    if (result.empty()) {
        wchar_t temp[MAX_PATH] = {};
        GetTempPathW(MAX_PATH, temp);
        result = std::wstring(temp) + L"MoteWebView2";
    }
    return result;
}

std::string read_file(const std::wstring &path)
{
    std::ifstream file(std::filesystem::path(path), std::ios::binary);
    if (!file)
        return std::string();
    return std::string(std::istreambuf_iterator<char>(file),
                       std::istreambuf_iterator<char>());
}

bool write_file(const std::wstring &path, const std::string &bytes)
{
    std::ofstream file(std::filesystem::path(path),
                       std::ios::binary | std::ios::trunc);
    if (!file)
        return false;
    file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    return file.good();
}

void replace_all(std::string &text, const std::string &needle, const std::string &value)
{
    if (needle.empty())
        return;
    size_t position = 0;
    while ((position = text.find(needle, position)) != std::string::npos) {
        text.replace(position, needle.size(), value);
        position += value.size();
    }
}

