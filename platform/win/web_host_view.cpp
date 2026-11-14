#include "web_host_view.h"

#include "core/js_bridge.h"

#include <shlobj.h>
#include <urlmon.h>
#include <wrl/event.h>

#include <string>

namespace {

using GetVersionFn = HRESULT(STDMETHODCALLTYPE *)(PCWSTR, LPWSTR *);
using CreateEnvironmentFn = HRESULT(STDMETHODCALLTYPE *)(
    PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);

void log_line(const wchar_t *text)
{
    OutputDebugStringW(text);
    OutputDebugStringW(L"\n");
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

} // namespace

WebHostView::WebHostView(HWND parent)
    : parent_(parent)
{
    initialize();
}

WebHostView::~WebHostView()
{
    *alive_ = false;
    if (controller_) {
        controller_->Close();
        controller_.Reset();
    }
    webview_.Reset();
    environment_.Reset();
    if (loader_) {
        FreeLibrary(loader_);
        loader_ = nullptr;
    }
}

void WebHostView::initialize()
{
    // 与 Qt 版一致：动态加载 Loader，不引入 WebView2Loader.lib，
    // 缺失时给出可操作的提示，而不是启动即崩。
    loader_ = LoadLibraryW(L"WebView2Loader.dll");
    if (!loader_) {
        fail(L"缺少 WebView2Loader.dll。\n\n请重新解压完整压缩包，或重新安装 Mote。");
        return;
    }

    auto get_version = reinterpret_cast<GetVersionFn>(
        GetProcAddress(loader_, "GetAvailableCoreWebView2BrowserVersionString"));
    auto create_environment = reinterpret_cast<CreateEnvironmentFn>(
        GetProcAddress(loader_, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!get_version || !create_environment) {
        fail(L"WebView2Loader.dll 版本不匹配（缺少环境创建接口）。");
        return;
    }

    LPWSTR version = nullptr;
    const HRESULT version_result = get_version(nullptr, &version);
    if (FAILED(version_result) || !version) {
        fail(L"未检测到 Microsoft Edge WebView2 Runtime。\n\n"
             L"请安装运行时后重试：https://go.microsoft.com/fwlink/p/?LinkId=2124703");
        return;
    }
    CoTaskMemFree(version);

    const std::wstring data_directory = user_data_directory();
    const HRESULT created = create_environment(
        nullptr, data_directory.c_str(), nullptr,
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment *environment) -> HRESULT {
                if (!*alive_)
                    return S_OK;
                if (FAILED(result) || !environment) {
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
                            if (*alive_)
                                on_controller_created(controller_result, controller);
                            return S_OK;
                        })
                        .Get());
                return S_OK;
            })
            .Get());
    if (FAILED(created))
        fail(L"WebView2 环境创建失败。");
}

void WebHostView::on_controller_created(HRESULT result, ICoreWebView2Controller *controller)
{
    if (FAILED(result) || !controller) {
        fail(L"WebView2 控制器创建失败。");
        return;
    }
    controller_ = controller;
    controller_->put_IsVisible(TRUE);

    RECT bounds = {};
    GetClientRect(parent_, &bounds);
    controller_->put_Bounds(bounds);

    if (FAILED(controller_->get_CoreWebView2(webview_.GetAddressOf())) || !webview_) {
        fail(L"WebView2 初始化失败。");
        return;
    }

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
                ready_ = true;
                inject_sample();
                return S_OK;
            })
            .Get(),
        &navigation_token_);

    navigate_to_editor();
}

void WebHostView::navigate_to_editor()
{
    const std::wstring page = exe_directory() + L"\\web\\editor.html";
    if (GetFileAttributesW(page.c_str()) == INVALID_FILE_ATTRIBUTES) {
        fail(L"缺少 web/editor.html。\n\n请确认发布包完整，web 目录应与 Mote.exe 同级。");
        return;
    }

    wchar_t url[2048] = {};
    DWORD url_length = 2048;
    std::wstring target;
    if (SUCCEEDED(UrlCreateFromPathW(page.c_str(), url, &url_length, 0)))
        target = url;
    else
        target = L"file:///" + page;

    log_line(L"navigate editor page");
    webview_->Navigate(target.c_str());
}

void WebHostView::inject_sample()
{
    // N0 只验证页面与渲染链路：直接调前端 API 注入示例正文；
    // N1 起改由 core::EditorController 统一注入与消息分发。
    const std::string script = mote::js::setMarkdown(
        "# 阶段 B N0\n\n"
        "WebView2 已就绪，页面资源来自 `resources/web`，由原生外壳直接加载。\n\n"
        "- 无 Qt 依赖\n"
        "- 与 macOS 共用前端\n");
    webview_->ExecuteScript(utf8_to_wide(script).c_str(), nullptr);
}

void WebHostView::resize(int width, int height)
{
    if (!controller_)
        return;
    RECT bounds = { 0, 0, width, height };
    controller_->put_Bounds(bounds);
}

void WebHostView::fail(const wchar_t *message)
{
    MessageBoxW(parent_, message, L"Mote", MB_OK | MB_ICONERROR);
}
