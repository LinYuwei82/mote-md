#include "about_dialog.h"

#include "updater_win.h"
#include "win_encoding/encoding.h"

#include <commctrl.h>
#include <shellapi.h>

#include <string>

// 与 macOS about_window.mm 同一套文案与版式：图标 / Mote / 版本 x.y.z (build)
// / 版权 / 官网超链接 / 检查更新… / 关闭。手写窗口 + 内联模态循环，
// 项目没有 .rc 对话框资源，也不引入。

namespace {

using win_encoding::utf8_to_wide;

constexpr const wchar_t *kClassName = L"MoteAboutDialog";
constexpr int kWidth = 320;
constexpr int kHeight = 322;

constexpr UINT_PTR IDC_ICON = 100;
constexpr UINT_PTR IDC_NAME = 101;
constexpr UINT_PTR IDC_VERSION = 102;
constexpr UINT_PTR IDC_COPYRIGHT = 103;
constexpr UINT_PTR IDC_LINK = 104;
constexpr UINT_PTR IDC_CHECK = 105;
constexpr UINT_PTR IDC_CLOSE = 106;

HWND g_hwnd = nullptr;
HFONT g_title_font = nullptr;
HFONT g_text_font = nullptr;
HFONT g_small_font = nullptr;

std::wstring version_line()
{
    // MOTE_VERSION 是窄字符串宏，不能与宽字面量直接拼接
    return utf8_to_wide(std::string("版本 ") + MOTE_VERSION + " (" +
                        std::to_string(MOTE_BUILD) + ")");
}

HWND make_static(HWND parent, int id, const wchar_t *text, HFONT font,
                 int x, int y, int w, int h, DWORD style = SS_CENTER)
{
    HWND ctrl = CreateWindowExW(0, L"STATIC", text,
                                WS_CHILD | WS_VISIBLE | style | SS_NOTIFY,
                                x, y, w, h, parent,
                                reinterpret_cast<HMENU>(static_cast<UINT_PTR>(id)),
                                GetModuleHandleW(nullptr), nullptr);
    SendMessageW(ctrl, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    return ctrl;
}

void layout(HWND dlg)
{
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    NONCLIENTMETRICSW metrics = {};
    metrics.cbSize = sizeof(metrics);
    if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0)) {
        g_text_font = CreateFontIndirectW(&metrics.lfMessageFont);
        LOGFONTW small = metrics.lfMessageFont;
        small.lfHeight = small.lfHeight * 11 / 12;
        g_small_font = CreateFontIndirectW(&small);
        LOGFONTW title = metrics.lfMessageFont;
        title.lfWeight = FW_BOLD;
        title.lfHeight = title.lfHeight * 17 / 12;
        g_title_font = CreateFontIndirectW(&title);
    }

    int y = 20;
    HICON icon = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON,
                                               64, 64, LR_DEFAULTCOLOR));
    if (!icon)
        icon = static_cast<HICON>(LoadIconW(instance, MAKEINTRESOURCEW(1)));
    CreateWindowExW(0, L"STATIC", nullptr,
                    WS_CHILD | WS_VISIBLE | SS_ICON,
                    (kWidth - 64) / 2, y, 64, 64, dlg,
                    reinterpret_cast<HMENU>(IDC_ICON), instance, nullptr);
    if (icon)
        SendMessageW(GetDlgItem(dlg, static_cast<int>(IDC_ICON)), STM_SETICON,
                     reinterpret_cast<WPARAM>(icon), 0);

    y += 64 + 12;
    make_static(dlg, IDC_NAME, L"Mote", g_title_font, 0, y, kWidth, 24);
    y += 24 + 4;
    static std::wstring version = version_line();
    make_static(dlg, IDC_VERSION, version.c_str(), g_text_font, 0, y, kWidth, 18);
    y += 18 + 4;
    make_static(dlg, IDC_COPYRIGHT, L"© 2026 xiaotu · 小图在线", g_small_font,
                0, y, kWidth, 16);
    y += 16 + 14;

    HWND link = CreateWindowExW(0, WC_LINK,
                                L"<a href=\"https://dl.xiaotu.online/mote/\">官网与下载</a>",
                                WS_CHILD | WS_VISIBLE | SS_CENTER,
                                0, y, kWidth, 18, dlg,
                                reinterpret_cast<HMENU>(IDC_LINK), instance, nullptr);
    SendMessageW(link, WM_SETFONT, reinterpret_cast<WPARAM>(g_text_font), TRUE);
    y += 18 + 18;

    const int check_w = 150;
    HWND check = CreateWindowExW(0, L"BUTTON", L"检查更新…",
                                 WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                 (kWidth - check_w) / 2, y, check_w, 26, dlg,
                                 reinterpret_cast<HMENU>(IDC_CHECK), instance, nullptr);
    SendMessageW(check, WM_SETFONT, reinterpret_cast<WPARAM>(g_text_font), TRUE);
    y += 26 + 8;

    const int close_w = 96;
    HWND close = CreateWindowExW(0, L"BUTTON", L"关闭",
                                 WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                                 (kWidth - close_w) / 2, y, close_w, 26, dlg,
                                 reinterpret_cast<HMENU>(IDC_CLOSE), instance, nullptr);
    SendMessageW(close, WM_SETFONT, reinterpret_cast<WPARAM>(g_text_font), TRUE);
}

