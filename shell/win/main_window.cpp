#include "main_window.h"

#include "dialogs.h"
#include "drop_target.h"
#include "env.h"
#include "html_export.h"
#include "menus.h"
#include "pdf_export.h"
#include "updater_win.h"
#include "web_host_view.h"

#include "core/editor_controller.h"
#include "core/js_bridge.h"
#include "core/paths.h"
#include "core/perf.h"
#include "core/recent_files.h"
#include "core/text_encoding.h"
#include "mote/update_engine.h"
#include "win_encoding/encoding.h"

#include <shlobj.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <cctype>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <utility>

namespace {

constexpr wchar_t kWindowClass[] = L"MoteNativeWindow";
constexpr int kDefaultWidth = 1180;
constexpr int kDefaultHeight = 820;
constexpr int kMinWidth = 760;
constexpr int kMinHeight = 520;

constexpr UINT_PTR kStartupCommandTimer = 1;
constexpr UINT_PTR kSnapshotTimer = 2;
constexpr UINT_PTR kDropProbeTimer = 3;
// 5 起避开 updater_win.cpp 的 kUpdateTimer（4），否则 WM_TIMER 会被先匹配走
constexpr UINT_PTR kEvalTimer = 5;
constexpr UINT_PTR kOpen2Timer = 6;
// 键盘钩子截获的组合键回到窗口线程后，再用这条消息统一走 perform_command
constexpr UINT kShortcutMessage = WM_APP + 7;
// 单实例转发通知（路径经 forward_handoff_path 交接文件传递）
constexpr UINT kForwardMessage = WM_APP + 9;

using win_encoding::utf8_to_wide;
using win_encoding::wide_to_utf8;

void log_line(const std::string &text)
{
    const std::wstring wide = utf8_to_wide(text);
    OutputDebugStringW(wide.c_str());
    OutputDebugStringW(L"\n");
    const std::string path = env_value("MOTE_LOG");
    if (!path.empty()) {
        std::ofstream file(std::filesystem::path(utf8_to_wide(path)),
                           std::ios::app | std::ios::binary);
        if (file)
            file << text << "\n";
    }
}

std::string exe_directory()
{
    wchar_t buffer[MAX_PATH] = {};
    const DWORD length = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    std::wstring path(buffer, length);
    const size_t slash = path.find_last_of(L"\\/");
    return wide_to_utf8(slash == std::wstring::npos ? path : path.substr(0, slash));
}

std::string parent_dir(const std::string &path)
{
    const size_t slash = path.find_last_of("\\/");
    if (slash == std::string::npos)
        return std::string();
    if (slash == 0)
        return path.substr(0, 1);
    return path.substr(0, slash);
}

std::string file_name(const std::string &path)
{
    const size_t slash = path.find_last_of("\\/");
    return slash == std::string::npos ? path : path.substr(slash + 1);
}

std::string documents_dir()
{
    PWSTR raw = nullptr;
    std::string result;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Documents, 0, nullptr, &raw)) && raw)
        result = wide_to_utf8(raw);
    if (raw)
        CoTaskMemFree(raw);
    if (result.empty()) {
        wchar_t current[MAX_PATH] = {};
        GetCurrentDirectoryW(MAX_PATH, current);
        result = wide_to_utf8(current);
    }
    return result;
}

bool read_text_file(const std::string &path, std::string *text)
{
    std::ifstream file(std::filesystem::path(utf8_to_wide(path)), std::ios::binary);
    if (!file)
        return false;
    text->assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    *text = mote::normalizeTextEncoding(*text);
    // 老文档常是 GBK 等系统代码页编码：非 UTF-8 时按系统代码页兜底，否则打开就是乱码。
    *text = win_encoding::decode_strict_utf8_or_acp(*text);
    return true;
}

bool write_text_file(const std::string &path, const std::string &text)
{
    // 先写同目录临时文件再换名：写到一半崩溃或断电时，原文档仍是完整的一份。
    const std::filesystem::path target(utf8_to_wide(path));
    std::filesystem::path temp = target;
    temp += L".tmp-" + std::to_wstring(GetCurrentProcessId());
    {
        std::ofstream file(temp, std::ios::binary | std::ios::trunc);
        if (!file)
            return false;
        file.write(text.data(), static_cast<std::streamsize>(text.size()));
        file.flush();
        if (!file.good()) {
            file.close();
            std::error_code ignored;
            std::filesystem::remove(temp, ignored);
            return false;
        }
    }

    if (!ReplaceFileW(target.c_str(), temp.c_str(), nullptr,
                      REPLACEFILE_IGNORE_MERGE_ERRORS, nullptr, nullptr)) {
        const DWORD error = GetLastError();
        // 首次保存时目标还不存在，ReplaceFile 报 ERROR_FILE_NOT_FOUND；
        // 其它错误（被占用、无权限、目录不存在）保留原文件，清掉临时文件。
        if (error != ERROR_FILE_NOT_FOUND) {
            std::error_code ignored;
            std::filesystem::remove(temp, ignored);
            return false;
        }
        if (!MoveFileExW(temp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING)) {
            std::error_code ignored;
            std::filesystem::remove(temp, ignored);
            return false;
        }
    }
    return true;
}

std::string with_extension(std::string path, const char *extension)
{
    const size_t slash = path.find_last_of("\\/");
    const size_t dot = path.find_last_of('.');
    if (dot == std::string::npos || (slash != std::string::npos && dot < slash))
        path += std::string(".") + extension;
    return path;
}

int hex_value(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

// 解 %XX 并把 URL 路径里的 / 换成 Windows 的 \，结果可直接交给文件 API
std::string url_to_local_path(const std::string &text)
{
    std::string out;
    out.reserve(text.size());
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '%' && i + 2 < text.size()) {
            const int hi = hex_value(text[i + 1]);
            const int lo = hex_value(text[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>(hi * 16 + lo));
                i += 2;
                continue;
            }
        }
        out.push_back(text[i] == '/' ? '\\' : text[i]);
    }
    return out;
}

// 剪贴板里的 CF_DIB 是裸 BITMAPINFOHEADER + 像素；补 14 字节文件头后用
// WIC 的 BMP 解码器读入、PNG 编码器写出，得到与 macOS 一致的 PNG 资源。
bool encode_dib_to_png(const std::vector<std::uint8_t> &dib, std::vector<std::uint8_t> *png)
{
    if (dib.size() < sizeof(BITMAPINFOHEADER))
        return false;

    BITMAPINFOHEADER info = {};
    std::memcpy(&info, dib.data(), sizeof(info));

    using Microsoft::WRL::ComPtr;
    ComPtr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&factory))))
        return false;

    // 32bpp BI_RGB 的 alpha 字节在 BMP 规范里未定义，WIC 解码时会直接丢掉；
    // 浏览器和截图工具却常在这里写真实 alpha。只要这些字节既非全 0（视为
    // 未定义）也非全 255（不透明），就按 BGRA 原样送进 PNG 编码器。
    ComPtr<IWICBitmapSource> source;
    if (info.biBitCount == 32 && info.biCompression == BI_RGB && info.biWidth > 0
        && info.biHeight != 0) {
        const size_t width = static_cast<size_t>(info.biWidth);
        const size_t height = static_cast<size_t>(info.biHeight < 0 ? -info.biHeight
                                                                     : info.biHeight);
        const size_t stride = width * 4;
        const size_t offset = static_cast<size_t>(info.biSize);
        if (offset >= sizeof(BITMAPINFOHEADER) && dib.size() >= offset + stride * height) {
            const std::uint8_t *raw = dib.data() + offset;
            bool any_alpha = false;
            bool any_translucent = false;
            for (size_t pixel = 0; pixel < width * height; ++pixel) {
                const std::uint8_t alpha = raw[pixel * 4 + 3];
                any_alpha = any_alpha || alpha != 0;
                any_translucent = any_translucent || alpha != 255;
            }
            if (any_alpha && any_translucent) {
                std::vector<std::uint8_t> pixels(stride * height);
                const bool top_down = info.biHeight < 0;
                for (size_t row = 0; row < height; ++row) {
                    const size_t source_row = top_down ? row : height - 1 - row;
                    std::memcpy(pixels.data() + row * stride, raw + source_row * stride,
                                stride);
                }
                ComPtr<IWICBitmap> bitmap;
                if (SUCCEEDED(factory->CreateBitmapFromMemory(
                        static_cast<UINT>(width), static_cast<UINT>(height),
                        GUID_WICPixelFormat32bppBGRA, static_cast<UINT>(stride),
                        static_cast<UINT>(pixels.size()), pixels.data(), &bitmap)))
                    source = bitmap;
            }
        }
    }

    if (!source) {
        BITMAPFILEHEADER file = {};
        file.bfType = 0x4D42;
        file.bfOffBits = static_cast<DWORD>(sizeof(BITMAPFILEHEADER) + info.biSize);
        if (info.biBitCount <= 8) {
            const DWORD colors = info.biClrUsed ? info.biClrUsed : (1u << info.biBitCount);
            file.bfOffBits += colors * 4;
        } else if (info.biCompression == BI_BITFIELDS) {
            file.bfOffBits += 12;
        }
        file.bfSize = static_cast<DWORD>(sizeof(BITMAPFILEHEADER) + dib.size());

        std::vector<std::uint8_t> bmp(file.bfSize);
        std::memcpy(bmp.data(), &file, sizeof(file));
        std::memcpy(bmp.data() + sizeof(file), dib.data(), dib.size());

        ComPtr<IStream> input;
        input.Attach(SHCreateMemStream(bmp.data(), static_cast<UINT>(bmp.size())));
        if (!input)
            return false;

        ComPtr<IWICBitmapDecoder> decoder;
        if (FAILED(factory->CreateDecoderFromStream(input.Get(), nullptr,
                                                    WICDecodeMetadataCacheOnLoad,
                                                    &decoder)))
            return false;
        ComPtr<IWICBitmapFrameDecode> frame;
        if (FAILED(decoder->GetFrame(0, &frame)))
            return false;
        source = frame;
    }

    ComPtr<IStream> output;
    output.Attach(SHCreateMemStream(nullptr, 0));
    if (!output)
        return false;
    ComPtr<IWICBitmapEncoder> encoder;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)))
        return false;
    if (FAILED(encoder->Initialize(output.Get(), WICBitmapEncoderNoCache)))
        return false;

    ComPtr<IWICBitmapFrameEncode> encode_frame;
    ComPtr<IPropertyBag2> properties;
    if (FAILED(encoder->CreateNewFrame(&encode_frame, &properties)))
        return false;
    if (FAILED(encode_frame->Initialize(properties.Get())))
        return false;
    if (FAILED(encode_frame->WriteSource(source.Get(), nullptr)))
        return false;
    if (FAILED(encode_frame->Commit()) || FAILED(encoder->Commit()))
        return false;

    STATSTG stat = {};
    if (FAILED(output->Stat(&stat, STATFLAG_NONAME)))
        return false;
    LARGE_INTEGER start = {};
    output->Seek(start, STREAM_SEEK_SET, nullptr);
    png->assign(static_cast<size_t>(stat.cbSize.QuadPart), 0);
    ULONG read = 0;
    if (FAILED(output->Read(png->data(), static_cast<ULONG>(png->size()), &read)))
        return false;
    png->resize(read);
    return !png->empty();
}

