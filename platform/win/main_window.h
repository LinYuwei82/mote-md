#pragma once

#include <windows.h>

#include <memory>

class WebHostView;

// Windows 原生主窗口（阶段 B N0）：创建窗口、承载 WebView2、同步客户区尺寸。
class MoteMainWindow
{
public:
    explicit MoteMainWindow(HINSTANCE instance);
    ~MoteMainWindow();

    bool create();
    void show(int show_command);
    int run_message_loop();

private:
    static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
    LRESULT handle_message(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
    void layout();

    HINSTANCE instance_ = nullptr;
    HWND hwnd_ = nullptr;
    std::unique_ptr<WebHostView> host_;
};