LRESULT CALLBACK about_proc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam)
{
    switch (msg) {
    case WM_CREATE:
        layout(hwnd);
        return 0;
    case WM_CTLCOLORSTATIC: {
        HDC dc = reinterpret_cast<HDC>(wparam);
        SetBkMode(dc, TRANSPARENT);
        return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_BTNFACE));
    }
    case WM_COMMAND:
        switch (LOWORD(wparam)) {
        case IDC_CHECK:
            // 自研检查链路是异步的，模态循环保有 owner 消息泵，结果弹窗照常出现
            mote::win::check_for_updates_now(GetParent(hwnd));
            return 0;
        case IDC_CLOSE:
        case IDCANCEL:
            DestroyWindow(hwnd);
            return 0;
        }
        return 0;
    case WM_NOTIFY: {
        const LPNMHDR header = reinterpret_cast<LPNMHDR>(lparam);
        if (header->idFrom == IDC_LINK && header->code == NM_CLICK) {
            const PNMLINK link = reinterpret_cast<PNMLINK>(lparam);
            ShellExecuteW(hwnd, L"open", link->item.szUrl, nullptr, nullptr, SW_SHOWNORMAL);
        }
        return 0;
    }
    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        g_hwnd = nullptr;
        if (g_title_font)
            DeleteObject(g_title_font);
        if (g_text_font)
            DeleteObject(g_text_font);
        if (g_small_font)
            DeleteObject(g_small_font);
        g_title_font = g_text_font = g_small_font = nullptr;
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wparam, lparam);
}

void register_class()
{
    static bool done = false;
    if (done)
        return;
    INITCOMMONCONTROLSEX links = {};
    links.dwSize = sizeof(links);
    links.dwICC = ICC_LINK_CLASS;
    InitCommonControlsEx(&links);
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = about_proc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hbrBackground = GetSysColorBrush(COLOR_BTNFACE);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hIcon = LoadIconW(wc.hInstance, MAKEINTRESOURCEW(1));
    wc.lpszClassName = kClassName;
    RegisterClassExW(&wc);
    done = true;
}

} // namespace

void show_about_dialog(HWND owner)
{
    if (g_hwnd) {
        SetForegroundWindow(g_hwnd);
        return;
    }
    register_class();

    int x = 0;
    int y = 0;
    if (owner) {
        RECT r{};
        GetWindowRect(owner, &r);
        x = r.left + ((r.right - r.left) - kWidth) / 2;
        y = r.top + ((r.bottom - r.top) - kHeight) / 2;
    } else {
        RECT area{};
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &area, 0);
        x = (area.left + area.right - kWidth) / 2;
        y = (area.top + area.bottom - kHeight) / 2;
    }

    g_hwnd = CreateWindowExW(WS_EX_DLGMODALFRAME,
                             kClassName, L"关于 Mote",
                             WS_POPUP | WS_CAPTION | WS_SYSMENU,
                             x, y, kWidth, kHeight, owner,
                             nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!g_hwnd)
        return;
    // 标题栏/边框占高度：按客户区正好 kWidth x kHeight 修正窗口外框
    RECT wr{0, 0, kWidth, kHeight};
    AdjustWindowRect(&wr, WS_POPUP | WS_CAPTION | WS_SYSMENU, FALSE);
    MoveWindow(g_hwnd, x, y, wr.right - wr.left, wr.bottom - wr.top, TRUE);

    if (owner)
        EnableWindow(owner, FALSE);
    ShowWindow(g_hwnd, SW_SHOW);
    SetForegroundWindow(g_hwnd);
    if (HWND focus = GetDlgItem(g_hwnd, static_cast<int>(IDC_CLOSE)))
        SetFocus(focus);

    MSG msg{};
    while (IsWindow(g_hwnd)) {
        const BOOL got = GetMessageW(&msg, nullptr, 0, 0);
        if (got == 0 || got == -1)
            break;
        if (!IsDialogMessageW(g_hwnd, &msg)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    if (owner) {
        EnableWindow(owner, TRUE);
        SetForegroundWindow(owner);
    }
}