bool clipboard_has_image()
{
    if (!IsClipboardFormatAvailable(CF_DIB))
        return IsClipboardFormatAvailable(RegisterClipboardFormatW(L"PNG"));
    return true;
}

void put_clipboard_bytes(UINT format, const std::string &bytes)
{
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes.size() + 1);
    if (!memory)
        return;
    if (void *target = GlobalLock(memory)) {
        memcpy(target, bytes.data(), bytes.size());
        static_cast<char *>(target)[bytes.size()] = '\0';
        GlobalUnlock(memory);
    }
    if (!SetClipboardData(format, memory))
        GlobalFree(memory);
}

// 单实例转发交接文件：两个进程会话不同（TEMP 可能指向不同用户目录），
// ProgramData 对双方都可读写。第二个实例写路径 + PostMessage 通知，
// 主实例读后即删——避免 SendMessage 跨进程同步阻塞消息循环。
std::wstring forward_handoff_path()
{
    wchar_t buf[MAX_PATH] = {};
    const DWORD n = GetEnvironmentVariableW(L"ProgramData", buf, MAX_PATH);
    std::wstring base = (n > 0 && n < MAX_PATH) ? buf : L"C:\\ProgramData";
    while (!base.empty() && (base.back() == L'\\' || base.back() == L'/'))
        base.pop_back();
    return base + L"\\Mote\\open_forward.txt";
}

// ---- 多窗口注册表（消息循环在 main.cpp，末窗销毁才 PostQuitMessage）----
std::vector<MoteMainWindow *> g_windows;
HINSTANCE g_instance = nullptr;

// 进程级低级键盘钩子：首窗装、末窗卸；修饰键状态全局维护（回调是 LL 级，
// 按队列顺序收到所有按键，比查窗口实例字段更可靠）
HHOOK g_keyboard_hook = nullptr;
bool g_hook_ctrl = false;
bool g_hook_shift = false;
bool g_hook_alt = false;
UINT g_last_shortcut_key = 0;

// 「最近打开」持久化：HKCU\Software\Mote 字符串值（与 updater_win 同一键路径）
class RegStore final : public mote::SettingsStore
{
public:
    std::string getString(const std::string &key) override
    {
        HKEY hkey = nullptr;
        if (RegOpenKeyExW(HKEY_CURRENT_USER, kRegKeyName, 0, KEY_QUERY_VALUE, &hkey)
            != ERROR_SUCCESS)
            return std::string();
        wchar_t buffer[8192] = {};
        DWORD size = sizeof(buffer);
        DWORD type = 0;
        const bool ok = RegQueryValueExW(hkey, utf8_to_wide(key).c_str(), nullptr, &type,
                                         reinterpret_cast<LPBYTE>(buffer), &size)
                == ERROR_SUCCESS
            && type == REG_SZ;
        RegCloseKey(hkey);
        return ok ? wide_to_utf8(buffer) : std::string();
    }
    void setString(const std::string &key, const std::string &value) override
    {
        HKEY hkey = nullptr;
        if (RegCreateKeyExW(HKEY_CURRENT_USER, kRegKeyName, 0, nullptr, 0, KEY_SET_VALUE,
                            nullptr, &hkey, nullptr)
            != ERROR_SUCCESS)
            return;
        const std::wstring wide = utf8_to_wide(value);
        const DWORD bytes = static_cast<DWORD>((wide.size() + 1) * sizeof(wchar_t));
        RegSetValueExW(hkey, utf8_to_wide(key).c_str(), 0, REG_SZ,
                       reinterpret_cast<const BYTE *>(wide.c_str()), bytes);
        RegCloseKey(hkey);
    }
    void clearString(const std::string &key) override
    {
        HKEY hkey = nullptr;
        if (RegOpenKeyExW(HKEY_CURRENT_USER, kRegKeyName, 0, KEY_SET_VALUE, &hkey)
            == ERROR_SUCCESS) {
            RegDeleteValueW(hkey, utf8_to_wide(key).c_str());
            RegCloseKey(hkey);
        }
    }
    std::string newInstallId() override { return std::string(); }

private:
    static constexpr wchar_t kRegKeyName[] = L"Software\\Mote";
};

mote::RecentFiles &recent_files()
{
    static RegStore store;
    static mote::RecentFiles recent(store);
    return recent;
}

// 比较用规范化：绝对 + 解析 junction/符号链接，失败退回原值
std::string canonical_path(const std::string &path)
{
    try {
        std::filesystem::path p(utf8_to_wide(path));
        std::error_code ec;
        std::filesystem::path resolved = std::filesystem::weakly_canonical(p, ec);
        if (!ec)
            return wide_to_utf8(resolved.wstring());
        return wide_to_utf8(std::filesystem::absolute(p).wstring());
    } catch (...) {
        return path;
    }
}

bool same_path(const std::string &a, const std::string &b)
{
    if (a.empty() || b.empty())
        return false;
    std::string left = canonical_path(a);
    std::string right = canonical_path(b);
    for (char &c : left) {
        if (c == '/')
            c = '\\';
        else if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c + ('a' - 'A'));
    }
    for (char &c : right) {
        if (c == '/')
            c = '\\';
        else if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c + ('a' - 'A'));
    }
    return left == right;
}

// 当前活跃窗口（更新模块钩子按前台路由，避免多窗口时指向已销毁实例）

} // namespace

void MoteMainWindow::ensure_keyboard_hook()
{
    if (g_keyboard_hook)
        return;
    g_hook_ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
    g_hook_shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
    g_hook_alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
    g_keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, &MoteMainWindow::keyboard_hook,
                                        GetModuleHandleW(nullptr), 0);
    log_line(std::string("NATIVE keyboard hook ") + (g_keyboard_hook ? "on" : "failed"));
}

void MoteMainWindow::remove_keyboard_hook()
{
    if (g_keyboard_hook) {
        UnhookWindowsHookEx(g_keyboard_hook);
        g_keyboard_hook = nullptr;
    }
}

MoteMainWindow *MoteMainWindow::active_window()
{
    HWND hwnd = GetActiveWindow();
    if (!hwnd)
        hwnd = GetForegroundWindow();
    if (hwnd) {
        HWND root = GetAncestor(hwnd, GA_ROOT);
        if (root) {
            wchar_t cls[64] = {};
            GetClassNameW(root, cls, 64);
            if (wcscmp(cls, kWindowClass) == 0) {
                auto *self =
                    reinterpret_cast<MoteMainWindow *>(GetWindowLongPtrW(root, GWLP_USERDATA));
                if (self && self->hwnd_)
                    return self;
            }
        }
    }
    return g_windows.empty() ? nullptr : g_windows.front();
}

