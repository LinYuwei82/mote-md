#pragma once

#include <windows.h>

#include "core/command_table.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

class ShellHost;
class WebHostView;

namespace mote {
class EditorController;
struct ViewState;
}

// Windows 原生主窗口（阶段 B N1）：窗口、文档状态、打开/保存/未保存确认。
// 页面协议与状态机在 core/EditorController，平台能力由 ShellHost 转发到这里。
class MoteMainWindow
{
public:
    explicit MoteMainWindow(HINSTANCE instance);
    ~MoteMainWindow();

    bool create();
    void show(int show_command);
    int run_message_loop();
    void open_path(const std::string &path);

    // ShellHost → 外壳
    void evaluate_script(const std::string &script);
    void load_page(const std::string &base_dir);
    void set_clipboard(const std::string &text, const std::string &html);
    std::string clipboard_text();
    void open_external(const std::string &url);
    void save_requested_text(const std::string &text);
    void open_requested();
    void drop_received(const std::string &name, const std::string &text);
    void inject_document(const std::string &text);
    void file_drop_requested(const std::string &path);
    bool clipboard_image(std::vector<std::uint8_t> *bytes, std::string *mime);
    // Ctrl+V 钩子：剪贴板里是图片时由外壳粘贴（保留 alpha），否则交回 Chromium
    bool paste_clipboard_image();
    // 编辑区组合键：先给图片粘贴，再按命令表分发；返回 true 表示已处理
    bool handle_accelerator(UINT key, WORD modifiers);
    void navigation_completed();
    void page_ready();
    void dirty_changed();
    void status_message(const std::string &text);
    void error_message(const std::string &text);
    // 导出（N4）
    void export_html_ready(const std::string &html);
    void export_pdf_requested(const std::string &path);

private:
    friend class ShellHost;

    enum class AfterSave { None, OpenDialog, OpenPath, NewDocument, Close, ExportPdf };

    static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
    // 低级键盘钩子：WebView2/Chromium 会先吃掉部分组合键（Ctrl+Shift+S、
    // Ctrl+Alt+E），AcceleratorKeyPressed 收不到，只能在本进程内提前截获
    static LRESULT CALLBACK keyboard_hook(int code, WPARAM wparam, LPARAM lparam);
    static MoteMainWindow *hook_owner_;
    LRESULT handle_message(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
    void layout();
    void update_title();
    std::wstring display_name() const;
    void load_builtin_sample();
    void new_document();
    void start_new_document();
    void open_document();
    void begin_save_as(bool save_as);
    void save_text(const std::string &text);
    bool write_text(const std::string &text, const std::string &path);
    bool prepare_for_replace(AfterSave after, const std::string &path);
    void run_after_save();
    void reset_after_save();
    bool confirm_close();
    void show_status(const std::string &text);
    void prompt_export_pdf();

    void perform_command(mote::CommandId command);
    void apply_view_state(const mote::ViewState &state);
    void apply_theme();
    bool system_is_dark() const;
    void update_menu_state();
    void run_startup_command();
    void ensure_drop_target();
    void revoke_drop_target();

    HINSTANCE instance_ = nullptr;
    HWND hwnd_ = nullptr;
    std::unique_ptr<WebHostView> host_;
    std::unique_ptr<ShellHost> shell_;
    std::unique_ptr<mote::EditorController> controller_;
    HHOOK keyboard_hook_ = nullptr;
    UINT last_shortcut_key_ = 0;
    // 钩子里自己维护修饰键状态：真实键盘下 GetAsyncKeyState 可能与回调时序不同步
    bool hook_ctrl_ = false;
    bool hook_shift_ = false;
    bool hook_alt_ = false;
    HACCEL accel_ = nullptr;
    HWND drop_hwnd_ = nullptr;
    void *drop_target_ = nullptr;
    std::string file_path_;
    std::string last_dir_;
    std::string last_text_;
    std::string pending_status_;
    bool save_as_requested_ = false;
    // 当前文档原始换行风格：编辑器内部统一 LF，写回时按此还原 CRLF，
    // 否则打开一个 CRLF 文件再保存会把整篇改成 LF（Git 里表现为全文件 diff）
    bool crlf_ = false;
    bool toc_on_ = false;
    bool source_on_ = false;
    bool follow_system_ = true;
    bool dark_mode_ = false;
    bool startup_command_done_ = false;
    bool diagnostics_started_ = false;
    bool drop_probe_done_ = false;
    std::vector<std::string> drop_probe_paths_;
    double last_zoom_ = 1.0;
    AfterSave after_save_ = AfterSave::None;
    std::string after_save_path_;
};
