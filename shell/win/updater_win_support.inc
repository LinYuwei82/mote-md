// 与 macOS 的 SUFeedURL 同源：v2 统一清单放在 updates/stable/manifest.json
constexpr wchar_t kDefaultManifestUrl[] =
    L"https://dl.xiaotu.online/mote/updates/stable/manifest.json";
constexpr UINT kStartupDelayMs = 10 * 1000;
constexpr DWORD kRequestTimeoutMs = 15 * 1000;
constexpr wchar_t kRegKey[] = L"Software\\Mote";
// 引擎键 → 注册表值名（沿用旧版，升级后不丢「稍后」记录与灰度分桶标识）
constexpr wchar_t kRegLastCheck[] = L"LastUpdateCheck";
constexpr wchar_t kRegSkipped[] = L"SkippedUpdateVersion";
constexpr wchar_t kRegInstallId[] = L"InstallId";

using win_encoding::utf8_to_wide;
using win_encoding::wide_to_utf8;

// 与 macOS 同名同前缀，方便两端用同一套 MOTE_KEYLOG 诊断口径
void update_log(const char *format, ...)
{
    char buffer[512] = {};
    va_list args;
    va_start(args, format);
    std::vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);

    const std::string line = std::string("NATIVE update ") + buffer;
    OutputDebugStringA((line + "\n").c_str());
    const std::string path = env_value("MOTE_LOG");
    if (!path.empty()) {
        std::ofstream file(std::filesystem::path(utf8_to_wide(path)),
                           std::ios::app | std::ios::binary);
        if (file)
            file << line << "\n";
    }
}

bool log_enabled()
{
    return !env_value("MOTE_KEYLOG").empty();
}

void engine_logger(const std::string &line)
{
    if (!log_enabled())
        return;
    OutputDebugStringA((line + "\n").c_str());
    const std::string path = env_value("MOTE_LOG");
    if (!path.empty()) {
        std::ofstream file(std::filesystem::path(utf8_to_wide(path)),
                           std::ios::app | std::ios::binary);
        if (file)
            file << line << "\n";
    }
}

bool reg_read_dword(const wchar_t *name, DWORD *value)
{
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRegKey, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS)
        return false;
    DWORD size = sizeof(DWORD);
    DWORD type = 0;
    const bool ok =
        RegQueryValueExW(key, name, nullptr, &type, reinterpret_cast<LPBYTE>(value), &size)
            == ERROR_SUCCESS
        && type == REG_DWORD;
    RegCloseKey(key);
    return ok;
}

std::wstring reg_read_string(const wchar_t *name)
{
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRegKey, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS)
        return std::wstring();
    wchar_t buffer[64] = {};
    DWORD size = sizeof(buffer);
    DWORD type = 0;
    const bool ok = RegQueryValueExW(key, name, nullptr, &type,
                                     reinterpret_cast<LPBYTE>(buffer), &size)
        == ERROR_SUCCESS
        && type == REG_SZ;
    RegCloseKey(key);
    return ok ? std::wstring(buffer) : std::wstring();
}

bool reg_write_string(const wchar_t *name, const std::wstring &value)
{
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRegKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr,
                        &key, nullptr)
        != ERROR_SUCCESS)
        return false;
    const size_t bytes = (value.size() + 1) * sizeof(wchar_t);
    const bool ok = RegSetValueExW(key, name, 0, REG_SZ,
                                   reinterpret_cast<const BYTE *>(value.c_str()),
                                   static_cast<DWORD>(bytes))
        == ERROR_SUCCESS;
    RegCloseKey(key);
    return ok;
}

bool reg_delete_value(const wchar_t *name)
{
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRegKey, 0, KEY_SET_VALUE, &key) != ERROR_SUCCESS)
        return false;
    const bool ok = RegDeleteValueW(key, name) == ERROR_SUCCESS;
    RegCloseKey(key);
    return ok;
}

// 旧版 LastUpdateCheck 是 DWORD，升级后按字符串读会失败——兼容读一次 DWORD

std::string current_os_version()
{
    // Mote 只支持 Windows 10 及以上（WebView2 与 DPI 接口的最低要求），这里直接给 10.0。
    // 不用 IsWindows10OrGreater 这类函数：它们依赖 manifest 的 supportedOS 声明，
    // 没有声明时会把 Win10/11 报成 6.1，导致 min_os 比较误判为「系统太旧」。
    return "10.0";
}

// 安装版与绿色版只差「更新包形态」：安装版目录里有卸载器 unins000.exe。
// 按可执行文件同级是否存在卸载器判断，不依赖安装路径，绿色版解压到哪都成立。
bool running_installed_copy()
{
    wchar_t path[MAX_PATH] = {};
    const DWORD length = GetModuleFileNameW(nullptr, path, MAX_PATH);
    if (length == 0 || length >= MAX_PATH)
        return false;
    const std::filesystem::path exe(path);
    return std::filesystem::exists(exe.parent_path() / L"unins000.exe");
}

// 按安装形态挑更新包：安装版用 artifacts.setup，绿色包用 artifacts.portable；
// 对应产物缺失（清单只给了一种）时回落到另一形态，避免清单直接失效。
struct UpdateTarget {
    std::string url;
    std::string sha256;
    long long size = 0;
    bool installer = false;
};

UpdateTarget pick_target(const UpdateManifest &manifest)
{
    UpdateTarget target;
    const bool installed = running_installed_copy();
    const UpdateArtifact &preferred = installed ? manifest.setup : manifest.portable;
    const UpdateArtifact &fallback = installed ? manifest.portable : manifest.setup;
    const UpdateArtifact &chosen = !preferred.url.empty() ? preferred : fallback;
    target.url = chosen.url;
    target.sha256 = chosen.sha256;
    target.size = chosen.size;
    // 拿到安装包（setup.exe）就静默安装；拿到绿色包 zip 就交给用户解压
    target.installer = installed ? !preferred.url.empty() : preferred.url.empty();
    return target;
}

std::wstring human_size(long long bytes)
{
    if (bytes <= 0)
        return std::wstring();
    wchar_t buffer[64] = {};
    std::swprintf(buffer, sizeof(buffer) / sizeof(buffer[0]), L"%.1f MB",
                  static_cast<double>(bytes) / (1024.0 * 1024.0));
    return buffer;
}

// 主窗口注入：判断未保存修改、以及在安装程序拉起后正常退出
std::function<bool()> g_is_dirty;
std::function<void()> g_quit;

