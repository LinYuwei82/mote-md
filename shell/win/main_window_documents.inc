void MoteMainWindow::layout()
{
    if (!hwnd_ || !host_)
        return;
    RECT client = {};
    GetClientRect(hwnd_, &client);
    host_->resize(client.right - client.left, client.bottom - client.top);
}

void MoteMainWindow::load_builtin_sample()
{
    const std::string sample_path = exe_directory() + "\\samples\\welcome.md";
    std::string text;
    if (!read_text_file(sample_path, &text) || text.empty())
        text = "# 欢迎\n\n没有找到内置示例文档。\n";
    file_path_.clear();
    last_dir_.clear();
    last_text_ = text;
    controller_->setMarkdown(text, "");
    update_title();
}

std::wstring MoteMainWindow::display_name() const
{
    if (file_path_.empty())
        return L"未命名";
    return utf8_to_wide(file_name(file_path_));
}

void MoteMainWindow::update_title()
{
    const bool dirty = controller_ && controller_->dirty();
    std::wstring title = display_name() + (dirty ? L"*" : L"") + L" - Mote";
    if (hwnd_)
        SetWindowTextW(hwnd_, title.c_str());
}

void MoteMainWindow::open_requested()
{
    open_document();
}

void MoteMainWindow::open_document()
{
    if (!prepare_for_replace(AfterSave::OpenDialog, ""))
        return;
    const std::string dir = last_dir_.empty() ? documents_dir() : last_dir_;
    const std::string path = MoteOpenMarkdownDialog(hwnd_, dir);
    if (!path.empty())
        open_path(path);
}

bool MoteMainWindow::forward_path_to_existing(const std::string &path_utf8)
{
    HWND hwnd = FindWindowW(kWindowClass, nullptr);
    if (!hwnd)
        return false;
    const std::wstring handoff = forward_handoff_path();
    std::error_code ec;
    std::filesystem::create_directories(
        std::filesystem::path(handoff).parent_path(), ec);
    std::ofstream out(std::filesystem::path(handoff),
                      std::ios::binary | std::ios::trunc);
    if (!out)
        return false;
    out << path_utf8;
    out.close();
    if (!PostMessageW(hwnd, kForwardMessage, 0, 0)) {
        DeleteFileW(handoff.c_str());
        return false;
    }
    return true;
}

void MoteMainWindow::rebuild_recent_menu()
{
    if (!recent_menu_)
        return;
    while (GetMenuItemCount(recent_menu_) > 0)
        DeleteMenu(recent_menu_, 0, MF_BYPOSITION);
    const auto paths = recent_files().list();
    const size_t count = paths.size() < static_cast<size_t>(mote::win::kRecentMaxItems)
        ? paths.size()
        : static_cast<size_t>(mote::win::kRecentMaxItems);
    for (size_t i = 0; i < count; ++i) {
        std::wstring title = utf8_to_wide(file_name(paths[i]));
        title += L"\t";
        title += utf8_to_wide(parent_dir(paths[i]));
        std::error_code ec;
        const bool exists = std::filesystem::exists(
            std::filesystem::path(utf8_to_wide(paths[i])), ec);
        AppendMenuW(recent_menu_,
                    MF_STRING | (exists ? 0 : MF_GRAYED),
                    static_cast<UINT_PTR>(mote::win::kRecentCommandBase + i),
                    title.c_str());
    }
    if (count > 0)
        AppendMenuW(recent_menu_, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(recent_menu_, MF_STRING, mote::win::kRecentClearCommandId, L"清除记录");
}

void MoteMainWindow::set_pending_path(const std::string &path)
{
    pending_path_ = path;
}

void MoteMainWindow::open_path(const std::string &path)
{
    // 命令行参数、拖放路径等可能是相对路径；统一转绝对，确保 file_path_ / last_dir_ /
    // 页面加载（临时 HTML + base href）都基于真实磁盘位置。
    std::string resolved = path;
    try {
        std::filesystem::path p(utf8_to_wide(path));
        std::filesystem::path abs = std::filesystem::absolute(p);
        resolved = wide_to_utf8(abs.wstring());
    } catch (...) {
        // 路径非法：保留原值，让后续 read_text_file 按失败处理并弹提示
    }

    std::string text;
    if (!read_text_file(resolved, &text)) {
        MoteAlert(hwnd_, L"无法打开", "读取文件失败：\n" + path);
        return;
    }
    mote::perfMark("win:file_read_done");

    file_path_ = resolved;
    last_dir_ = parent_dir(resolved);
    last_text_ = text;
    // 记录原文件行尾风格，保存时原样写回（编辑器内部按 LF 工作）
    crlf_ = text.find("\r\n") != std::string::npos;
    controller_->setMarkdown(text, last_dir_);
    update_title();
    recent_files().add(resolved);
    log_line("NATIVE open " + path);
    status_message("已打开：" + path);
}

