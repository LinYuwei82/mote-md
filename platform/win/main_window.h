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
    HACCEL accel_ = nullptr;
    HWND drop_hwnd_ = nullptr;
    void *drop_target_ = nullptr;
    std::string file_path_;
    std::string last_dir_;
    std::string last_text_;
    std::string pending_status_;
    bool save_as_requested_ = false;
    bool toc_on_ = false;
    bool source_on_ = false;
    bool follow_system_ = true;
    bool dark_mode_ = false;
    bool startup_command_done_ = false;
    bool diagnostics_started_ = false;
    double last_zoom_ = 1.0;
    AfterSave after_save_ = AfterSave::None;
    std::string after_save_path_;
};
