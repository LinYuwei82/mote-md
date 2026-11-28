void MoteMainWindow::perform_command(mote::CommandId command)
{
    const mote::CommandSpec *spec = mote::findCommand(command);
    if (!env_value("MOTE_KEYLOG").empty() && spec)
        log_line("NATIVE command " + spec->title);

    switch (command) {
    case mote::CommandId::New:
        new_document();
        return;
    case mote::CommandId::NewWindow:
        create_new(g_instance, std::string(), SW_SHOWNORMAL);
        return;
    case mote::CommandId::Open:
        open_document();
        return;
    case mote::CommandId::Save:
        begin_save_as(false);
        return;
    case mote::CommandId::SaveAs:
        begin_save_as(true);
        return;
    case mote::CommandId::ExportHtml:
        controller_->requestExportHtml(wide_to_utf8(display_name()));
        return;
    case mote::CommandId::ExportPdf:
        if (source_on_) {
            status_message("源码模式下不能导出 PDF，先退出源码模式");
            return;
        }
        // 未命名文档没有目录：先另存为，保存完成后再回到导出
        if (file_path_.empty()) {
            after_save_ = AfterSave::ExportPdf;
            begin_save_as(true);
            return;
        }
        if (!prepare_for_replace(AfterSave::ExportPdf, ""))
            return;
        prompt_export_pdf();
        return;
    case mote::CommandId::Undo:
        controller_->undo();
        return;
    case mote::CommandId::Redo:
        controller_->redo();
        return;
    // 剪切/复制/粘贴：菜单点击走页面桥；快捷键本身交给 WebView2 原生处理
    case mote::CommandId::Cut:
        controller_->clipboardCommand("cut");
        return;
    case mote::CommandId::Copy:
        controller_->clipboardCommand("copy");
        return;
    case mote::CommandId::Paste:
        controller_->clipboardCommand("paste");
        return;
    case mote::CommandId::SelectAll:
        evaluate_script("document.execCommand('selectAll');");
        return;
    case mote::CommandId::ToggleToc:
        controller_->toggleToc();
        return;
    case mote::CommandId::ToggleSource:
        controller_->toggleSource();
        return;
    case mote::CommandId::ToggleDark:
        follow_system_ = false;
        dark_mode_ = !dark_mode_;
        apply_theme();
        return;
    case mote::CommandId::FollowSystem:
        follow_system_ = true;
        apply_theme();
        return;
    case mote::CommandId::ZoomIn:
        controller_->zoomBy(1);
        return;
    case mote::CommandId::ZoomOut:
        controller_->zoomBy(-1);
        return;
    case mote::CommandId::ZoomReset:
        controller_->resetZoom();
        return;
    default:
        break;
    }

    // 剩余的是格式命令：动作名由 core 命令表给出，前端统一解释
    if (spec && !spec->formatAction.empty())
        controller_->applyFormat(spec->formatAction);
}

void MoteMainWindow::apply_view_state(const mote::ViewState &state)
{
    toc_on_ = state.toc;
    source_on_ = state.source;
    update_menu_state();
    if (!env_value("MOTE_KEYLOG").empty())
        log_line("NATIVE view toc=" + std::to_string(state.toc ? 1 : 0)
                 + " source=" + std::to_string(state.source ? 1 : 0)
                 + " zoom=" + std::to_string(state.zoom));
    if (std::abs(state.zoom - last_zoom_) > 0.001) {
        last_zoom_ = state.zoom;
        status_message("缩放：" + std::to_string(
            static_cast<int>(std::lround(state.zoom * 100))) + "%");
    }
}

bool MoteMainWindow::system_is_dark() const
{
    // Windows 没有公开的系统外观 API：读「应用模式」注册表值，
    // 0 = 深色，1 = 浅色；读取失败时按浅色处理。
    HKEY key = nullptr;
    DWORD value = 1;
    DWORD size = sizeof(value);
    if (RegOpenKeyExW(HKEY_CURRENT_USER,
                      L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                      0, KEY_READ, &key) == ERROR_SUCCESS) {
        RegQueryValueExW(key, L"AppsUseLightTheme", nullptr, nullptr,
                         reinterpret_cast<LPBYTE>(&value), &size);
        RegCloseKey(key);
    }
    return value == 0;
}

void MoteMainWindow::apply_theme()
{
    if (follow_system_)
        dark_mode_ = system_is_dark();
    if (controller_)
        controller_->setTheme(dark_mode_ ? "dark" : "light");
    update_menu_state();
}

void MoteMainWindow::update_menu_state()
{
    if (!hwnd_)
        return;
    HMENU menu = GetMenu(hwnd_);
    if (!menu)
        return;
    mote::win::set_command_checked(menu, mote::CommandId::ToggleToc, toc_on_);
    mote::win::set_command_checked(menu, mote::CommandId::ToggleSource, source_on_);
    mote::win::set_command_checked(menu, mote::CommandId::ToggleDark, dark_mode_);
    mote::win::set_command_checked(menu, mote::CommandId::FollowSystem, follow_system_);
    // 源码模式（textarea）由 WebView2 原生处理编辑命令
    mote::win::set_command_enabled(menu, mote::CommandId::ExportPdf, !source_on_);
    mote::win::set_command_enabled(menu, mote::CommandId::Cut, !source_on_);
    mote::win::set_command_enabled(menu, mote::CommandId::Copy, !source_on_);
    mote::win::set_command_enabled(menu, mote::CommandId::Paste, !source_on_);
    DrawMenuBar(hwnd_);
}

void MoteMainWindow::run_startup_command()
{
    static bool done = false;
    if (done)
        return;
    const std::string raw = env_value("MOTE_COMMAND");
    if (raw.empty())
        return;
    done = true;

    std::string name;
    for (const char *item = raw.c_str(); *item; ++item) {
        const unsigned char ch = static_cast<unsigned char>(*item);
        if (!std::isspace(ch))
            name += static_cast<char>(std::tolower(ch));
    }

    const std::pair<const char *, mote::CommandId> table[] = {
        { "new", mote::CommandId::New },
        { "newwindow", mote::CommandId::NewWindow },
        { "open", mote::CommandId::Open },
        { "save", mote::CommandId::Save },
        { "saveas", mote::CommandId::SaveAs },
        { "exporthtml", mote::CommandId::ExportHtml },
        { "exportpdf", mote::CommandId::ExportPdf },
        { "toggletoc", mote::CommandId::ToggleToc },
        { "togglesource", mote::CommandId::ToggleSource },
        { "toggledark", mote::CommandId::ToggleDark },
        { "followsystem", mote::CommandId::FollowSystem },
        { "zoomin", mote::CommandId::ZoomIn },
        { "zoomout", mote::CommandId::ZoomOut },
        { "zoomreset", mote::CommandId::ZoomReset },
    };
    for (const auto &entry : table) {
        if (name == entry.first) {
            log_line("NATIVE startup command " + name);
            perform_command(entry.second);
            return;
        }
    }
}

void MoteMainWindow::inject_document(const std::string &text)
{
    if (host_)
        host_->inject_markdown(text);
}

