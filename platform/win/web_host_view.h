#pragma once

#include <windows.h>
#include <WebView2.h>
#include <wrl/client.h>

#include <memory>
#include <string>

// WebView2 宿主（阶段 B N0）：只负责环境/控制器创建、页面加载与尺寸同步。
// 消息桥、文档状态与命令分发在 N1 起接入 core/EditorController。
class WebHostView
{
public:
    explicit WebHostView(HWND parent);
    ~WebHostView();

    void resize(int width, int height);
    bool ready() const { return ready_; }

private:
    void initialize();
    void fail(const wchar_t *message);
    void on_controller_created(HRESULT result, ICoreWebView2Controller *controller);
    void navigate_to_editor();
    void inject_sample();

    HWND parent_ = nullptr;
    HMODULE loader_ = nullptr;
    Microsoft::WRL::ComPtr<ICoreWebView2Environment> environment_;
    Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
    Microsoft::WRL::ComPtr<ICoreWebView2> webview_;
    EventRegistrationToken navigation_token_{};
    bool ready_ = false;
    // 异步回调可能在窗口关闭后才到；用弱标记避免访问已析构的 this
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};
