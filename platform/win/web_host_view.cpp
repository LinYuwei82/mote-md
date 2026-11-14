#include "web_host_view.h"

#include "core/inject_chunks.h"
#include "core/js_bridge.h"
#include "core/json.h"

#include <shlobj.h>
#include <shlwapi.h>
#include <urlmon.h>
#include <wrl/event.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

using GetVersionFn = HRESULT(STDMETHODCALLTYPE *)(PCWSTR, LPWSTR *);
using CreateEnvironmentFn = HRESULT(STDMETHODCALLTYPE *)(
    PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);

// 页面只认 window.webkit.messageHandlers.mote，这里把 WebView2 的 postMessage 接过去。
// 必须在导航前用 AddScriptToExecuteOnDocumentCreated 注入，页面初始化就能发消息。
const wchar_t kBridgeScript[] = LR"JS(
(function () {
  if (window.__moteWinBridge) return;
  window.__moteWinBridge = true;
  function post(message) {
    try { window.chrome.webview.postMessage(message); } catch (e) {}
  }
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.mote = { postMessage: post };
  // 大文档注入通道：宿主 PostWebMessageAsJson 不占 ExecuteScript 的体积额度
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', function (event) {
      var data = event.data;
      if (data && data.__mote === 'setMarkdown' && window.mote)
        window.mote.setMarkdown(data.text);
    });
  }
})();
)JS";

std::wstring utf8_to_wide(const std::string &text);
std::string wide_to_utf8(const std::wstring &text);

// 单条脚本与单条消息的体积预算：WebView2 在 2MB 量级封顶，
// 各留一半余量给 JSON 转义与 UTF-8 膨胀（中文每字符 3 字节）。
constexpr std::size_t kScriptBudget = 512 * 1024;
constexpr std::size_t kMessageBudget = 1536 * 1024;

void log_line(const wchar_t *text)
{
    OutputDebugStringW(text);
    OutputDebugStringW(L"\n");
    if (const char *path = std::getenv("MOTE_LOG"); path && *path) {
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
    const char *value = std::getenv("MOTE_INLINE_PROTO");
    if (!value)
        return true;
    const std::string text(value);
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

} // namespace

WebHostView::WebHostView(HWND parent, std::function<void()> on_page_loaded,
                         std::function<void(std::string_view)> on_message,
                         std::function<bool()> on_image_paste)
    : parent_(parent)
    , page_loaded_(std::move(on_page_loaded))
    , message_(std::move(on_message))
    , image_paste_(std::move(on_image_paste))
{
    initialize();
}

WebHostView::~WebHostView()
{
    *alive_ = false;
    if (controller_) {
        if (accelerator_token_.value)
            controller_->remove_AcceleratorKeyPressed(accelerator_token_);
        controller_->Close();
        controller_.Reset();
    }
    webview_.Reset();
    environment_.Reset();
    if (loader_) {
        FreeLibrary(loader_);
        loader_ = nullptr;
    }
    // 临时页面写在文档目录，退出时尽量清理自己那份
    if (!page_file_.empty())
        DeleteFileW(page_file_.c_str());
}

void WebHostView::initialize()
{
    // 与 Qt 版一致：动态加载 Loader，不引入 WebView2Loader.lib，
    // 缺失时给出可操作的提示，而不是启动即崩。
    loader_ = LoadLibraryW(L"WebView2Loader.dll");
    if (!loader_) {
        log_line(L"load WebView2Loader.dll failed");
        fail(L"缺少 WebView2Loader.dll。\n\n请重新解压完整压缩包，或重新安装 Mote。");
        return;
    }
    log_line(L"WebView2Loader.dll loaded");

    auto get_version = reinterpret_cast<GetVersionFn>(
        GetProcAddress(loader_, "GetAvailableCoreWebView2BrowserVersionString"));
    auto create_environment = reinterpret_cast<CreateEnvironmentFn>(
        GetProcAddress(loader_, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!get_version || !create_environment) {
        log_line(L"GetProcAddress failed");
        fail(L"WebView2Loader.dll 版本不匹配（缺少环境创建接口）。");
        return;
    }

    LPWSTR version = nullptr;
    const HRESULT version_result = get_version(nullptr, &version);
    if (FAILED(version_result) || !version) {
        log_line(L"GetAvailableCoreWebView2BrowserVersionString failed");
        fail(L"未检测到 Microsoft Edge WebView2 Runtime。\n\n"
             L"请安装运行时后重试：https://go.microsoft.com/fwlink/p/?LinkId=2124703");
        return;
    }
    log_line((std::wstring(L"WebView2 runtime: ") + version).c_str());
    CoTaskMemFree(version);

    const std::wstring data_directory = user_data_directory();
    log_line((std::wstring(L"data dir: ") + data_directory).c_str());
    const HRESULT created = create_environment(
        nullptr, data_directory.c_str(), nullptr,
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment *environment) -> HRESULT {
                log_line(L"env callback fired");
                if (!*alive_)
                    return S_OK;
                if (FAILED(result) || !environment) {
                    log_line(L"env creation failed");
                    fail(L"WebView2 环境创建失败。");
                    return S_OK;
                }
                environment_ = environment;
                environment_->CreateCoreWebView2Controller(
                    parent_,
                    Microsoft::WRL::Callback<
                        ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [this](HRESULT controller_result,
                               ICoreWebView2Controller *controller) -> HRESULT {
                            log_line(L"controller callback fired");
                            if (*alive_)
                                on_controller_created(controller_result, controller);
                            return S_OK;
                        })
                        .Get());
                return S_OK;
            })
            .Get());
    if (FAILED(created)) {
        log_line(L"CreateCoreWebView2EnvironmentWithOptions failed");
        fail(L"WebView2 环境创建失败。");
    }
}

