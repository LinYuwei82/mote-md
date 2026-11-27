#include "main_window.h"
#include "menus.h"

#include "win_encoding/encoding.h"

#include "core/perf.h"

#include <commctrl.h>
#include <objbase.h>
#include <shellapi.h>
#include <windows.h>

#include <string>

namespace {

std::string wide_to_utf8(const wchar_t *text)
{
    if (!text)
        return std::string();
    return win_encoding::wide_to_utf8(text);
}

// 应用级消息循环（多窗口共享）：加速键按当前活动窗口翻译；
// 末窗 WM_DESTROY 发 PostQuitMessage 后自然退出。
int run_message_loop()
{
    HACCEL accel = mote::win::build_accelerators();
    MSG message = {};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        HWND active = GetActiveWindow();
        if (accel && active && TranslateAcceleratorW(active, accel, &message))
            continue;
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    if (accel)
        DestroyAcceleratorTable(accel);
    return static_cast<int>(message.wParam);
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show_command)
{
    mote::perfReset();
    mote::perfMark("win:proc_entry");
    // 先声明 DPI 感知，再建窗口：WebView2 的 bounds 才能按物理像素对齐
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    const HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(com))
        return 1;

    INITCOMMONCONTROLSEX controls = {};
    controls.dwSize = sizeof(controls);
    controls.dwICC = ICC_STANDARD_CLASSES;
    InitCommonControlsEx(&controls);

    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);

    // 单实例转发：应用已在运行时双击 .md，把路径交给已有实例（由它开新窗口）
    // 并退出，不再冷启动第二个进程（配合免重载，热打开接近秒开）。
    if (argc > 1 && argv && argv[1]) {
        const std::string forwarded = wide_to_utf8(argv[1]);
        if (MoteMainWindow::forward_path_to_existing(forwarded)) {
            LocalFree(argv);
            if (SUCCEEDED(com))
                CoUninitialize();
            return 0;
        }
    }

    int exit_code = 1;
    {
        // 首窗口即带命令行文件（保持免双载优化）；后续窗口由转发/菜单创建
        const std::string pending = argc > 1 && argv && argv[1]
            ? wide_to_utf8(argv[1])
            : std::string();
        if (MoteMainWindow::create_new(instance, pending, show_command)) {
            mote::perfMark("win:window_shown");
            exit_code = run_message_loop();
        }
    }

    if (argv)
        LocalFree(argv);
    CoUninitialize();
    return exit_code;
}
