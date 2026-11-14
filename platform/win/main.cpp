#include "main_window.h"

#include <commctrl.h>
#include <objbase.h>
#include <windows.h>

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

    int exit_code = 1;
    {
        MoteMainWindow window(instance);
        if (window.create()) {
            window.show(show_command);
            exit_code = window.run_message_loop();
        }
    }
    CoUninitialize();
    return exit_code;
}