void WebHostView::on_controller_created(HRESULT result, ICoreWebView2Controller *controller)
{
    if (FAILED(result) || !controller) {
        fail(L"WebView2 控制器创建失败。");
        return;
    }
    controller_ = controller;
    controller_->put_IsVisible(TRUE);

    // 关掉 WebView2 自带的 HTML5 外部拖放：开着时 Chromium 会占用子窗口的
    // IDropTarget，宿主注册的文件拖放收不到 Drop（拖进来毫无反应）。
    // 编辑器页面本身不需要 HTML5 拖放，文件拖放统一走 platform/win/drop_target。
    Microsoft::WRL::ComPtr<ICoreWebView2Controller4> controller4;
    if (SUCCEEDED(controller_.As(&controller4)) && controller4)
        controller4->put_AllowExternalDrop(FALSE);

    RECT bounds = {};
    GetClientRect(parent_, &bounds);
    controller_->put_Bounds(bounds);

    if (FAILED(controller_->get_CoreWebView2(webview_.GetAddressOf())) || !webview_) {
        fail(L"WebView2 初始化失败。");
        return;
    }

    webview_->AddScriptToExecuteOnDocumentCreated(kBridgeScript, nullptr);

    // 页面消息：先比对 URL fragment 的页面代次，丢掉上一个页面迟到的消息
    webview_->add_WebMessageReceived(
        Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this](ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
                if (!*alive_ || !args || !message_)
                    return S_OK;
                LPWSTR source = nullptr;
                LPWSTR json = nullptr;
                args->get_Source(&source);
                args->get_WebMessageAsJson(&json);
                const bool current = source && is_current_source(source);
                if (current && json)
                    message_(wide_to_utf8(json));
                if (source)
                    CoTaskMemFree(source);
                if (json)
                    CoTaskMemFree(json);
                return S_OK;
            })
            .Get(),
        &message_token_);

    webview_->add_NavigationCompleted(
        Microsoft::WRL::Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [this](ICoreWebView2 *, ICoreWebView2NavigationCompletedEventArgs *args) -> HRESULT {
                if (!*alive_)
                    return S_OK;
                BOOL success = FALSE;
                if (args)
                    args->get_IsSuccess(&success);
                if (!success) {
                    fail(L"编辑器页面加载失败。");
                    return S_OK;
                }
                log_line(L"page loaded");
                if (page_loaded_)
                    page_loaded_();
                return S_OK;
            })
            .Get(),
        &navigation_token_);

    // Ctrl+V 优先走外壳剪贴板：Chromium 把 CF_DIB 转成图片时会丢弃 alpha，
    // 只有外壳自己解码才能保住透明通道。剪贴板里没有图片时交回 Chromium，
    // 文本粘贴、源码模式 textarea 与页面内输入框的行为都不变。
    if (image_paste_) {
        controller_->add_AcceleratorKeyPressed(
            Microsoft::WRL::Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
                [this](ICoreWebView2Controller *,
                       ICoreWebView2AcceleratorKeyPressedEventArgs *args) -> HRESULT {
                    if (!*alive_ || !args || !image_paste_)
                        return S_OK;
                    COREWEBVIEW2_KEY_EVENT_KIND kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                    args->get_KeyEventKind(&kind);
                    if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                        && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)
                        return S_OK;
                    UINT key = 0;
                    args->get_VirtualKey(&key);
                    if (key != 'V' || GetKeyState(VK_CONTROL) >= 0)
                        return S_OK;
                    if (image_paste_())
                        args->put_Handled(TRUE);
                    return S_OK;
                })
                .Get(),
            &accelerator_token_);
    }

    if (page_pending_) {
        page_pending_ = false;
        load_page(pending_dir_);
    }
}

