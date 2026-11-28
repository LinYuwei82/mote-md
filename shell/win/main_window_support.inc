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

