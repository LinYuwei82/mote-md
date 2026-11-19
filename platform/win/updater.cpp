#include "updater.h"

#include "core/update.h"
#include "core/verify_signature.h"
#include "dialogs.h"
#include "env.h"

#include <bcrypt.h>
#include <commctrl.h>
#include <shellapi.h>
#include <winhttp.h>

#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <ctime>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#ifndef MOTE_VERSION
#define MOTE_VERSION "0.0.0"
#endif

// Windows 构建号：发布时由 CMake -DMOTE_BUILD=202611180530 注入（见
// native/CMakeLists.txt）。清单同版本时靠 build 判断是否有新构建；
// 0（未知）时跳过 build 比较，仅按 version。
#ifndef MOTE_BUILD
#define MOTE_BUILD 0
#endif

#if !defined(MOTE_BUILD_STR)
#define MOTE_BUILD_STR "0"
#endif

// 发布门禁用的构建号字符串：guard.py preflight 会在绿色包/安装包的 Mote.exe
// 里搜索 "MOTE_BUILD=<digits>" 并与 --build 参数比对，防止清单 build 与编译值
// 不一致导致客户端反复提示同一版本（2026-11-19 mote 1.0.4 即因此重发）。
static const char kBuildStamp[] = "MOTE_BUILD=" MOTE_BUILD_STR;
[[maybe_unused]] static const char* kBuildStampRef = kBuildStamp;

namespace mote::win {

namespace {

// 与 macOS 的 SUFeedURL 同源：v2 统一清单放在 updates/stable/manifest.json
constexpr wchar_t kDefaultManifestUrl[] =
    L"https://dl.xiaotu.online/mote/updates/stable/manifest.json";
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

// 由主窗口注入：判断未保存修改、以及在安装程序拉起后正常退出
std::function<bool()> g_is_dirty;
std::function<void()> g_quit;

// ---- 下载与校验 ----

std::wstring url_file_name(const std::wstring &url)
{
    std::wstring path = url;
    const size_t query = path.find(L'?');
    if (query != std::wstring::npos)
        path.resize(query);
    const size_t slash = path.find_last_of(L'/');
    std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
    if (name.empty())
        name = L"Mote-update.bin";
    return name;
}

std::string to_hex(const std::vector<UCHAR> &bytes)
{
    static const char digits[] = "0123456789abcdef";
    std::string hex;
    hex.reserve(bytes.size() * 2);
    for (UCHAR byte : bytes) {
        hex.push_back(digits[byte >> 4]);
        hex.push_back(digits[byte & 0x0F]);
    }
    return hex;
}

bool sha256_file(const std::filesystem::path &path, std::string *hex)
{
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return false;

    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD object_size = 0;
    DWORD digest_size = 0;
    DWORD produced = 0;
    bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0
        && BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                             reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size),
                             &produced, 0) == 0
        && BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                             reinterpret_cast<PUCHAR>(&digest_size), sizeof(digest_size),
                             &produced, 0) == 0;

    std::vector<UCHAR> object;
    std::vector<UCHAR> digest;
    if (ok) {
        object.resize(object_size);
        digest.resize(digest_size);
        ok = BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) == 0;
    }

    std::vector<UCHAR> buffer(64 * 1024);
    while (ok) {
        DWORD read = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
            ok = false;
            break;
        }
        if (read == 0)
            break;
        ok = BCryptHashData(hash, buffer.data(), read, 0) == 0;
    }
    if (ok)
        ok = BCryptFinishHash(hash, digest.data(), digest_size, 0) == 0;
    if (ok)
        *hex = to_hex(digest);

    if (hash)
        BCryptDestroyHash(hash);
    if (algorithm)
        BCryptCloseAlgorithmProvider(algorithm, 0);
    CloseHandle(file);
    return ok;
}

bool equals_ignore_case(const std::string &left, const std::string &right)
{
    if (left.size() != right.size())
        return false;
    for (size_t i = 0; i < left.size(); ++i) {
        const char a = static_cast<char>(std::tolower(static_cast<unsigned char>(left[i])));
        const char b = static_cast<char>(std::tolower(static_cast<unsigned char>(right[i])));
        if (a != b)
            return false;
    }
    return true;
}

