#include "main_window.h"

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

    // 单实例转发：应用已在运行时双击 .md，把路径交给已有窗口并退出，
    // 不再冷启动第二个进程（配合免重载，热打开接近秒开）。
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
        MoteMainWindow window(instance);
        if (argc > 1 && argv && argv[1])
            window.set_pending_path(wide_to_utf8(argv[1]));
        if (window.create()) {
            window.show(show_command);
            mote::perfMark("win:window_shown");
            exit_code = window.run_message_loop();
        }
    }

    if (argv)
        LocalFree(argv);
    CoUninitialize();
    return exit_code;
}
