LRESULT MoteMainWindow::handle_create(HWND hwnd)
{
    host_ = std::make_unique<WebHostView>(
        hwnd, [this] { navigation_completed(); },
        [this](std::string_view json) {
            if (controller_)
                controller_->handleMessage(json);
        },
        [this](UINT key, WORD modifiers) {
            return handle_accelerator(key, modifiers);
        });
    shell_ = std::make_unique<ShellHost>(*this);
    controller_ = std::make_unique<mote::EditorController>(*shell_);
    // 换目录免重载：home 内文档的页面固定写在 %TEMP%\MoteNative（见
    // web_host_view.cpp），根内换目录只改 <base> 注入正文；越界目录
    // （其他盘符）退回「页面写进该目录 + 重载」兜底。
    {
        const std::string profile = env_value("USERPROFILE");
        if (!profile.empty())
            controller_->setReadAccessRoot(profile);
    }
    // 命令行带文件：直接打开它，跳过示例页（省一次全量页面加载）
    if (!pending_path_.empty()) {
        const std::string pending = pending_path_;
        pending_path_.clear();
        open_path(pending);
    } else {
        load_builtin_sample();
    }
    layout();

    SetMenu(hwnd, mote::win::build_main_menu(&recent_menu_));
    follow_system_ = true;
    apply_theme();
    // 更新模块不直接依赖 EditorController：脏标记与退出都由这里注入。
    // 多窗口下按「当前活跃窗口」动态取，避免指向已销毁实例。
    mote::win::set_update_hooks(
        [] {
            MoteMainWindow *window = active_window();
            return window && window->controller_ && window->controller_->dirty();
        },
        [] {
            MoteMainWindow *window = active_window();
            if (window)
                PostMessageW(window->hwnd_, WM_CLOSE, 0, 0);
        });
    mote::win::start_update_checker(hwnd);
    return 0;
}

LRESULT MoteMainWindow::handle_forward()
{
    // 单实例转发：另一个进程双击了 .md，按统一口径新窗口打开（已开则激活）
    const std::wstring handoff = forward_handoff_path();
    std::ifstream in(std::filesystem::path(handoff), std::ios::binary);
    std::string path;
    if (in)
        std::getline(in, path, '\0');
    DeleteFileW(handoff.c_str());
    if (!path.empty())
        open_requested_path(path);
    return 0;
}

LRESULT MoteMainWindow::handle_command(HWND hwnd, WPARAM wparam)
{
    const UINT id = LOWORD(wparam);
    if (id == mote::win::kExitCommandId) {
        SendMessageW(hwnd, WM_CLOSE, 0, 0);
        return 0;
    }
    if (id == mote::win::kCheckUpdateCommandId) {
        mote::win::check_for_updates_now(hwnd);
        return 0;
    }
    if (id == mote::win::kAboutCommandId) {
        show_about_dialog(hwnd);
        return 0;
    }
    if (id == mote::win::kRecentClearCommandId) {
        recent_files().clear();
        return 0;
    }
    if (id >= mote::win::kRecentCommandBase
        && id < mote::win::kRecentCommandBase + mote::win::kRecentMaxItems) {
        const auto paths = recent_files().list();
        const size_t index = id - mote::win::kRecentCommandBase;
        if (index < paths.size())
            open_requested_path(paths[index]);
        return 0;
    }
    // 菜单项 id 就是 CommandId；未知 id（控件通知等）直接忽略
    if (const mote::CommandSpec *spec =
            mote::findCommand(static_cast<mote::CommandId>(id)))
        perform_command(spec->id);
    return 0;
}