struct DownloadState {
    std::atomic<bool> finished{false};
    std::atomic<bool> cancel{false};
    std::atomic<long long> written{0};
    std::atomic<long long> expected_size{0}; // 只读，Content-Length 读到后赋值
    std::string expected_sha256; // 只读，线程启动前赋值
    std::string manifest_text;   // 只读，原始清单 JSON；下载完成后验签用
    bool ok = false;
    std::wstring error;
    std::filesystem::path path;
};

// 流式下载到本地文件；只在后台线程调用
// retryable（输出）：失败时置 true 表示网络/服务器临时问题，调用方可重试；
//                   false 表示地址非法 / 磁盘权限 / 4xx 等不可恢复错误。
bool download_file(const std::wstring &url, const std::filesystem::path &dest,
                   DownloadState *state, bool *retryable)
{
    if (retryable) *retryable = false;

    URL_COMPONENTS parts = {};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) {
        state->error = L"更新地址不合法";
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
        state->error = L"无法初始化网络会话";
        if (retryable) *retryable = true;
        return false;
    }
    // 下载可能较慢：连接/发送用短超时，接收放宽到 60 秒
    WinHttpSetTimeouts(session.get(), kRequestTimeoutMs, kRequestTimeoutMs, 60 * 1000,
                       kRequestTimeoutMs);

    const InternetHandle connection(WinHttpConnect(session.get(), host.c_str(), parts.nPort, 0));
    if (!connection.get()) {
        state->error = L"无法连接更新服务器";
        if (retryable) *retryable = true;
        return false;
    }

    const DWORD flags = parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
    const InternetHandle request(WinHttpOpenRequest(connection.get(), L"GET", path.c_str(),
                                                    nullptr, WINHTTP_NO_REFERER,
                                                    WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
    if (!request.get()) {
        state->error = L"无法创建下载请求";
        if (retryable) *retryable = true;
        return false;
    }
    if (!WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request.get(), nullptr)) {
        state->error = L"下载请求失败";
        if (retryable) *retryable = true;
        return false;
    }

    DWORD status = 0;
    DWORD status_size = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(),
                             WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size,
                             WINHTTP_NO_HEADER_INDEX)) {
        state->error = L"无法读取服务器响应";
        if (retryable) *retryable = true;
        return false;
    }
    if (status != 200) {
        state->error = L"服务器返回 HTTP " + std::to_wstring(status);
        // 5xx 服务器临时错误可重试；4xx（404/403/401 等）直接放弃
        if (retryable) *retryable = status >= 500 && status < 600;
        return false;
    }

    // 读 Content-Length：有了才启用百分比进度条
    ULONGLONG content_len = 0;
    DWORD cl_size = sizeof(content_len);
    if (WinHttpQueryHeaders(request.get(),
                            WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER64,
                            WINHTTP_HEADER_NAME_BY_INDEX, &content_len, &cl_size,
                            WINHTTP_NO_HEADER_INDEX)) {
        state->expected_size.store(static_cast<long long>(content_len));
    }

    HANDLE file = CreateFileW(dest.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        state->error = L"无法写入临时文件";
        return false;
    }

    bool ok = true;
    std::vector<char> buffer(64 * 1024);
    for (;;) {
        if (state->cancel.load()) {
            ok = false;
            break;
        }
        DWORD read = 0;
        if (!WinHttpReadData(request.get(), buffer.data(), static_cast<DWORD>(buffer.size()),
                             &read)) {
            state->error = L"下载中断";
            ok = false;
            if (retryable) *retryable = true;
            break;
        }
        if (read == 0)
            break;
        DWORD written = 0;
        if (!WriteFile(file, buffer.data(), read, &written, nullptr) || written != read) {
            state->error = L"写入更新包失败";
            ok = false;
            break;
        }
        state->written += written;
    }
    CloseHandle(file);
    return ok;
}

