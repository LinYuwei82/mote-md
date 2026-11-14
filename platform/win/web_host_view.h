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
    // on_image_paste：Ctrl+V 时先问外壳剪贴板里有没有图片；返回 true 表示已处理，
    //                 Chromium 不再执行默认粘贴（避免它把 CF_DIB 转码时丢 alpha）
    WebHostView(HWND parent, std::function<void()> on_page_loaded,
                std::function<void(std::string_view)> on_message,
                std::function<bool()> on_image_paste = {});
    ~WebHostView();

    void resize(int width, int height);
    void load_page(const std::string &base_dir);
    void evaluate_script(const std::string &script);
    // 需要返回值的脚本（PDF 导出前量正文宽度），结果是页面的 JSON 文本
    void evaluate_script_result(const std::string &script,
                                std::function<void(bool, const std::string &)> callback);
    // A4 纵向打印，边距与 mac 一致；scale 由调用方按正文宽度算好
    void print_to_pdf(const std::string &path, double scale,
                      std::function<void(bool)> callback);
    // 诊断用（MOTE_SNAPSHOT）：直接把 WebView2 画面渲染成 PNG
    void capture_preview(const std::string &path, std::function<void(bool)> callback);
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
    EventRegistrationToken accelerator_token_{};
    std::function<void()> page_loaded_;
    std::function<void(std::string_view)> message_;
    std::function<bool()> image_paste_;
    std::wstring page_file_;
    unsigned generation_ = 0;
    bool page_pending_ = false;
    std::string pending_dir_;
    // 异步回调可能在窗口关闭后才到；用弱标记避免访问已析构的 this
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};
