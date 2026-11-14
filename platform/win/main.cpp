#include "main_window.h"

#include <commctrl.h>
#include <objbase.h>
#include <shellapi.h>
#include <windows.h>

#include <string>

namespace {

std::string wide_to_utf8(const wchar_t *text)
{
    if (!text || !*text)
        return std::string();
    const int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0,
                                           nullptr, nullptr);
    if (length <= 1)
        return std::string();
    std::string narrow(static_cast<size_t>(length - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, narrow.data(), length, nullptr, nullptr);
    return narrow;
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show_command)
{
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

    int exit_code = 1;
    {
        MoteMainWindow window(instance);
        if (window.create()) {
            if (argc > 1 && argv && argv[1])
                window.open_path(wide_to_utf8(argv[1]));
            window.show(show_command);
            exit_code = window.run_message_loop();
        }
    }

    if (argv)
        LocalFree(argv);
    CoUninitialize();
    return exit_code;
}
