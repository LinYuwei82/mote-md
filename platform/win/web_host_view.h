#pragma once

#include <windows.h>
#include <WebView2.h>
#include <wrl/client.h>

#include <functional>
#include <memory>
#include <string>
#include <string_view>

// WebView2 宿主（阶段 B N1）：创建环境/控制器、组装临时页面、转发消息。
// 文档状态、协议分发与菜单命令都在 core/EditorController。
class WebHostView
{
public:
    // on_page_loaded：导航完成（用于聚焦、启用状态栏、刷新标题）
    // on_message：页面 postMessage 的 JSON 文本，已按页面代次过滤
    WebHostView(HWND parent, std::function<void()> on_page_loaded,
                std::function<void(std::string_view)> on_message);
    ~WebHostView();

    void resize(int width, int height);
    void load_page(const std::string &base_dir);
    void evaluate_script(const std::string &script);
    // 正文注入：小文档单条脚本，大文档走消息通道，再大则分片拼接
    void inject_markdown(const std::string &text);
    void focus();

private:
    void initialize();
    void fail(const wchar_t *message);
    void on_controller_created(HRESULT result, ICoreWebView2Controller *controller);
    bool build_page(const std::string &base_dir, std::wstring *url);
    bool is_current_source(const std::wstring &source) const;

    HWND parent_ = nullptr;
    HMODULE loader_ = nullptr;
    Microsoft::WRL::ComPtr<ICoreWebView2Environment> environment_;
    Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
    Microsoft::WRL::ComPtr<ICoreWebView2> webview_;
    EventRegistrationToken navigation_token_{};
    EventRegistrationToken message_token_{};
    std::function<void()> page_loaded_;
    std::function<void(std::string_view)> message_;
    std::wstring page_file_;
    unsigned generation_ = 0;
    bool page_pending_ = false;
    std::string pending_dir_;
    // 异步回调可能在窗口关闭后才到；用弱标记避免访问已析构的 this
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};