void WebHostView::load_page(const std::string &base_dir)
{
    if (!webview_) {
        // 控制器还没建好：记住目录，建好后补一次导航
        page_pending_ = true;
        pending_dir_ = base_dir;
        return;
    }

    ++generation_;
    std::wstring url;
    if (!build_page(base_dir, &url)) {
        fail(L"无法准备编辑器页面。\n\n请确认发布包内的 web 目录完整。");
        return;
    }
    log_line(L"navigate editor page");
    webview_->Navigate(url.c_str());
}

bool WebHostView::build_page(const std::string &base_dir, std::wstring *url)
{
    const std::wstring web_dir = exe_directory() + L"\\web";
    std::string page = read_file(web_dir + L"\\editor.html");
    const std::string css = read_file(web_dir + L"\\editor.css");
    const std::string js = read_file(web_dir + L"\\editor.js");
    if (page.empty() || css.empty() || js.empty())
        return false;

    std::string style = wide_to_utf8(font_face_css());
    style += css;
    replace_all(page, "__MOTE_CSS__", style);
    const std::string flag = inline_proto_enabled()
        ? "window.MOTE_INLINE_PROTO=true;"
        : "window.MOTE_INLINE_PROTO=false;";
    replace_all(page, "__MOTE_JS__", flag + js);

    if (!base_dir.empty()) {
        const std::string base = html_escape(directory_url(base_dir));
        const size_t head = page.find("</head>");
        if (!base.empty() && head != std::string::npos) {
            page.insert(head, "<base href=\"" + base + "\">");
        }
    }

    std::wstring directory;
    if (base_dir.empty()) {
        wchar_t temp[MAX_PATH] = {};
        GetTempPathW(MAX_PATH, temp);
        directory = temp;
        if (!directory.empty() && directory.back() == L'\\')
            directory.pop_back();
    } else {
        directory = utf8_to_wide(base_dir);
    }

    const std::wstring name = L"\\.mote-preview-"
        + std::to_wstring(GetCurrentProcessId()) + L".html";
    const std::wstring page_path = directory + name;
    if (!write_file(page_path, page))
        return false;

    if (!page_file_.empty() && page_file_ != page_path)
        DeleteFileW(page_file_.c_str());
    page_file_ = page_path;

    wchar_t raw_url[2048] = {};
    DWORD length = 2048;
    if (FAILED(UrlCreateFromPathW(page_path.c_str(), raw_url, &length, 0)))
        return false;

    std::wstring target(raw_url);
    target += L"#g";
    target += std::to_wstring(generation_);
    *url = target;
    return true;
}

bool WebHostView::is_current_source(const std::wstring &source) const
{
    const size_t hash = source.find_last_of(L'#');
    // 没有 fragment 时无法判断代次，按 Qt 版行为放行；带 fragment 则必须匹配
    if (hash == std::wstring::npos)
        return true;
    return source.substr(hash + 1) == L"g" + std::to_wstring(generation_);
}

void WebHostView::evaluate_script(const std::string &script)
{
    if (!webview_ || script.empty())
        return;
    webview_->ExecuteScript(utf8_to_wide(script).c_str(), nullptr);
}

void WebHostView::inject_markdown(const std::string &text)
{
    if (!webview_) {
        // 页面未就绪时 core 会缓存正文，等 ready 后重走这里
        return;
    }

    const std::string quoted = mote::quoteJson(text);
    // 通道一：单条脚本，体积最省
    if (quoted.size() <= kScriptBudget) {
        evaluate_script(mote::js::setMarkdown(text));
        return;
    }

    // 通道二：PostWebMessageAsJson，由文档创建时注入的桥接脚本转交页面
    const std::string payload =
        "{\"__mote\":\"setMarkdown\",\"text\":" + quoted + "}";
    if (payload.size() <= kMessageBudget
        && SUCCEEDED(webview_->PostWebMessageAsJson(utf8_to_wide(payload).c_str()))) {
        return;
    }

    // 通道三：分片 ExecuteScript，最后一片之后拼接并交给页面
    auto run = [this](const std::string &script) {
        webview_->ExecuteScript(utf8_to_wide(script).c_str(), nullptr);
    };
    run("window.__moteInject=[];");
    for (const std::string &chunk : mote::splitUtf8ByBudget(text, kScriptBudget))
        run("window.__moteInject.push(" + mote::quoteJson(chunk) + ");");
    run("(function(){var t=(window.__moteInject||[]).join('');"
        "window.__moteInject=[];window.mote&&window.mote.setMarkdown(t);})();");
}

void WebHostView::resize(int width, int height)
{
    if (!controller_)
        return;
    RECT bounds = { 0, 0, width, height };
    controller_->put_Bounds(bounds);
}

void WebHostView::focus()
{
    if (controller_)
        controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}

void WebHostView::fail(const wchar_t *message)
{
    MessageBoxW(parent_, message, L"Mote", MB_OK | MB_ICONERROR);
}