HRESULT CALLBACK download_dialog_callback(HWND hwnd, UINT msg, WPARAM, LPARAM, LONG_PTR data)
{
    auto *state = reinterpret_cast<DownloadState *>(data);
    switch (msg) {
    case TDN_TIMER:
        if (state->finished.load()) {
            SendMessageW(hwnd, TDM_CLICK_BUTTON, IDOK, 0);
        } else {
            const long long written = state->written.load();
            const long long expected = state->expected_size.load();
            std::wstring text;
            if (expected > 0) {
                const int pct = static_cast<int>(written * 100 / expected);
                text = std::to_wstring(pct) + L"% — "
                    + (written > 0 ? human_size(written) : L"0 MB")
                    + L" / " + human_size(expected);
                SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_POS, pct, 0);
            } else {
                // 服务器没给 Content-Length，保持 MB 口径
                text = L"已下载 "
                    + (written > 0 ? human_size(written) : L"0 MB");
            }
            SendMessageW(hwnd, TDM_SET_ELEMENT_TEXT, TDE_CONTENT,
                         reinterpret_cast<LPARAM>(text.c_str()));
        }
        return S_OK;
    case TDN_BUTTON_CLICKED:
        if (!state->finished.load())
            state->cancel = true;
        return S_OK;
    }
    return S_OK;
}

// 阻塞展示下载对话框，工作线程由调用方负责 join
void run_download_dialog(HWND hwnd, DownloadState *state, std::thread *worker)
{
    TASKDIALOGCONFIG config = {};
    config.cbSize = sizeof(config);
    config.hwndParent = hwnd;
    config.dwFlags =
        TDF_ALLOW_DIALOG_CANCELLATION | TDF_CALLBACK_TIMER | TDF_POSITION_RELATIVE_TO_WINDOW
        | TDF_SHOW_PROGRESS_BAR;
    config.pszWindowTitle = L"Mote";
    config.pszMainIcon = TD_INFORMATION_ICON;
    config.pszMainInstruction = L"正在下载更新…";
    config.pszContent = L"正在连接更新服务器。";
    config.pfCallback = download_dialog_callback;
    config.lpCallbackData = reinterpret_cast<LONG_PTR>(state);
    TaskDialogIndirect(&config, nullptr, nullptr, nullptr);

    if (!state->finished.load())
        state->cancel = true;
    if (worker->joinable())
        worker->join();
}

