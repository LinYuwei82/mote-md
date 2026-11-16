#include "updater.h"

#include "core/update.h"
#include "dialogs.h"
#include "env.h"

#include <commctrl.h>
#include <shellapi.h>
#include <winhttp.h>

#include <cstdarg>
#include <cstdio>
#include <ctime>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#ifndef MOTE_VERSION
#define MOTE_VERSION "0.0.0"
#endif

namespace mote::win {

namespace {

// 与 macOS 的 SUFeedURL 同源：清单放在 updates/stable/ 下，WINDOWS 用独立文件名
constexpr wchar_t kDefaultManifestUrl[] =
    L"https://dl.xiaotu.online/mote/updates/stable/windows.json";
constexpr DWORD kCheckIntervalSeconds = 24 * 60 * 60;
constexpr UINT kStartupDelayMs = 10 * 1000;
constexpr int kRequestTimeoutMs = 15 * 1000;
constexpr wchar_t kRegKey[] = L"Software\\Mote";
constexpr wchar_t kLastCheckValue[] = L"LastUpdateCheck";
constexpr wchar_t kSkippedValue[] = L"SkippedUpdateVersion";

std::wstring utf8_to_wide(const std::string &text)
{
    if (text.empty())
        return std::wstring();
    const int length = MultiByteToWideChar(CP_UTF8, 0, text.data(),
                                           static_cast<int>(text.size()), nullptr, 0);
    std::wstring wide(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        wide.data(), length);
    return wide;
}

std::string wide_to_utf8(const std::wstring &text)
{
    if (text.empty())
        return std::string();
    const int length = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                           static_cast<int>(text.size()), nullptr, 0,
                                           nullptr, nullptr);
    std::string narrow(static_cast<size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        narrow.data(), length, nullptr, nullptr);
    return narrow;
}

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

bool reg_write_dword(const wchar_t *name, DWORD value)
{
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRegKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr,
                        &key, nullptr)
        != ERROR_SUCCESS)
        return false;
    const bool ok = RegSetValueExW(key, name, 0, REG_DWORD,
                                   reinterpret_cast<const BYTE *>(&value), sizeof(value))
        == ERROR_SUCCESS;
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

class InternetHandle
{
public:
    explicit InternetHandle(HINTERNET handle) : handle_(handle) {}
    ~InternetHandle()
    {
        if (handle_)
            WinHttpCloseHandle(handle_);
    }
    InternetHandle(const InternetHandle &) = delete;
    InternetHandle &operator=(const InternetHandle &) = delete;
    HINTERNET get() const { return handle_; }

private:
    HINTERNET handle_ = nullptr;
};

// 同步 GET，只在后台线程里调用；失败时 error 给出中文原因
bool fetch_url(const std::wstring &url, std::string *body, std::wstring *error)
{
    URL_COMPONENTS parts = {};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) {
        if (error)
            *error = L"更新地址不合法";
        return false;
    }

    const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength > 0)
        path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);

    const InternetHandle session(
        WinHttpOpen(L"Mote/" MOTE_VERSION, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.get()) {
        if (error)
            *error = L"无法初始化网络会话";
        return false;
    }
    WinHttpSetTimeouts(session.get(), kRequestTimeoutMs, kRequestTimeoutMs,
                       kRequestTimeoutMs, kRequestTimeoutMs);

    const InternetHandle connection(
        WinHttpConnect(session.get(), host.c_str(), parts.nPort, 0));
    if (!connection.get()) {
        if (error)
            *error = L"无法连接更新服务器";
        return false;
    }

    const DWORD flags = parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
    const InternetHandle request(WinHttpOpenRequest(connection.get(), L"GET", path.c_str(),
                                                    nullptr, WINHTTP_NO_REFERER,
                                                    WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
    if (!request.get()) {
        if (error)
            *error = L"无法创建更新请求";
        return false;
    }

    if (!WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request.get(), nullptr)) {
        if (error)
            *error = L"请求更新清单失败" + std::to_wstring(GetLastError());
        return false;
    }

    DWORD status = 0;
    DWORD status_size = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(),
                             WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size,
                             WINHTTP_NO_HEADER_INDEX)) {
        if (error)
            *error = L"无法读取服务器响应";
        return false;
    }
    if (status != 200) {
        if (error)
            *error = L"服务器返回 HTTP " + std::to_wstring(status);
        return false;
    }

    body->clear();
    std::vector<char> buffer(16 * 1024);
    for (;;) {
        DWORD read = 0;
        if (!WinHttpReadData(request.get(), buffer.data(),
                             static_cast<DWORD>(buffer.size()), &read)) {
            if (error)
                *error = L"读取更新清单失败";
            return false;
        }
        if (read == 0)
            break;
        body->append(buffer.data(), read);
    }
    return true;
}