// EditorHost → Win32 的转发层。owner 是应用级单窗口，生命周期覆盖整个进程。
class ShellHost final : public mote::EditorHost
{
public:
    explicit ShellHost(MoteMainWindow &owner)
        : owner_(owner)
    {
    }

    void evaluateJs(const std::string &script) override { owner_.evaluate_script(script); }
    void loadPage(const std::string &base_dir) override { owner_.load_page(base_dir); }
    void injectDocument(const std::string &text) override { owner_.inject_document(text); }
    bool clipboardImage(std::vector<std::uint8_t> *bytes, std::string *mime) override
    {
        return owner_.clipboard_image(bytes, mime);
    }
    void setClipboard(const std::string &text, const std::string &html) override
    {
        owner_.set_clipboard(text, html);
    }
    std::string clipboardText() override { return owner_.clipboard_text(); }
    void openExternal(const std::string &url) override { owner_.open_external(url); }
    void saveRequested(const std::string &text) override
    {
        owner_.save_requested_text(text);
    }
    void openRequested() override { owner_.open_requested(); }
    void dropReceived(const std::string &name, const std::string &text) override
    {
        owner_.drop_received(name, text);
    }
    void exportHtmlReady(const std::string &html) override
    {
        owner_.export_html_ready(html);
    }
    void exportPdfRequested(const std::string &path) override
    {
        owner_.export_pdf_requested(path);
    }
    void exportPdfFailed(const std::string &message) override
    {
        owner_.status_message(message);
    }
    void fileDropRequested(const std::string &path) override
    {
        owner_.file_drop_requested(path);
    }
    void statusMessage(const std::string &message) override
    {
        owner_.status_message(message);
    }
    void errorOccurred(const std::string &message) override
    {
        owner_.error_message(message);
    }
    void ready() override { owner_.page_ready(); }
    void dirtyChanged(bool dirty) override
    {
        (void)dirty;
        owner_.dirty_changed();
    }
    void viewStateChanged(const mote::ViewState &state) override
    {
        owner_.apply_view_state(state);
    }
    void statsChanged(int cjk, int words) override
    {
        if (!env_value("MOTE_KEYLOG").empty())
            log_line("NATIVE stats cjk=" + std::to_string(cjk)
                     + " words=" + std::to_string(words));
    }
    void logMessage(const std::string &message) override
    {
        // MOTE_EVAL 是显式诊断请求，结果不应再被 MOTE_KEYLOG 门槛吞掉
        if (!env_value("MOTE_KEYLOG").empty() || !env_value("MOTE_EVAL").empty()
            || mote::perfEnabled())
            log_line("JSLOG " + message);
    }

private:
    MoteMainWindow &owner_;
};

MoteMainWindow::MoteMainWindow(HINSTANCE instance)
    : instance_(instance)
{
}

MoteMainWindow::~MoteMainWindow() = default;

LRESULT CALLBACK MoteMainWindow::keyboard_hook(int code, WPARAM wparam, LPARAM lparam)
{
    if (code != HC_ACTION)
        return CallNextHookEx(nullptr, code, wparam, lparam);

    const UINT key = reinterpret_cast<KBDLLHOOKSTRUCT *>(lparam)->vkCode;
    const bool down = wparam == WM_KEYDOWN || wparam == WM_SYSKEYDOWN;
    const bool up = wparam == WM_KEYUP || wparam == WM_SYSKEYUP;

    // 钩子按队列顺序收到所有按键，在这里维护修饰键状态比查全局键状态更可靠
    switch (key) {
    case VK_CONTROL:
    case VK_LCONTROL:
    case VK_RCONTROL:
        g_hook_ctrl = down;
        break;
    case VK_SHIFT:
    case VK_LSHIFT:
    case VK_RSHIFT:
        g_hook_shift = down;
        break;
    case VK_MENU:
    case VK_LMENU:
    case VK_RMENU:
        g_hook_alt = down;
        break;
    default:
        break;
    }

    if (up) {
        g_last_shortcut_key = 0;
        return CallNextHookEx(nullptr, code, wparam, lparam);
    }
    if (!down)
        return CallNextHookEx(nullptr, code, wparam, lparam);

    // 只管本进程 Mote 窗口在前台时的按键，别影响其它程序
    const HWND foreground = GetForegroundWindow();
    const HWND root = foreground ? GetAncestor(foreground, GA_ROOT) : nullptr;
    if (!root)
        return CallNextHookEx(nullptr, code, wparam, lparam);
    wchar_t cls[64] = {};
    GetClassNameW(root, cls, 64);
    if (wcscmp(cls, kWindowClass) != 0)
        return CallNextHookEx(nullptr, code, wparam, lparam);
    auto *self =
        reinterpret_cast<MoteMainWindow *>(GetWindowLongPtrW(root, GWLP_USERDATA));
    if (!self || !self->hwnd_)
        return CallNextHookEx(nullptr, code, wparam, lparam);

    if (key == g_last_shortcut_key)
        return 1;  // 长按的自动重复只触发一次

    WORD modifiers = 0;
    if (g_hook_ctrl || (GetAsyncKeyState(VK_CONTROL) & 0x8000))
        modifiers |= FCONTROL;
    if (g_hook_shift || (GetAsyncKeyState(VK_SHIFT) & 0x8000))
        modifiers |= FSHIFT;
    if (g_hook_alt || (GetAsyncKeyState(VK_MENU) & 0x8000))
        modifiers |= FALT;

    mote::CommandId command = mote::CommandId::New;
    if (!mote::win::command_for_shortcut(modifiers, key, &command))
        return CallNextHookEx(nullptr, code, wparam, lparam);

    g_last_shortcut_key = key;
    if (!env_value("MOTE_KEYLOG").empty())
        log_line("NATIVE key vk=" + std::to_string(key)
                 + " mods=" + std::to_string(modifiers));
    PostMessageW(root, kShortcutMessage, static_cast<WPARAM>(command), 0);
    return 1;  // 已由外壳处理，Chromium 不再执行默认行为
}

