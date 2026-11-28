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

