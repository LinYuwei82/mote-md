#include "main_window.h"

#include "web_host_view.h"

namespace {

constexpr wchar_t kWindowClass[] = L"MoteNativeWindow";
constexpr int kDefaultWidth = 1180;
constexpr int kDefaultHeight = 820;
constexpr int kMinWidth = 640;
constexpr int kMinHeight = 480;

} // namespace

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
        host_ = std::make_unique<WebHostView>(hwnd);
        layout();
        return 0;
    case WM_SIZE:
        layout();
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
    case WM_DESTROY:
        host_.reset();
        PostQuitMessage(0);
        return 0;
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