// 用户确认后：下载 → 验清单签名 → 校验 SHA256 → 安装版静默升级 / 绿色版交给用户解压
void begin_download(HWND hwnd, const UpdateTarget &target, const std::string &manifestText)
{
    // 安装版会覆盖当前目录的可执行文件，绿色版要求用户解压覆盖也得先退出；
    // 两条路径都要先保存，否则 quit 流程可能因保存确认而被用户取消，更新包已下载却退出不了
    if (g_is_dirty && g_is_dirty()) {
        MoteAlert(hwnd, L"请先保存", "文档有未保存的修改，保存后再更新。");
        return;
    }
    if (target.sha256.empty()) {
        MoteAlert(hwnd, L"无法校验更新包", "更新清单缺少 SHA256，已取消下载。");
        return;
    }

    wchar_t temp[MAX_PATH] = {};
    if (GetTempPathW(MAX_PATH, temp) == 0) {
        MoteAlert(hwnd, L"下载失败", "无法定位临时目录。");
        return;
    }
    std::error_code ec;
    const std::filesystem::path dir = std::filesystem::path(temp) / L"Mote-update";
    std::filesystem::create_directories(dir, ec);
    const std::filesystem::path dest = dir / url_file_name(utf8_to_wide(target.url));
    std::filesystem::remove(dest, ec);

    DownloadState state;
    state.expected_sha256 = target.sha256;
    state.manifest_text = manifestText;
    state.path = dest;
    DownloadState *raw = &state;

    if (log_enabled())
        update_log("download %s -> %s", target.url.c_str(),
                   wide_to_utf8(dest.wstring()).c_str());

    std::thread worker([url = utf8_to_wide(target.url), dest, raw] {
        constexpr int kMaxAttempts = 3;
        constexpr int kRetryIntervalMs = 2000;

        bool ok = false;
        for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
            bool retryable = false;
            if (log_enabled())
                update_log("download attempt %d/%d", attempt, kMaxAttempts);
            ok = download_file(url, dest, raw, &retryable);
            if (ok)
                break;
            // 用户点了取消：不再重试
            if (raw->cancel.load())
                break;
            // 不可重试（地址非法 / 磁盘权限 / 4xx）：直接放弃
            if (!retryable) {
                if (log_enabled())
                    update_log("download failed (non-retryable): %s",
                               wide_to_utf8(raw->error).c_str());
                break;
            }
            if (attempt < kMaxAttempts) {
                if (log_enabled())
                    update_log("download failed (retryable), sleep %d ms before retry",
                               kRetryIntervalMs);
                std::this_thread::sleep_for(
                    std::chrono::milliseconds(kRetryIntervalMs));
                // 重置进度条，让 UI 重新从 0 开始
                raw->written.store(0);
                raw->expected_size.store(0);
            }
        }

        if (ok) {
            // 先验清单 Ed25519 签名（公钥编译进客户端）：清单被篡改则放弃更新
            std::string verify_error;
            if (!verifyUpdateManifestSignature(raw->manifest_text, kUpdateManifestPublicKey,
                                               &verify_error)) {
                ok = false;
                raw->error = L"更新清单验签失败，已放弃更新。";
                if (log_enabled())
                    update_log("manifest verify failed: %s", verify_error.c_str());
            }
        }
        if (ok) {
            std::string actual;
            if (!sha256_file(dest, &actual)) {
                ok = false;
                raw->error = L"无法计算下载文件的哈希";
            } else if (!equals_ignore_case(actual, raw->expected_sha256)) {
                ok = false;
                raw->error = L"更新包校验失败（SHA256 不一致），已删除下载内容。";
            }
        }
        raw->ok = ok;
        raw->finished = true;
    });

    run_download_dialog(hwnd, raw, &worker);

    if (!raw->ok) {
        std::filesystem::remove(dest, ec);
        if (raw->cancel && raw->error.empty()) {
            if (log_enabled())
                update_log("download cancelled");
            return;
        }
        if (log_enabled())
            update_log("download failed: %s", wide_to_utf8(raw->error).c_str());
        MoteAlert(hwnd, L"更新失败",
                  raw->error.empty() ? "下载更新包失败。" : wide_to_utf8(raw->error));
        return;
    }

    if (log_enabled())
        update_log("download ok bytes=%lld", raw->written.load());

    if (target.installer) {
        // /RELAUNCH=1 由 mote.iss 的 [Run] 识别，安装完成后自动启动新版本
        const std::wstring params =
            L"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RELAUNCH=1";
        const HINSTANCE launched =
            ShellExecuteW(hwnd, L"open", dest.c_str(), params.c_str(), nullptr, SW_SHOWNORMAL);
        if (reinterpret_cast<INT_PTR>(launched) <= 32) {
            MoteAlert(hwnd, L"无法启动安装程序",
                      "更新包已下载，请手动运行：\n" + wide_to_utf8(dest.wstring()));
            return;
        }
        if (log_enabled())
            update_log("installer launched, quitting");
        if (g_quit)
            g_quit();
        return;
    }

    // 绿色版：Mote.exe 正在运行，覆盖前必须先退出，否则解压会被「文件被占用」挡住
    MoteAlert(hwnd, L"更新包已下载",
              "已通过清单签名与 SHA256 校验：\n" + wide_to_utf8(dest.wstring())
                  + "\n\n将打开所在文件夹并退出 Mote，解压覆盖后重新打开即可。");
    const std::wstring args = L"/select,\"" + dest.wstring() + L"\"";
    ShellExecuteW(hwnd, L"open", L"explorer.exe", args.c_str(), nullptr, SW_SHOWNORMAL);
    if (g_quit)
        g_quit();
}

