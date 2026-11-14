#include "main_window.h"

#include "dialogs.h"
#include "menus.h"
#include "web_host_view.h"

#include "core/editor_controller.h"
#include "core/js_bridge.h"

#include <shlobj.h>
#include <shellapi.h>

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
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

void log_line(const std::string &text)
{
    const std::wstring wide = utf8_to_wide(text);
    OutputDebugStringW(wide.c_str());
    OutputDebugStringW(L"\n");
    if (const char *path = std::getenv("MOTE_LOG"); path && *path) {
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
    if (text->size() >= 3 && static_cast<unsigned char>((*text)[0]) == 0xEF
        && static_cast<unsigned char>((*text)[1]) == 0xBB
        && static_cast<unsigned char>((*text)[2]) == 0xBF) {
        text->erase(0, 3);
    }
    return true;
}

bool write_text_file(const std::string &path, const std::string &text)
{
    std::ofstream file(std::filesystem::path(utf8_to_wide(path)),
                       std::ios::binary | std::ios::trunc);
    if (!file)
        return false;
    file.write(text.data(), static_cast<std::streamsize>(text.size()));
    return file.good();
}

std::string with_extension(std::string path, const char *extension)
{
    const size_t slash = path.find_last_of("\\/");
    const size_t dot = path.find_last_of('.');
    if (dot == std::string::npos || (slash != std::string::npos && dot < slash))
        path += std::string(".") + extension;
    return path;
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

} // namespace

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
        (void)html;
        owner_.status_message("导出 HTML 将在 N4 实现");
    }
    void exportPdfRequested(const std::string &path) override
    {
        (void)path;
        owner_.status_message("导出 PDF 将在 N4 实现");
    }
    void exportPdfFailed(const std::string &message) override
    {
        owner_.status_message(message);
    }
    void fileDropRequested(const std::string &path) override
    {
        (void)path;
        owner_.status_message("原生拖放将在 N3 实现");
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
        if (std::getenv("MOTE_KEYLOG"))
            log_line("NATIVE stats cjk=" + std::to_string(cjk)
                     + " words=" + std::to_string(words));
    }
    void logMessage(const std::string &message) override
    {
        if (std::getenv("MOTE_KEYLOG"))
            log_line("JSLOG " + message);
    }

private:
    MoteMainWindow &owner_;
};

MoteMainWindow::MoteMainWindow(HINSTANCE instance)
    : instance_(instance)
{
}

MoteMainWindow::~MoteMainWindow()
{
    if (hwnd_ && IsWindow(hwnd_))
        DestroyWindow(hwnd_);
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
    return hwnd_ != nullptr;
}

void MoteMainWindow::show(int show_command)
{
    if (!hwnd_)
        return;
    ShowWindow(hwnd_, show_command);
    UpdateWindow(hwnd_);
}