bool MoteMainWindow::handle_timer(HWND hwnd, WPARAM wparam, LRESULT *result)
{
    if (wparam == kStartupCommandTimer) {
        KillTimer(hwnd, kStartupCommandTimer);
        run_startup_command();
        *result = 0;
        return true;
    }
    if (wparam == kOpen2Timer) {
        KillTimer(hwnd, kOpen2Timer);
        const std::string p = env_value("MOTE_OPEN2");
        if (!p.empty()) {
            mote::perfReset();
            mote::perfMark("win:hot_open_start");
            open_path(p);
        }
        *result = 0;
        return true;
    }
    if (wparam == mote::win::kUpdateTimer) {
        mote::win::run_update_timer(hwnd);
        *result = 0;
        return true;
    }
    if (wparam == kEvalTimer) {
        KillTimer(hwnd, kEvalTimer);
        const std::string expression = env_value("MOTE_EVAL");
        if (!expression.empty() && host_) {
            const std::string probe =
                "(function(){try{var r=(" + expression
                + ");window.chrome.webview.postMessage({type:'log',message:'EVAL '+String(r)});}"
                  "catch(e){window.chrome.webview.postMessage({type:'log',message:'EVALERR '+e});}})();";
            host_->evaluate_script(probe);
            log_line("NATIVE eval dispatched");
        }
        *result = 0;
        return true;
    }
    if (wparam == kSnapshotTimer) {
        KillTimer(hwnd, kSnapshotTimer);
        const std::string snapshot = env_value("MOTE_SNAPSHOT");
        if (!snapshot.empty() && host_) {
            const std::string path = snapshot;
            host_->capture_preview(path, [this, path](bool ok) {
                log_line(std::string("SNAPSHOT ") + (ok ? "OK " : "ERR ") + path);
            });
        }
        *result = 0;
        return true;
    }
    if (wparam == kDropProbeTimer) {
        KillTimer(hwnd, kDropProbeTimer);
        log_line("NATIVE drop probe paths="
                 + std::to_string(drop_probe_paths_.size()));
        if (controller_ && !drop_probe_paths_.empty())
            controller_->handleNativeFileDrop(drop_probe_paths_);
        *result = 0;
        return true;
    }
    return false;
}

bool MoteMainWindow::handle_setting_change(WPARAM wparam, LPARAM lparam, LRESULT *result)
{
    if (wparam == WM_SETTINGCHANGE && lparam && follow_system_
        && std::wcscmp(reinterpret_cast<const wchar_t *>(lparam),
                       L"ImmersiveColorSet") == 0) {
        apply_theme();
        *result = 0;
        return true;
    }
    return false;
}

LRESULT MoteMainWindow::handle_native_drop(LPARAM lparam)
{
    std::unique_ptr<std::vector<std::string>> paths(
        reinterpret_cast<std::vector<std::string> *>(lparam));
    log_line("NATIVE drop paths=" + std::to_string(paths ? paths->size() : 0));
    if (paths && controller_)
        controller_->handleNativeFileDrop(*paths);
    return 0;
}

bool MoteMainWindow::handle_key_down(WPARAM wparam, LRESULT *result)
{
    // 焦点在窗口框架/菜单（还没进 WebView）时的兜底，和键盘钩子同一张命令表
    WORD modifiers = 0;
    if (GetKeyState(VK_CONTROL) < 0)
        modifiers |= FCONTROL;
    if (GetKeyState(VK_SHIFT) < 0)
        modifiers |= FSHIFT;
    if (GetKeyState(VK_MENU) < 0)
        modifiers |= FALT;
    mote::CommandId command = mote::CommandId::New;
    if (mote::win::command_for_shortcut(modifiers, static_cast<UINT>(wparam),
                                        &command)) {
        perform_command(command);
        *result = 0;
        return true;
    }
    return false;
}

LRESULT MoteMainWindow::handle_destroy(HWND hwnd)
{
    revoke_drop_target();
    KillTimer(hwnd, mote::win::kUpdateTimer);
    host_.reset();
    controller_.reset();
    shell_.reset();
    recent_menu_ = nullptr;
    hwnd_ = nullptr;
    // 多窗口：末窗销毁才退出进程；窗口对象在这里回收
    g_windows.erase(std::remove(g_windows.begin(), g_windows.end(), this),
                    g_windows.end());
    if (g_windows.empty()) {
        remove_keyboard_hook();
        PostQuitMessage(0);
    }
    delete this;
    return 0;
}

LRESULT MoteMainWindow::handle_get_min_max_info(HWND hwnd, LPARAM lparam)
{
    const UINT dpi = GetDpiForWindow(hwnd);
    auto *info = reinterpret_cast<MINMAXINFO *>(lparam);
    info->ptMinTrackSize.x = MulDiv(kMinWidth, dpi, 96);
    info->ptMinTrackSize.y = MulDiv(kMinHeight, dpi, 96);
    return 0;
}

LRESULT MoteMainWindow::handle_dpi_changed(HWND hwnd, LPARAM lparam)
{
    const RECT *suggested = reinterpret_cast<const RECT *>(lparam);
    SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                 suggested->right - suggested->left, suggested->bottom - suggested->top,
                 SWP_NOZORDER | SWP_NOACTIVATE);
    return 0;
}