// Mote 只支持 Windows 10 及以上（WebView2 与 DPI 接口的最低要求），这里直接给 10.0。
// 不用 IsWindows10OrGreater 这类函数：它们依赖 manifest 的 supportedOS 声明，
// 没有声明时会把 Win10/11 报成 6.1，导致 min_os 比较误判为「系统太旧」。
std::string current_os_version()
{
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

// 按安装形态挑更新包：安装版优先用清单里的 setup_url，
// 清单没给（旧清单）时回落到 url，避免老清单直接失效。
struct UpdateTarget {
    std::string url;
    long long size = 0;
    bool installer = false;
};

UpdateTarget pick_target(const UpdateManifest &manifest)
{
    UpdateTarget target;
    if (running_installed_copy() && !manifest.setup_url.empty()) {
        target.url = manifest.setup_url;
        target.size = manifest.setup_size;
        target.installer = true;
    } else {
        target.url = manifest.url;
        target.size = manifest.size;
    }
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

struct CheckResult {
    bool ok = false;
    bool interactive = false;
    std::string error;
    UpdateManifest manifest;
    UpdateDecision decision = UpdateDecision::Invalid;
};

void check_in_background(HWND hwnd, bool interactive)
{
    const std::string override_url = env_value("MOTE_UPDATE_URL");
    const std::wstring url =
        override_url.empty() ? std::wstring(kDefaultManifestUrl) : utf8_to_wide(override_url);

    if (log_enabled())
        update_log("GET %s", wide_to_utf8(url).c_str());

    // 网络与解析都在后台线程；结果指针的所有权交给窗口线程
    std::thread([hwnd, url, interactive] {
        auto result = std::make_unique<CheckResult>();
        result->interactive = interactive;

        std::string body;
        std::wstring net_error;
        if (!fetch_url(url, &body, &net_error)) {
            result->error = wide_to_utf8(net_error);
        } else if (!parseUpdateManifest(body, result->manifest, &result->error)) {
            // parseUpdateManifest 直接给中文原因
        } else {
            result->ok = true;
            result->decision =
                decideUpdate(result->manifest, MOTE_VERSION, current_os_version());
        }

        CheckResult *raw = result.release();
        if (!PostMessageW(hwnd, kUpdateResultMessage, 0, reinterpret_cast<LPARAM>(raw)))
            delete raw;
    }).detach();
}

// 返回 true 表示用户选择「下载并安装」
bool prompt_install(HWND hwnd, const UpdateManifest &manifest, const UpdateTarget &target)
{
    std::wstring content = L"当前版本 " + utf8_to_wide(MOTE_VERSION) + L"。";
    if (!manifest.published_at.empty())
        content += L"\n发布时间：" + utf8_to_wide(manifest.published_at);
    const std::wstring size = human_size(target.size);
    if (!size.empty())
        content += L"\n安装包大小：" + size;
    content += target.installer
        ? L"\n\n当前是安装版：将下载安装包（.exe），运行后按向导覆盖安装。"
        : L"\n\n当前是绿色版：将下载免安装包（.zip），解压覆盖即可完成更新。";

    const std::wstring title = L"发现新版本 " + utf8_to_wide(manifest.version);

    TASKDIALOGCONFIG config = {};
    config.cbSize = sizeof(config);
    config.hwndParent = hwnd;
    config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
    config.pszWindowTitle = L"Mote";
    config.pszMainIcon = TD_INFORMATION_ICON;
    config.pszMainInstruction = title.c_str();
    config.pszContent = content.c_str();
    const TASKDIALOG_BUTTON buttons[] = {
        {1001, L"下载并安装"},
        {1002, L"稍后"},
    };
    config.pButtons = buttons;
    config.cButtons = ARRAYSIZE(buttons);

    int pressed = 0;
    if (FAILED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr)))
        return MessageBoxW(hwnd, content.c_str(), title.c_str(),
                           MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON1)
            == IDYES;
    return pressed == 1001;
}