int MoteMainWindow::run_message_loop()
{
    MSG message = {};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (accel_ && TranslateAcceleratorW(hwnd_, accel_, &message))
            continue;
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return static_cast<int>(message.wParam);
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
            });
        shell_ = std::make_unique<ShellHost>(*this);
        controller_ = std::make_unique<mote::EditorController>(*shell_);
        load_builtin_sample();
        layout();

        SetMenu(hwnd, mote::win::build_main_menu());
        accel_ = mote::win::build_accelerators();
        follow_system_ = true;
        apply_theme();
        return 0;
    case WM_COMMAND: {
        const UINT id = LOWORD(wparam);
        if (id == mote::win::kExitCommandId) {
            SendMessageW(hwnd, WM_CLOSE, 0, 0);
            return 0;
        }
        // 菜单项 id 就是 CommandId；未知 id（控件通知等）直接忽略
        if (const mote::CommandSpec *spec =
                mote::findCommand(static_cast<mote::CommandId>(id)))
            perform_command(spec->id);
        return 0;
    }
    case WM_TIMER:
        if (wparam == kStartupCommandTimer) {
            KillTimer(hwnd, kStartupCommandTimer);
            run_startup_command();
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
    case WM_SIZE:
        layout();
        return 0;
    case WM_CLOSE:
        if (confirm_close())
            DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        host_.reset();
        controller_.reset();
        shell_.reset();
        if (accel_) {
            DestroyAcceleratorTable(accel_);
            accel_ = nullptr;
        }
        PostQuitMessage(0);
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

void MoteMainWindow::open_path(const std::string &path)
{
    std::string text;
    if (!read_text_file(path, &text)) {
        MoteAlert(hwnd_, L"无法打开", "读取文件失败：\n" + path);
        return;
    }

    file_path_ = path;
    last_dir_ = parent_dir(path);
    last_text_ = text;
    controller_->setMarkdown(text, last_dir_);
    update_title();
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
        if (const char *forced = std::getenv("MOTE_SAVE_AS"); forced && *forced)
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
    log_line("NATIVE save " + path);
    status_message("已保存：" + path);
    run_after_save();
}

bool MoteMainWindow::write_text(const std::string &text, const std::string &path)
{
    if (write_text_file(path, text))
        return true;
    MoteAlert(hwnd_, L"保存失败", "无法写入文件：\n" + path);
    return false;
}

bool MoteMainWindow::prepare_for_replace(AfterSave after, const std::string &path)
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
        controller_->requestSnapshot();
        return false;
    }
    return false;
}

void MoteMainWindow::run_after_save()
{
    const AfterSave after = after_save_;
    const std::string path = after_save_path_;
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
        status_message("导出 PDF 将在 N4 实现");
        break;
    case AfterSave::None:
        break;
    }
}

void MoteMainWindow::reset_after_save()
{
    after_save_ = AfterSave::None;
    after_save_path_.clear();
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
    if (host_)
        host_->load_page(base_dir);
}

void MoteMainWindow::navigation_completed()
{
    if (!controller_)
        return;
    host_->evaluate_script(mote::js::enableStatusBar("win"));
    host_->focus();
    update_title();
    log_line("NATIVE navigation completed");
}

void MoteMainWindow::page_ready()
{
    log_line("NATIVE ready gen=" + std::to_string(controller_->pageGeneration()));
    if (!pending_status_.empty())
        show_status(pending_status_);
    update_title();
    update_menu_state();
    // MOTE_COMMAND 诊断钩子：页面就绪后再等 700ms，避开首帧布局
    if (!startup_command_done_ && std::getenv("MOTE_COMMAND"))
        SetTimer(hwnd_, kStartupCommandTimer, 700, nullptr);
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
    pending_status_ = text;
    if (controller_ && controller_->pageReady())
        host_->evaluate_script(mote::js::statusMessage(text));
}

void MoteMainWindow::perform_command(mote::CommandId command)
{
    const mote::CommandSpec *spec = mote::findCommand(command);
    if (std::getenv("MOTE_KEYLOG") && spec)
        log_line("NATIVE command " + spec->title);

    switch (command) {
    case mote::CommandId::New:
        new_document();
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
        // 原生 PDF 分页导出在 N4 接入
        status_message("导出 PDF 将在 N4 实现");
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
    if (std::getenv("MOTE_KEYLOG"))
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
    // 与 Qt 版一致：源码模式（textarea）由 WebView2 原生处理编辑命令
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
    const char *raw = std::getenv("MOTE_COMMAND");
    if (!raw || !*raw)
        return;
    startup_command_done_ = true;

    std::string name;
    for (const char *item = raw; *item; ++item) {
        const unsigned char ch = static_cast<unsigned char>(*item);
        if (!std::isspace(ch))
            name += static_cast<char>(std::tolower(ch));
    }

    const std::pair<const char *, mote::CommandId> table[] = {
        { "new", mote::CommandId::New },
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

void MoteMainWindow::drop_received(const std::string &name, const std::string &text)
{
    (void)name;
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

void MoteMainWindow::open_external(const std::string &url)
{
    const std::wstring wide = utf8_to_wide(url);
    ShellExecuteW(hwnd_, L"open", wide.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}
