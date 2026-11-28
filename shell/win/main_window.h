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
    // 带待打开文件启动：WM_CREATE 里直接打开它，跳过内置示例页，
    // 避免「示例页解析完 → 立刻换目录重载」的两次全量页面加载。
    void set_pending_path(const std::string &path);
    void open_path(const std::string &path);
    // 多窗口工厂：堆上创建 + 注册；消息循环归 main.cpp，末窗销毁才退出。
    static MoteMainWindow *create_new(HINSTANCE instance, const std::string &pending_path,
                                      int show_command);
    // 外部打开统一口径：路径已开则激活既有窗口，否则新窗口打开
    static void open_requested_path(const std::string &path);
    // 单实例转发（步骤 6）：已有实例窗口存在时把双击的文件路径交给它并返回
    // true，新进程直接退出；没有已有实例或转发失败返回 false（照常启动）。
    static bool forward_path_to_existing(const std::string &path_utf8);

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

    enum class AfterSave { None, OpenDialog, OpenPath, NewDocument, Close, ExportPdf, DropDocument };

    static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
    // 低级键盘钩子（进程级装一次）：WebView2/Chromium 会先吃掉部分组合键
    // （Ctrl+Shift+S、Ctrl+Alt+E），AcceleratorKeyPressed 收不到，只能提前截获。
    // 回调按前台窗口路由到对应实例。
    static LRESULT CALLBACK keyboard_hook(int code, WPARAM wparam, LPARAM lparam);
    // 进程级键盘钩子：首窗装、末窗卸
    static void ensure_keyboard_hook();
    static void remove_keyboard_hook();
    // 当前活跃窗口（前台优先，退回注册表首项）
    static MoteMainWindow *active_window();
    LRESULT handle_message(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
    // handle_message 按消息域拆出的处理函数：直接返回 LRESULT 的表示该消息已处理完，
    // 返回 bool 的用 *result 写回结果、true 表示已处理，false 交回默认窗口过程。
    LRESULT handle_create(HWND hwnd);
    LRESULT handle_forward();
    LRESULT handle_command(HWND hwnd, WPARAM wparam);
    bool handle_timer(HWND hwnd, WPARAM wparam, LRESULT *result);
    bool handle_setting_change(WPARAM wparam, LPARAM lparam, LRESULT *result);
    LRESULT handle_native_drop(LPARAM lparam);
    bool handle_key_down(WPARAM wparam, LRESULT *result);
    LRESULT handle_destroy(HWND hwnd);
    LRESULT handle_get_min_max_info(HWND hwnd, LPARAM lparam);
    LRESULT handle_dpi_changed(HWND hwnd, LPARAM lparam);
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
    bool prepare_for_replace(AfterSave after, const std::string &path,
                             const std::string &text = "");
    void load_dropped_text(const std::string &text);
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
    void rebuild_recent_menu();
    void run_startup_command();
    void ensure_drop_target();
    void revoke_drop_target();

    HINSTANCE instance_ = nullptr;
    HWND hwnd_ = nullptr;
    std::string pending_path_;
    std::unique_ptr<WebHostView> host_;
    std::unique_ptr<ShellHost> shell_;
    std::unique_ptr<mote::EditorController> controller_;
    HMENU recent_menu_ = nullptr;
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
    std::vector<std::string> drop_probe_paths_;
    double last_zoom_ = 1.0;
    AfterSave after_save_ = AfterSave::None;
    std::string after_save_path_;
    std::string after_save_text_;
};