void show_result(HWND hwnd, const CheckResult &result)
{
    if (!result.ok) {
        if (log_enabled())
            update_log("check failed: %s", result.error.c_str());
        if (result.interactive)
            MoteAlert(hwnd, L"检查更新失败",
                      result.error.empty() ? "无法获取更新清单" : result.error);
        return;
    }

    if (log_enabled())
        update_log("current=%s latest=%s os=%s decision=%d", MOTE_VERSION,
                   result.manifest.version.c_str(), current_os_version().c_str(),
                   static_cast<int>(result.decision));

    switch (result.decision) {
    case UpdateDecision::Invalid:
        if (result.interactive)
            MoteAlert(hwnd, L"检查更新失败", "更新清单缺少版本号或下载地址。");
        return;
    case UpdateDecision::UpToDate:
        if (result.interactive)
            MoteAlert(hwnd, L"已是最新版本",
                      std::string("当前版本 ") + MOTE_VERSION + " 已经是最新版本。");
        return;
    case UpdateDecision::UnsupportedSystem:
        if (result.interactive)
            MoteAlert(hwnd, L"新版本不支持当前系统",
                      "最新版本 " + result.manifest.version + " 需要 Windows "
                          + (result.manifest.min_os.empty() ? "10" : result.manifest.min_os)
                          + " 或更高。");
        return;
    case UpdateDecision::Available:
        break;
    }

    const UpdateTarget target = pick_target(result.manifest);
    if (log_enabled())
        update_log("target=%s installed=%d", target.url.c_str(),
                   target.installer ? 1 : 0);

    // 后台检查不打扰用户：同一版本点过「稍后」后，等下次发布再说
    const std::wstring skipped = reg_read_string(kSkippedValue);
    const std::wstring latest = utf8_to_wide(result.manifest.version);
    if (!result.interactive && !skipped.empty() && skipped == latest) {
        if (log_enabled())
            update_log("skip prompt for version=%s", result.manifest.version.c_str());
        return;
    }

    if (!prompt_install(hwnd, result.manifest, target)) {
        reg_write_string(kSkippedValue, latest);
        return;
    }

    reg_delete_value(kSkippedValue);
    const std::wstring url = utf8_to_wide(target.url);
    ShellExecuteW(hwnd, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

} // namespace

void start_update_checker(HWND hwnd)
{
    SetTimer(hwnd, kUpdateTimer, kStartupDelayMs, nullptr);
}

void run_update_timer(HWND hwnd)
{
    // 首次由 10 秒定时器触发，之后固定 24 小时；节流看注册表里的上次检查时间，
    // 这样频繁重启不会每次都打服务器。
    KillTimer(hwnd, kUpdateTimer);
    SetTimer(hwnd, kUpdateTimer, static_cast<UINT>(kCheckIntervalSeconds) * 1000, nullptr);

    const DWORD now = static_cast<DWORD>(std::time(nullptr));
    DWORD last = 0;
    if (reg_read_dword(kLastCheckValue, &last) && last > 0 && now >= last
        && now - last < kCheckIntervalSeconds) {
        if (log_enabled())
            update_log("skip background check (last %lu s ago)",
                       static_cast<unsigned long>(now - last));
        return;
    }

    reg_write_dword(kLastCheckValue, now);
    check_in_background(hwnd, false);
}

void check_for_updates_now(HWND hwnd)
{
    check_in_background(hwnd, true);
}

bool handle_update_message(HWND hwnd, LPARAM lparam)
{
    std::unique_ptr<CheckResult> result(reinterpret_cast<CheckResult *>(lparam));
    if (result)
        show_result(hwnd, *result);
    return true;
}

} // namespace mote::win