bool MoteMainWindow::create()
{
    WNDCLASSEXW window_class = {};
    window_class.cbSize = sizeof(window_class);
    window_class.style = CS_HREDRAW | CS_VREDRAW;
    window_class.lpfnWndProc = &MoteMainWindow::window_proc;
    window_class.hInstance = instance_;
    window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    window_class.lpszClassName = kWindowClass;
    if (!RegisterClassExW(&window_class) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
        return false;

    const UINT dpi = GetDpiForSystem();
    RECT frame = { 0, 0, MulDiv(kDefaultWidth, dpi, 96), MulDiv(kDefaultHeight, dpi, 96) };
    AdjustWindowRectExForDpi(&frame, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);

    hwnd_ = CreateWindowExW(0, kWindowClass, L"Mote", WS_OVERLAPPEDWINDOW,
                            CW_USEDEFAULT, CW_USEDEFAULT, frame.right - frame.left,
                            frame.bottom - frame.top, nullptr, nullptr, instance_, this);
    if (!hwnd_)
        return false;

    // Chromium 在编辑区会先消费 Ctrl+Shift+S / Ctrl+Alt+E，连 AcceleratorKeyPressed
    // 都收不到；用进程内低级键盘钩子提前截获（首窗装一次，末窗卸）。
    ensure_keyboard_hook();
    return true;
}

void MoteMainWindow::show(int show_command)
{
    if (!hwnd_)
        return;
    ShowWindow(hwnd_, show_command);
    UpdateWindow(hwnd_);
}

MoteMainWindow *MoteMainWindow::create_new(HINSTANCE instance, const std::string &pending_path,
                                          int show_command)
{
    if (instance)
        g_instance = instance;
    auto *window = new MoteMainWindow(g_instance);
    if (!pending_path.empty())
        window->set_pending_path(pending_path);
    if (!window->create()) {
        delete window;
        return nullptr;
    }
    g_windows.push_back(window);
    window->show(show_command);
    return window;
}

void MoteMainWindow::open_requested_path(const std::string &path)
{
    if (path.empty())
        return;
    for (MoteMainWindow *window : g_windows) {
        if (same_path(window->file_path_, path)) {
            if (IsIconic(window->hwnd_))
                ShowWindow(window->hwnd_, SW_RESTORE);
            SetForegroundWindow(window->hwnd_);
            return;
        }
    }
    create_new(g_instance, path, SW_SHOWNORMAL);
}

LRESULT CALLBACK MoteMainWindow::window_proc(HWND hwnd, UINT message, WPARAM wparam,
                                             LPARAM lparam)
{
    MoteMainWindow *self = nullptr;
    if (message == WM_NCCREATE) {
        auto *create = reinterpret_cast<CREATESTRUCTW *>(lparam);
        self = static_cast<MoteMainWindow *>(create->lpCreateParams);
        self->hwnd_ = hwnd;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    } else {
        self = reinterpret_cast<MoteMainWindow *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    }
    return self ? self->handle_message(hwnd, message, wparam, lparam)
                : DefWindowProcW(hwnd, message, wparam, lparam);
}

LRESULT MoteMainWindow::handle_message(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    switch (message) {
    case WM_CREATE:
        host_ = std::make_unique<WebHostView>(
            hwnd, [this] { navigation_completed(); },
            [this](std::string_view json) {
                if (controller_)
                    controller_->handleMessage(json);
            },
            [this](UINT key, WORD modifiers) {
                return handle_accelerator(key, modifiers);
            });
        shell_ = std::make_unique<ShellHost>(*this);
        controller_ = std::make_unique<mote::EditorController>(*shell_);
        // 换目录免重载：home 内文档的页面固定写在 %TEMP%\MoteNative（见
        // web_host_view.cpp），根内换目录只改 <base> 注入正文；越界目录
        // （其他盘符）退回「页面写进该目录 + 重载」兜底。
        {
            const std::string profile = env_value("USERPROFILE");
            if (!profile.empty())
                controller_->setReadAccessRoot(profile);
        }
        // 命令行带文件：直接打开它，跳过示例页（省一次全量页面加载）
        if (!pending_path_.empty()) {
            const std::string pending = pending_path_;
            pending_path_.clear();
            open_path(pending);
        } else {
            load_builtin_sample();
        }
        layout();

        SetMenu(hwnd, mote::win::build_main_menu(&recent_menu_));
        follow_system_ = true;
        apply_theme();
        // 更新模块不直接依赖 EditorController：脏标记与退出都由这里注入。
        // 多窗口下按「当前活跃窗口」动态取，避免指向已销毁实例。
        mote::win::set_update_hooks(
            [] {
                MoteMainWindow *window = active_window();
                return window && window->controller_ && window->controller_->dirty();
            },
            [] {
                MoteMainWindow *window = active_window();
                if (window)
                    PostMessageW(window->hwnd_, WM_CLOSE, 0, 0);
            });
        mote::win::start_update_checker(hwnd);
        return 0;
    case kForwardMessage: {
        // 单实例转发：另一个进程双击了 .md，按统一口径新窗口打开（已开则激活）
        const std::wstring handoff = forward_handoff_path();
        std::ifstream in(std::filesystem::path(handoff), std::ios::binary);
        std::string path;
        if (in)
            std::getline(in, path, '\0');
        DeleteFileW(handoff.c_str());
        if (!path.empty())
            open_requested_path(path);
        return 0;
    }
    case WM_INITMENUPOPUP:
        if (recent_menu_ && (HMENU)wparam == recent_menu_)
            rebuild_recent_menu();
        return 0;
    case WM_COMMAND: {
        const UINT id = LOWORD(wparam);
        if (id == mote::win::kExitCommandId) {
            SendMessageW(hwnd, WM_CLOSE, 0, 0);
            return 0;
        }
        if (id == mote::win::kCheckUpdateCommandId) {
            mote::win::check_for_updates_now(hwnd);
            return 0;
        }
        if (id == mote::win::kRecentClearCommandId) {
            recent_files().clear();
            return 0;
        }
        if (id >= mote::win::kRecentCommandBase
            && id < mote::win::kRecentCommandBase + mote::win::kRecentMaxItems) {
            const auto paths = recent_files().list();
            const size_t index = id - mote::win::kRecentCommandBase;
            if (index < paths.size())
                open_requested_path(paths[index]);
            return 0;
        }
        // 菜单项 id 就是 CommandId；未知 id（控件通知等）直接忽略
        if (const mote::CommandSpec *spec =
                mote::findCommand(static_cast<mote::CommandId>(id)))
            perform_command(spec->id);
        return 0;
    }
    case kShortcutMessage:
        perform_command(static_cast<mote::CommandId>(wparam));
        return 0;
    case mote::win::kUpdateResultMessage:
        mote::win::handle_update_message(hwnd, lparam);
        return 0;
    case WM_TIMER:
        if (wparam == kStartupCommandTimer) {
            KillTimer(hwnd, kStartupCommandTimer);
            run_startup_command();
            return 0;
        }
        if (wparam == kOpen2Timer) {
            KillTimer(hwnd, kOpen2Timer);
            const std::string p = env_value("MOTE_OPEN2");
            if (!p.empty()) {
                mote::perfReset();
                mote::perfMark("win:hot_open_start");
                open_path(p);
            }
            return 0;
        }
        if (wparam == mote::win::kUpdateTimer) {
            mote::win::run_update_timer(hwnd);
            return 0;
        }
        if (wparam == kEvalTimer) {
            KillTimer(hwnd, kEvalTimer);
            const std::string expression = env_value("MOTE_EVAL");
            if (!expression.empty() && host_) {
                const std::string probe =
                    "(function(){try{var r=(" + expression
                    + ");window.chrome.webview.postMessage({type:'log',message:'EVAL '+String(r)});}"
                      "catch(e){window.chrome.webview.postMessage({type:'log',message:'EVALERR '+e});}})();";
                host_->evaluate_script(probe);
                log_line("NATIVE eval dispatched");
            }
            return 0;
        }
        if (wparam == kSnapshotTimer) {
            KillTimer(hwnd, kSnapshotTimer);
            const std::string snapshot = env_value("MOTE_SNAPSHOT");
            if (!snapshot.empty() && host_) {
                const std::string path = snapshot;
                host_->capture_preview(path, [this, path](bool ok) {
                    log_line(std::string("SNAPSHOT ") + (ok ? "OK " : "ERR ") + path);
                });
            }
            return 0;
        }
        if (wparam == kDropProbeTimer) {
            KillTimer(hwnd, kDropProbeTimer);
            log_line("NATIVE drop probe paths="
                     + std::to_string(drop_probe_paths_.size()));
            if (controller_ && !drop_probe_paths_.empty())
                controller_->handleNativeFileDrop(drop_probe_paths_);
            return 0;
        }
        break;
    case WM_SETTINGCHANGE:
        if (wparam == WM_SETTINGCHANGE && lparam && follow_system_
            && std::wcscmp(reinterpret_cast<const wchar_t *>(lparam),
                           L"ImmersiveColorSet") == 0) {
            apply_theme();
            return 0;
        }
        break;
    case mote::win::kDropMessage: {
        std::unique_ptr<std::vector<std::string>> paths(
            reinterpret_cast<std::vector<std::string> *>(lparam));
        log_line("NATIVE drop paths=" + std::to_string(paths ? paths->size() : 0));
        if (paths && controller_)
            controller_->handleNativeFileDrop(*paths);
        return 0;
    }
    case WM_SIZE:
        layout();
        return 0;
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN: {
        // 焦点在窗口框架/菜单（还没进 WebView）时的兜底，和键盘钩子同一张命令表
        WORD modifiers = 0;
        if (GetKeyState(VK_CONTROL) < 0)
            modifiers |= FCONTROL;
        if (GetKeyState(VK_SHIFT) < 0)
            modifiers |= FSHIFT;
        if (GetKeyState(VK_MENU) < 0)
            modifiers |= FALT;
        mote::CommandId command = mote::CommandId::New;
        if (mote::win::command_for_shortcut(modifiers, static_cast<UINT>(wparam),
                                            &command)) {
            perform_command(command);
            return 0;
        }
        break;
    }
    case WM_CLOSE:
        if (confirm_close())
            DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        revoke_drop_target();
        KillTimer(hwnd, mote::win::kUpdateTimer);
        host_.reset();
        controller_.reset();
        shell_.reset();
        recent_menu_ = nullptr;
        hwnd_ = nullptr;
        // 多窗口：末窗销毁才退出进程；窗口对象在这里回收
        g_windows.erase(std::remove(g_windows.begin(), g_windows.end(), this),
                        g_windows.end());
        if (g_windows.empty()) {
            remove_keyboard_hook();
            PostQuitMessage(0);
        }
        delete this;
        return 0;
    case WM_GETMINMAXINFO: {
        const UINT dpi = GetDpiForWindow(hwnd);
        auto *info = reinterpret_cast<MINMAXINFO *>(lparam);
        info->ptMinTrackSize.x = MulDiv(kMinWidth, dpi, 96);
        info->ptMinTrackSize.y = MulDiv(kMinHeight, dpi, 96);
        return 0;
    }
    case WM_DPICHANGED: {
        const RECT *suggested = reinterpret_cast<const RECT *>(lparam);
        SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                     suggested->right - suggested->left, suggested->bottom - suggested->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }
    default:
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    // WM_TIMER / WM_SETTINGCHANGE 未命中的分支落到这里，与 default 一样交默认窗口过程
    return DefWindowProcW(hwnd, message, wparam, lparam);
}

void MoteMainWindow::layout()
{
    if (!hwnd_ || !host_)
        return;
    RECT client = {};
    GetClientRect(hwnd_, &client);
    host_->resize(client.right - client.left, client.bottom - client.top);
}

void MoteMainWindow::load_builtin_sample()
{
    const std::string sample_path = exe_directory() + "\\samples\\welcome.md";
    std::string text;
    if (!read_text_file(sample_path, &text) || text.empty())
        text = "# 欢迎\n\n没有找到内置示例文档。\n";
    file_path_.clear();
    last_dir_.clear();
    last_text_ = text;
    controller_->setMarkdown(text, "");
    update_title();
}

std::wstring MoteMainWindow::display_name() const
{
    if (file_path_.empty())
        return L"未命名";
    return utf8_to_wide(file_name(file_path_));
}

void MoteMainWindow::update_title()
{
    const bool dirty = controller_ && controller_->dirty();
    std::wstring title = display_name() + (dirty ? L"*" : L"") + L" - Mote";
    if (hwnd_)
        SetWindowTextW(hwnd_, title.c_str());
}

void MoteMainWindow::open_requested()
{
    open_document();
}

void MoteMainWindow::open_document()
{
    if (!prepare_for_replace(AfterSave::OpenDialog, ""))
        return;
    const std::string dir = last_dir_.empty() ? documents_dir() : last_dir_;
    const std::string path = MoteOpenMarkdownDialog(hwnd_, dir);
    if (!path.empty())
        open_path(path);
}

bool MoteMainWindow::forward_path_to_existing(const std::string &path_utf8)
{
    HWND hwnd = FindWindowW(kWindowClass, nullptr);
    if (!hwnd)
        return false;
    const std::wstring handoff = forward_handoff_path();
    std::error_code ec;
    std::filesystem::create_directories(
        std::filesystem::path(handoff).parent_path(), ec);
    std::ofstream out(std::filesystem::path(handoff),
                      std::ios::binary | std::ios::trunc);
    if (!out)
        return false;
    out << path_utf8;
    out.close();
    if (!PostMessageW(hwnd, kForwardMessage, 0, 0)) {
        DeleteFileW(handoff.c_str());
        return false;
    }
    return true;
}

void MoteMainWindow::rebuild_recent_menu()
{
    if (!recent_menu_)
        return;
    while (GetMenuItemCount(recent_menu_) > 0)
        DeleteMenu(recent_menu_, 0, MF_BYPOSITION);
    const auto paths = recent_files().list();
    const size_t count = paths.size() < static_cast<size_t>(mote::win::kRecentMaxItems)
        ? paths.size()
        : static_cast<size_t>(mote::win::kRecentMaxItems);
    for (size_t i = 0; i < count; ++i) {
        std::wstring title = utf8_to_wide(file_name(paths[i]));
        title += L"\t";
        title += utf8_to_wide(parent_dir(paths[i]));
        std::error_code ec;
        const bool exists = std::filesystem::exists(
            std::filesystem::path(utf8_to_wide(paths[i])), ec);
        AppendMenuW(recent_menu_,
                    MF_STRING | (exists ? 0 : MF_GRAYED),
                    static_cast<UINT_PTR>(mote::win::kRecentCommandBase + i),
                    title.c_str());
    }
    if (count > 0)
        AppendMenuW(recent_menu_, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(recent_menu_, MF_STRING, mote::win::kRecentClearCommandId, L"清除记录");
}

void MoteMainWindow::set_pending_path(const std::string &path)
{
    pending_path_ = path;
}

void MoteMainWindow::open_path(const std::string &path)
{
    // 命令行参数、拖放路径等可能是相对路径；统一转绝对，确保 file_path_ / last_dir_ /
    // 页面加载（临时 HTML + base href）都基于真实磁盘位置。
    std::string resolved = path;
    try {
        std::filesystem::path p(utf8_to_wide(path));
        std::filesystem::path abs = std::filesystem::absolute(p);
        resolved = wide_to_utf8(abs.wstring());
    } catch (...) {
        // 路径非法：保留原值，让后续 read_text_file 按失败处理并弹提示
    }

    std::string text;
    if (!read_text_file(resolved, &text)) {
        MoteAlert(hwnd_, L"无法打开", "读取文件失败：\n" + path);
        return;
    }
    mote::perfMark("win:file_read_done");

    file_path_ = resolved;
    last_dir_ = parent_dir(resolved);
    last_text_ = text;
    // 记录原文件行尾风格，保存时原样写回（编辑器内部按 LF 工作）
    crlf_ = text.find("\r\n") != std::string::npos;
    controller_->setMarkdown(text, last_dir_);
    update_title();
    recent_files().add(resolved);
    log_line("NATIVE open " + path);
    status_message("已打开：" + path);
}

void MoteMainWindow::new_document()
{
    if (!prepare_for_replace(AfterSave::NewDocument, ""))
        return;
    start_new_document();
}

void MoteMainWindow::start_new_document()
{
    file_path_.clear();
    last_text_.clear();
    crlf_ = false; // 新文档用 LF，和编辑器内部表示一致
    save_as_requested_ = false;
    controller_->newDocument();
    update_title();
    status_message("已新建空白文档（未命名，保存时会询问位置）");
}

void MoteMainWindow::save_requested_text(const std::string &text)
{
    save_text(text);
}

void MoteMainWindow::begin_save_as(bool save_as)
{
    save_as_requested_ = save_as;
    if (controller_)
        controller_->requestSnapshot();
}

void MoteMainWindow::save_text(const std::string &text)
{
    const bool wants_save_as = save_as_requested_;
    save_as_requested_ = false;

    std::string path = file_path_;
    if (path.empty() || wants_save_as) {
        const std::string dir = last_dir_.empty() ? documents_dir() : last_dir_;
        std::string suggested = path;
        if (suggested.empty())
            suggested = dir + "\\未命名.md";
        if (const std::string forced = env_value("MOTE_SAVE_AS"); !forced.empty())
            path = forced;
        else
            path = MoteSaveDialog(hwnd_, L"另存为", suggested, L"md");
        if (path.empty()) {
            reset_after_save();
            return;
        }
        path = with_extension(path, "md");
    }

    if (!write_text(text, path)) {
        reset_after_save();
        return;
    }

    file_path_ = path;
    last_dir_ = parent_dir(path);
    last_text_ = text;
    controller_->notifySaved(text);
    // 另存为可能换了目录：图片落盘位置跟随新的 .md 路径
    controller_->setBaseDir(last_dir_);
    update_title();
    recent_files().add(path);
    log_line("NATIVE save " + path);
    status_message("已保存：" + path);
    run_after_save();
}

bool MoteMainWindow::write_text(const std::string &text, const std::string &path)
{
    // 编辑器内部统一 LF；原文件是 CRLF 时还原，避免「打开再保存」把整篇行尾改掉
    std::string payload = text;
    if (crlf_) {
        payload.clear();
        payload.reserve(text.size() + text.size() / 16);
        for (const char c : text) {
            if (c == '\n')
                payload += "\r\n";
            else
                payload.push_back(c);
        }
    }
    if (write_text_file(path, payload))
        return true;
    MoteAlert(hwnd_, L"保存失败", "无法写入文件：\n" + path);
    return false;
}

void MoteMainWindow::prompt_export_pdf()
{
    if (!controller_ || file_path_.empty())
        return;
    std::string base = file_name(file_path_);
    const size_t dot = base.find_last_of('.');
    if (dot != std::string::npos)
        base = base.substr(0, dot);
    const std::string suggested = parent_dir(file_path_) + "\\" + base + ".pdf";

    if (!env_value("MOTE_PDF_PROMPT").empty()) {
        log_line("NATIVE pdf suggested=" + suggested);
        return;
    }
    std::string path;
    if (const std::string forced = env_value("MOTE_PDF_AS"); !forced.empty())
        path = forced;
    else
        path = MoteSaveDialog(hwnd_, L"导出 PDF", suggested, L"pdf");
    if (path.empty())
        return;
    path = with_extension(path, "pdf");

    status_message("正在导出 PDF…");
    controller_->requestExportPdf(path);
}

void MoteMainWindow::export_html_ready(const std::string &html)
{
    if (html.empty()) {
        status_message("导出失败：页面没有返回内容");
        return;
    }

    std::string suggested;
    if (file_path_.empty()) {
        const std::string dir = last_dir_.empty() ? documents_dir() : last_dir_;
        suggested = dir + "\\未命名.html";
    } else {
        std::string base = file_name(file_path_);
        const size_t dot = base.find_last_of('.');
        if (dot != std::string::npos)
            base = base.substr(0, dot);
        suggested = parent_dir(file_path_) + "\\" + base + ".html";
    }

    if (!env_value("MOTE_EXPORT_PROMPT").empty()) {
        log_line("NATIVE export suggested=" + suggested);
        return;
    }
    std::string path;
    if (const std::string forced = env_value("MOTE_EXPORT_AS"); !forced.empty())
        path = forced;
    else
        path = MoteSaveDialog(hwnd_, L"导出 HTML", suggested, L"html");
    if (path.empty())
        return;
    path = with_extension(path, "html");

    // 图片相对路径按 .md 所在目录解析；未命名文档退回上次目录
    const std::string base_dir = file_path_.empty()
        ? (last_dir_.empty() ? documents_dir() : last_dir_)
        : parent_dir(file_path_);
    int missing = 0;
    const std::string filled = MoteInlineLocalImages(html, base_dir, &missing);
    if (!write_text_file(path, filled)) {
        MoteAlert(hwnd_, L"导出失败", "无法写入文件：\n" + path);
        return;
    }
    log_line("NATIVE export path=" + path + " missing=" + std::to_string(missing));
    if (missing > 0)
        status_message("已导出到 " + path + "（" + std::to_string(missing) + " 张图片缺失）");
    else
        status_message("已导出到 " + path);
}

void MoteMainWindow::export_pdf_requested(const std::string &path)
{
    if (!host_ || path.empty())
        return;

    // 同名旧文件不能算本次成功：先删，成功与否由产物是否生成判定
    std::error_code error;
    std::filesystem::remove(std::filesystem::path(utf8_to_wide(path)), error);

    PdfHost pdf;
    pdf.evaluate = [this](const std::string &script,
                          std::function<void(bool, const std::string &)> callback) {
        host_->evaluate_script_result(script, std::move(callback));
    };
    pdf.print = [this](const std::string &target, double scale,
                       std::function<void(bool)> callback) {
        host_->print_to_pdf(target, scale, std::move(callback));
    };

    MoteExportPdf(pdf, path, [this, path](bool ok, const std::string &message) {
        if (!ok) {
            log_line("NATIVE pdf failed " + message);
            status_message(message);
            MoteAlert(hwnd_, L"导出失败", message);
            return;
        }
        std::error_code error;
        const auto size = std::filesystem::file_size(std::filesystem::path(utf8_to_wide(path)),
                                                     error);
        log_line("NATIVE pdf path=" + path + " size="
                 + std::to_string(error ? 0 : size));
        status_message("已导出到 " + path);
    });
}

bool MoteMainWindow::prepare_for_replace(AfterSave after, const std::string &path,
                                        const std::string &text)
{
    if (!controller_ || !controller_->dirty())
        return true;

    switch (MoteConfirmUnsaved(hwnd_, display_name())) {
    case MoteSaveChoice::Cancel:
        return false;
    case MoteSaveChoice::Discard:
        return true;
    case MoteSaveChoice::Save:
        after_save_ = after;
        after_save_path_ = path;
        after_save_text_ = text;
        controller_->requestSnapshot();
        return false;
    }
    return false;
}

void MoteMainWindow::run_after_save()
{
    const AfterSave after = after_save_;
    const std::string path = after_save_path_;
    const std::string text = after_save_text_;
    reset_after_save();

    switch (after) {
    case AfterSave::OpenDialog:
        open_document();
        break;
    case AfterSave::OpenPath:
        if (!path.empty())
            open_path(path);
        break;
    case AfterSave::NewDocument:
        start_new_document();
        break;
    case AfterSave::Close:
        DestroyWindow(hwnd_);
        break;
    case AfterSave::ExportPdf:
        prompt_export_pdf();
        break;
    case AfterSave::DropDocument:
        load_dropped_text(text);
        break;
    case AfterSave::None:
        break;
    }
}

void MoteMainWindow::reset_after_save()
{
    after_save_ = AfterSave::None;
    after_save_path_.clear();
    after_save_text_.clear();
}

bool MoteMainWindow::confirm_close()
{
    if (!controller_ || !controller_->dirty())
        return true;

    switch (MoteConfirmUnsaved(hwnd_, display_name())) {
    case MoteSaveChoice::Cancel:
        return false;
    case MoteSaveChoice::Discard:
        return true;
    case MoteSaveChoice::Save:
        after_save_ = AfterSave::Close;
        controller_->requestSnapshot();
        return false;
    }
    return false;
}

void MoteMainWindow::evaluate_script(const std::string &script)
{
    if (host_)
        host_->evaluate_script(script);
}

void MoteMainWindow::load_page(const std::string &base_dir)
{
    mote::perfMark("win:loadpage_call");
    if (host_)
        host_->load_page(base_dir);
}

void MoteMainWindow::navigation_completed()
{
    if (!controller_)
        return;
    host_->evaluate_script(mote::js::enableStatusBar("win"));
    host_->focus();
    ensure_drop_target();
    update_title();
    log_line("NATIVE navigation completed");
}

void MoteMainWindow::page_ready()
{
    mote::perfMark("win:page_ready_cb");
    log_line("NATIVE ready gen=" + std::to_string(controller_->pageGeneration()));
    if (!pending_status_.empty())
        show_status(pending_status_);
    update_title();
    update_menu_state();
    // MOTE_COMMAND 诊断钩子：页面就绪后再等 700ms，避开首帧布局
    if (!startup_command_done_ && !env_value("MOTE_COMMAND").empty())
        SetTimer(hwnd_, kStartupCommandTimer, 700, nullptr);

    // 与 mac 同名钩子：首屏就绪 600ms 后再打开第二个文件（测热打开）
    if (!open2_done_ && !env_value("MOTE_OPEN2").empty()) {
        open2_done_ = true;
        SetTimer(hwnd_, kOpen2Timer, 600, nullptr);
    }

    // 与 mac 同名的诊断钩子：MOTE_EVAL 打一条 JSLOG，MOTE_SNAPSHOT 出 PNG
    if (!diagnostics_started_) {
        diagnostics_started_ = true;
        // 等导航完成后再取页面状态：ready 消息到达时 WebView2 仍在导航，
        // 此刻调用 ExecuteScript 会被静默丢弃（只剩 scheduled、没有结果）
        if (!env_value("MOTE_EVAL").empty()) {
            SetTimer(hwnd_, kEvalTimer, 700, nullptr);
            log_line("NATIVE eval scheduled");
        }
        const std::string snapshot = env_value("MOTE_SNAPSHOT");
        if (!snapshot.empty()) {
            const std::string raw = env_value("MOTE_SNAPSHOT_DELAY");
            const double delay = !raw.empty() ? std::atof(raw.c_str()) : 2000.0;
            SetTimer(hwnd_, kSnapshotTimer, static_cast<UINT>(delay < 0 ? 0 : delay), nullptr);
        }
        // 与 mac 同名同义：页面就绪 900ms 后把指定路径当成一次真实拖放。
        // mac 用 ':' 分隔；Windows 盘符本身带 ':'，这里改成分号。
        if (!drop_probe_done_) {
            const std::string paths = env_value("MOTE_DROP");
            if (!paths.empty()) {
                drop_probe_done_ = true;
                const std::string list = paths;
                size_t start = 0;
                while (start <= list.size()) {
                    const size_t end = list.find(';', start);
                    const std::string item = list.substr(
                        start, end == std::string::npos ? std::string::npos : end - start);
                    if (!item.empty())
                        drop_probe_paths_.push_back(item);
                    if (end == std::string::npos)
                        break;
                    start = end + 1;
                }
                if (!drop_probe_paths_.empty()) {
                    log_line("NATIVE drop probe scheduled paths="
                             + std::to_string(drop_probe_paths_.size()));
                    SetTimer(hwnd_, kDropProbeTimer, 900, nullptr);
                }
            }
        }
    }
}

void MoteMainWindow::dirty_changed()
{
    update_title();
}

void MoteMainWindow::status_message(const std::string &text)
{
    show_status(text);
}

void MoteMainWindow::error_message(const std::string &text)
{
    show_status("前端错误：" + text);
}

void MoteMainWindow::show_status(const std::string &text)
{
    if (text.empty())
        return;
    // 先拷一份：调用方可能直接传 pending_status_ 本身，下面 clear() 会让引用变空
    const std::string message = text;
    // 已送达就清掉缓存：否则每次页面重载后的 ready 都会重放上一条旧状态
    if (controller_ && controller_->pageReady()) {
        pending_status_.clear();
        host_->evaluate_script(mote::js::statusMessage(message));
        return;
    }
    pending_status_ = message;
}

void MoteMainWindow::perform_command(mote::CommandId command)
{
    const mote::CommandSpec *spec = mote::findCommand(command);
    if (!env_value("MOTE_KEYLOG").empty() && spec)
        log_line("NATIVE command " + spec->title);

    switch (command) {
    case mote::CommandId::New:
        new_document();
        return;
    case mote::CommandId::NewWindow:
        create_new(g_instance, std::string(), SW_SHOWNORMAL);
        return;
    case mote::CommandId::Open:
        open_document();
        return;
    case mote::CommandId::Save:
        begin_save_as(false);
        return;
    case mote::CommandId::SaveAs:
        begin_save_as(true);
        return;
    case mote::CommandId::ExportHtml:
        controller_->requestExportHtml(wide_to_utf8(display_name()));
        return;
    case mote::CommandId::ExportPdf:
        if (source_on_) {
            status_message("源码模式下不能导出 PDF，先退出源码模式");
            return;
        }
        // 未命名文档没有目录：先另存为，保存完成后再回到导出
        if (file_path_.empty()) {
            after_save_ = AfterSave::ExportPdf;
            begin_save_as(true);
            return;
        }
        if (!prepare_for_replace(AfterSave::ExportPdf, ""))
            return;
        prompt_export_pdf();
        return;
    case mote::CommandId::Undo:
        controller_->undo();
        return;
    case mote::CommandId::Redo:
        controller_->redo();
        return;
    // 剪切/复制/粘贴：菜单点击走页面桥；快捷键本身交给 WebView2 原生处理
    case mote::CommandId::Cut:
        controller_->clipboardCommand("cut");
        return;
    case mote::CommandId::Copy:
        controller_->clipboardCommand("copy");
        return;
    case mote::CommandId::Paste:
        controller_->clipboardCommand("paste");
        return;
    case mote::CommandId::SelectAll:
        evaluate_script("document.execCommand('selectAll');");
        return;
    case mote::CommandId::ToggleToc:
        controller_->toggleToc();
        return;
    case mote::CommandId::ToggleSource:
        controller_->toggleSource();
        return;
    case mote::CommandId::ToggleDark:
        follow_system_ = false;
        dark_mode_ = !dark_mode_;
        apply_theme();
        return;
    case mote::CommandId::FollowSystem:
        follow_system_ = true;
        apply_theme();
        return;
    case mote::CommandId::ZoomIn:
        controller_->zoomBy(1);
        return;
    case mote::CommandId::ZoomOut:
        controller_->zoomBy(-1);
        return;
    case mote::CommandId::ZoomReset:
        controller_->resetZoom();
        return;
    default:
        break;
    }

    // 剩余的是格式命令：动作名由 core 命令表给出，前端统一解释
    if (spec && !spec->formatAction.empty())
        controller_->applyFormat(spec->formatAction);
}

void MoteMainWindow::apply_view_state(const mote::ViewState &state)
{
    toc_on_ = state.toc;
    source_on_ = state.source;
    update_menu_state();
    if (!env_value("MOTE_KEYLOG").empty())
        log_line("NATIVE view toc=" + std::to_string(state.toc ? 1 : 0)
                 + " source=" + std::to_string(state.source ? 1 : 0)
                 + " zoom=" + std::to_string(state.zoom));
    if (std::abs(state.zoom - last_zoom_) > 0.001) {
        last_zoom_ = state.zoom;
        status_message("缩放：" + std::to_string(
            static_cast<int>(std::lround(state.zoom * 100))) + "%");
    }
}

bool MoteMainWindow::system_is_dark() const
{
    // Windows 没有公开的系统外观 API：读「应用模式」注册表值，
    // 0 = 深色，1 = 浅色；读取失败时按浅色处理。
    HKEY key = nullptr;
    DWORD value = 1;
    DWORD size = sizeof(value);
    if (RegOpenKeyExW(HKEY_CURRENT_USER,
                      L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                      0, KEY_READ, &key) == ERROR_SUCCESS) {
        RegQueryValueExW(key, L"AppsUseLightTheme", nullptr, nullptr,
                         reinterpret_cast<LPBYTE>(&value), &size);
        RegCloseKey(key);
    }
    return value == 0;
}

void MoteMainWindow::apply_theme()
{
    if (follow_system_)
        dark_mode_ = system_is_dark();
    if (controller_)
        controller_->setTheme(dark_mode_ ? "dark" : "light");
    update_menu_state();
}

void MoteMainWindow::update_menu_state()
{
    if (!hwnd_)
        return;
    HMENU menu = GetMenu(hwnd_);
    if (!menu)
        return;
    mote::win::set_command_checked(menu, mote::CommandId::ToggleToc, toc_on_);
    mote::win::set_command_checked(menu, mote::CommandId::ToggleSource, source_on_);
    mote::win::set_command_checked(menu, mote::CommandId::ToggleDark, dark_mode_);
    mote::win::set_command_checked(menu, mote::CommandId::FollowSystem, follow_system_);
    // 源码模式（textarea）由 WebView2 原生处理编辑命令
    mote::win::set_command_enabled(menu, mote::CommandId::ExportPdf, !source_on_);
    mote::win::set_command_enabled(menu, mote::CommandId::Cut, !source_on_);
    mote::win::set_command_enabled(menu, mote::CommandId::Copy, !source_on_);
    mote::win::set_command_enabled(menu, mote::CommandId::Paste, !source_on_);
    DrawMenuBar(hwnd_);
}

void MoteMainWindow::run_startup_command()
{
    if (startup_command_done_)
        return;
    const std::string raw = env_value("MOTE_COMMAND");
    if (raw.empty())
        return;
    startup_command_done_ = true;

    std::string name;
    for (const char *item = raw.c_str(); *item; ++item) {
        const unsigned char ch = static_cast<unsigned char>(*item);
        if (!std::isspace(ch))
            name += static_cast<char>(std::tolower(ch));
    }

    const std::pair<const char *, mote::CommandId> table[] = {
        { "new", mote::CommandId::New },
        { "newwindow", mote::CommandId::NewWindow },
        { "open", mote::CommandId::Open },
        { "save", mote::CommandId::Save },
        { "saveas", mote::CommandId::SaveAs },
        { "exporthtml", mote::CommandId::ExportHtml },
        { "exportpdf", mote::CommandId::ExportPdf },
        { "toggletoc", mote::CommandId::ToggleToc },
        { "togglesource", mote::CommandId::ToggleSource },
        { "toggledark", mote::CommandId::ToggleDark },
        { "followsystem", mote::CommandId::FollowSystem },
        { "zoomin", mote::CommandId::ZoomIn },
        { "zoomout", mote::CommandId::ZoomOut },
        { "zoomreset", mote::CommandId::ZoomReset },
    };
    for (const auto &entry : table) {
        if (name == entry.first) {
            log_line("NATIVE startup command " + name);
            perform_command(entry.second);
            return;
        }
    }
}

void MoteMainWindow::inject_document(const std::string &text)
{
    if (host_)
        host_->inject_markdown(text);
}

void MoteMainWindow::file_drop_requested(const std::string &path)
{
    if (path.empty())
        return;
    // 拖放等同双击：新窗口打开，不替换当前文档
    open_requested_path(path);
}

bool MoteMainWindow::clipboard_image(std::vector<std::uint8_t> *bytes, std::string *mime)
{
    if (!OpenClipboard(hwnd_))
        return false;

    bool found = false;
    // 浏览器/截图工具常直接给 PNG；没有时再解 CF_DIB
    const UINT png_format = RegisterClipboardFormatW(L"PNG");
    if (png_format != 0) {
        if (HANDLE data = GetClipboardData(png_format)) {
            if (auto *locked = static_cast<const std::uint8_t *>(GlobalLock(data))) {
                const size_t size = GlobalSize(data);
                if (size > 0) {
                    bytes->assign(locked, locked + size);
                    *mime = "image/png";
                    found = true;
                }
                GlobalUnlock(data);
            }
        }
    }

    if (!found) {
        if (HANDLE data = GetClipboardData(CF_DIB)) {
            if (auto *locked = static_cast<const std::uint8_t *>(GlobalLock(data))) {
                const size_t size = GlobalSize(data);
                std::vector<std::uint8_t> dib(locked, locked + size);
                GlobalUnlock(data);
                std::vector<std::uint8_t> png;
                if (encode_dib_to_png(dib, &png)) {
                    *bytes = std::move(png);
                    *mime = "image/png";
                    found = true;
                }
            }
        }
    }

    CloseClipboard();
    return found;
}

bool MoteMainWindow::paste_clipboard_image()
{
    if (!controller_ || source_on_)
        return false;
    if (!clipboard_has_image())
        return false;
    controller_->clipboardCommand("paste");
    return true;
}

bool MoteMainWindow::handle_accelerator(UINT key, WORD modifiers)
{
    mote::CommandId command = mote::CommandId::New;
    const bool matched = mote::win::command_for_shortcut(modifiers, key, &command);
    if (!env_value("MOTE_KEYLOG").empty())
        log_line("NATIVE key vk=" + std::to_string(key)
                 + " mods=" + std::to_string(modifiers)
                 + (matched ? " cmd=" + std::to_string(static_cast<int>(command)) : ""));
    // Ctrl+V 先问剪贴板是不是图片：Chromium 转码会丢 alpha，外壳自己走图片管线
    if (key == 'V' && modifiers == FCONTROL)
        return paste_clipboard_image();
    if (!matched)
        return false;
    // 编辑类命令（撤销/剪切/复制/粘贴）留给 WebView2 原生处理
    perform_command(command);
    return true;
}

void MoteMainWindow::ensure_drop_target()
{
    if (!hwnd_ || !controller_)
        return;

    HWND wanted = mote::win::find_drop_window(hwnd_);
    if (!wanted)
        wanted = hwnd_;
    if (drop_target_ && drop_hwnd_ == wanted && IsWindow(drop_hwnd_))
        return;
    revoke_drop_target();

    mote::win::DropCallbacks callbacks;
    callbacks.can_accept = [this](const std::vector<std::string> &paths) {
        return controller_ && controller_->acceptsNativeFileDrop(paths);
    };
    callbacks.perform = [this](const std::vector<std::string> &paths) {
        if (controller_)
            controller_->handleNativeFileDrop(paths);
    };

    std::string error;
    HWND target_hwnd = wanted;
    void *target = mote::win::register_drop_target(wanted, callbacks, &error);
    if (!target && wanted != hwnd_) {
        // 子窗口注册失败（例如属于其他进程且拒绝）：退回主窗口
        target_hwnd = hwnd_;
        target = mote::win::register_drop_target(hwnd_, callbacks, &error);
    }
    drop_target_ = target;
    drop_hwnd_ = target ? target_hwnd : nullptr;
    if (!target) {
        log_line("NATIVE drop target unavailable: " + error);
    } else {
        wchar_t name[64] = {};
        GetClassNameW(drop_hwnd_, name, 64);
        log_line("NATIVE drop target on " + wide_to_utf8(name) + " "
                 + std::to_string(reinterpret_cast<size_t>(drop_hwnd_)));
    }
}

void MoteMainWindow::revoke_drop_target()
{
    if (drop_target_) {
        mote::win::revoke_drop_target(drop_hwnd_, drop_target_);
        drop_target_ = nullptr;
    }
    drop_hwnd_ = nullptr;
}

void MoteMainWindow::drop_received(const std::string &name, const std::string &text)
{
    (void)name;
    // 拖入等同「打开另一份文档」：有未保存修改时先问，不能在用户不知情时覆盖。
    if (!prepare_for_replace(AfterSave::DropDocument, "", text))
        return;
    load_dropped_text(text);
}

void MoteMainWindow::load_dropped_text(const std::string &text)
{
    // WebView 不暴露拖入文件的真实路径，只能作为「未命名」文档载入
    file_path_.clear();
    last_dir_.clear();
    last_text_ = text;
    controller_->setMarkdown(text, "");
    update_title();
    status_message("已载入拖入的文档（未关联磁盘路径，保存时会询问位置）");
}

void MoteMainWindow::set_clipboard(const std::string &text, const std::string &html)
{
    if (!OpenClipboard(hwnd_))
        return;
    EmptyClipboard();

    const std::wstring wide = utf8_to_wide(text);
    std::string utf16(reinterpret_cast<const char *>(wide.data()), wide.size() * 2);
    utf16.append(2, '\0'); // CF_UNICODETEXT 需要双字节结尾
    put_clipboard_bytes(CF_UNICODETEXT, utf16);

    if (!html.empty()) {
        static const char kPrefix[] = "<!--StartFragment-->";
        static const char kSuffix[] = "<!--EndFragment-->";
        const std::string body = std::string(kPrefix) + html + kSuffix;
        char probe[256] = {};
        const int header_length = std::snprintf(
            probe, sizeof(probe),
            "Version:0.9\r\nStartHTML:%010u\r\nEndHTML:%010u\r\n"
            "StartFragment:%010u\r\nEndFragment:%010u\r\n",
            0u, 0u, 0u, 0u);
        char header[256] = {};
        std::snprintf(header, sizeof(header),
                      "Version:0.9\r\nStartHTML:%010u\r\nEndHTML:%010u\r\n"
                      "StartFragment:%010u\r\nEndFragment:%010u\r\n",
                      static_cast<unsigned>(header_length),
                      static_cast<unsigned>(header_length + body.size()),
                      static_cast<unsigned>(header_length + sizeof(kPrefix) - 1),
                      static_cast<unsigned>(header_length + sizeof(kPrefix) - 1
                                            + html.size()));
        put_clipboard_bytes(RegisterClipboardFormatW(L"HTML Format"),
                            std::string(header) + body);
    }
    CloseClipboard();
}

std::string MoteMainWindow::clipboard_text()
{
    // 资源管理器复制的文件列表不是可粘贴正文
    if (IsClipboardFormatAvailable(CF_HDROP))
        return std::string();
    if (!OpenClipboard(hwnd_))
        return std::string();
    std::string result;
    if (HANDLE data = GetClipboardData(CF_UNICODETEXT)) {
        if (auto *wide = static_cast<const wchar_t *>(GlobalLock(data))) {
            result = wide_to_utf8(wide);
            GlobalUnlock(data);
        }
    }
    CloseClipboard();
    return result;
}

void MoteMainWindow::open_external(const std::string &raw_url)
{
    // 链接文本直接来自文档，可以是任意内容。规则与 macOS 端一致：
    //   http/https/mailto            → 交给系统默认程序
    //   file: / 无 scheme 的相对路径  → 本地文件；.md 在应用内打开，其余交系统
    //   其它 scheme（javascript:/ms-*/vbscript: 等）→ 一律拒绝
    std::string url = raw_url;
    // 去掉首尾空白与控制字符，否则 " javascript:..." 这类可以绕过 scheme 判断
    while (!url.empty() && static_cast<unsigned char>(url.front()) <= 0x20)
        url.erase(url.begin());
    while (!url.empty() && static_cast<unsigned char>(url.back()) <= 0x20)
        url.pop_back();
    if (url.empty())
        return;
    // 文档内锚点由页面自己滚动，不走外壳
    if (url.front() == '#')
        return;

    std::string scheme;
    const size_t colon = url.find(':');
    // 冒号前出现 / ? # 说明不是 scheme（如 "./a.md"），按相对路径处理
    if (colon != std::string::npos && url.find_first_of("/?#") >= colon) {
        scheme = url.substr(0, colon);
        for (char &c : scheme) {
            if (c >= 'A' && c <= 'Z') {
                c = static_cast<char>(c - 'A' + 'a');
            } else if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                         || c == '+' || c == '-' || c == '.')) {
                // 非法 scheme 字符：不当作外链，落到本地路径分支由存在性检查兜底
                scheme.clear();
                break;
            }
        }
    }

    if (scheme == "http" || scheme == "https" || scheme == "mailto") {
        ShellExecuteW(hwnd_, L"open", utf8_to_wide(url).c_str(), nullptr, nullptr,
                      SW_SHOWNORMAL);
        return;
    }

    // 盘符（C:/x.md、C:\x.md）不是 scheme：单字母当本地绝对路径，交给下面的路径分支
    if (scheme.size() == 1 && scheme[0] >= 'a' && scheme[0] <= 'z')
        scheme.clear();

    std::string local;
    if (scheme == "file") {
        std::string rest = url.substr(5);
        if (rest.rfind("///", 0) == 0)
            rest.erase(0, 3);            // file:///C:/x → C:/x
        else if (rest.rfind("//", 0) == 0)
            rest = "\\\\" + rest.substr(2); // UNC：//server/share → \\server\share
        local = url_to_local_path(rest);
    } else if (scheme.empty()) {
        // 去掉 ?query / #fragment 后再当文件路径用
        std::string bare = url;
        const size_t cut = bare.find_first_of("?#");
        if (cut != std::string::npos)
            bare.erase(cut);
        if (bare.empty())
            return;
        bare = url_to_local_path(bare);
        // 根路径（\server\share）与盘符路径（C:\docs\x.md）都不拼 last_dir_
        const bool rooted = (!bare.empty() && bare.front() == '\\')
            || (bare.size() >= 2 && bare[1] == ':');
        local = (rooted || last_dir_.empty()) ? bare : last_dir_ + "\\" + bare;
    } else {
        status_message("不支持打开的链接类型：" + raw_url);
        return;
    }

    // 路径是 UTF-8，必须经 utf8_to_wide 构造 path，否则中文名按 ANSI 解释
    const std::filesystem::path target(utf8_to_wide(local));
    std::error_code error;
    if (local.empty() || !std::filesystem::exists(target, error)) {
        MoteAlert(hwnd_, L"链接目标不存在", "找不到链接指向的文件：\n" + raw_url);
        return;
    }
    if (mote::isMarkdownPath(local)) {
        if (prepare_for_replace(AfterSave::OpenPath, local))
            open_path(local);
        return;
    }
    ShellExecuteW(hwnd_, L"open", utf8_to_wide(local).c_str(), nullptr, nullptr,
                  SW_SHOWNORMAL);
}