struct CheckResult {
    bool ok = false;
    bool interactive = false;
    std::string error;
    std::string manifest_text; // 原始清单 JSON，下载完成后验签用
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
        } else {
            result->manifest_text = body;
            // parseUpdateManifest 直接给中文原因
            if (!parseUpdateManifest(body, UpdatePlatform::Windows, result->manifest,
                                     &result->error)) {
            } else {
                result->ok = true;
                // 同版本时按构建号比较：本机 build 来自编译期宏 MOTE_BUILD
                result->decision = decideUpdate(result->manifest, UpdatePlatform::Windows,
                                                MOTE_VERSION, current_os_version(), MOTE_BUILD);
            }
        }

        CheckResult *raw = result.release();
        if (!PostMessageW(hwnd, kUpdateResultMessage, 0, reinterpret_cast<LPARAM>(raw)))
            delete raw;
    }).detach();
}

// 「发现新版本」弹窗里的超链接：TDF_ENABLE_HYPERLINKS 只负责渲染，
// 点击后必须自己处理 TDN_HYPERLINK_CLICKED，否则点了没有任何反应
HRESULT CALLBACK install_dialog_callback(HWND hwnd, UINT message, WPARAM, LPARAM lparam,
                                         LONG_PTR)
{
    if (message == TDN_HYPERLINK_CLICKED && lparam) {
        const wchar_t *link = reinterpret_cast<const wchar_t *>(lparam);
        ShellExecuteW(hwnd, L"open", link, nullptr, nullptr, SW_SHOWNORMAL);
    }
    return S_OK;
}

// 返回 true 表示用户选择「下载并安装」
bool prompt_install(HWND hwnd, const UpdateManifest &manifest, const UpdateTarget &target)
{
    std::wstring content = L"当前版本 " + utf8_to_wide(MOTE_VERSION) + L"。";
    if (!manifest.updated_at.empty())
        content += L"\n更新时间：" + utf8_to_wide(manifest.updated_at);
    const std::wstring size = human_size(target.size);
    if (!size.empty())
        content += L"\n安装包大小：" + size;
    content += target.installer
        ? L"\n\n当前是安装版：将下载安装包、验签并校验 SHA256 后静默安装并重启。"
        : L"\n\n当前是绿色版：将下载并校验更新包，随后打开所在文件夹，解压覆盖即可。";

    const std::wstring plain_content = content;
    bool has_notes = false;
    if (!manifest.notes_url.empty()) {
        content += L"\n\n<a href=\"" + utf8_to_wide(manifest.notes_url)
            + L"\">查看完整更新说明…</a>";
        has_notes = true;
    }

    const std::wstring title = L"发现新版本 " + utf8_to_wide(manifest.version);

    TASKDIALOGCONFIG config = {};
    config.cbSize = sizeof(config);
    config.hwndParent = hwnd;
    config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW
        | (has_notes ? TDF_ENABLE_HYPERLINKS : 0);
    config.pszWindowTitle = L"Mote";
    config.pszMainIcon = TD_INFORMATION_ICON;
    config.pszMainInstruction = title.c_str();
    config.pszContent = content.c_str();
    config.pfCallback = install_dialog_callback;
    const TASKDIALOG_BUTTON buttons[] = {
        {1001, L"下载更新"},
        {1002, L"稍后"},
    };
    config.pButtons = buttons;
    config.cButtons = ARRAYSIZE(buttons);

    int pressed = 0;
    if (FAILED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr))) {
        // 退回 MessageBox 时不能带 <a> 标记，否则会原样显示成尖括号文本
        std::wstring plain = plain_content;
        if (!manifest.notes_url.empty())
            plain += L"\n\n更新说明：" + utf8_to_wide(manifest.notes_url);
        return MessageBoxW(hwnd, plain.c_str(), title.c_str(),
                           MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON1)
            == IDYES;
    }
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
    begin_download(hwnd, target, result.manifest_text);
}

} // namespace

void set_update_hooks(std::function<bool()> is_dirty, std::function<void()> quit)
{
    g_is_dirty = std::move(is_dirty);
    g_quit = std::move(quit);
}

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
