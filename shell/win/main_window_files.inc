void MoteMainWindow::new_document()
{
    if (!prepare_for_replace(AfterSave::NewDocument, ""))
        return;
    start_new_document();
}

void MoteMainWindow::start_new_document()
{
    file_path_.clear();
    last_text_.clear();
    crlf_ = false; // 新文档用 LF，和编辑器内部表示一致
    save_as_requested_ = false;
    controller_->newDocument();
    update_title();
    status_message("已新建空白文档（未命名，保存时会询问位置）");
}

void MoteMainWindow::save_requested_text(const std::string &text)
{
    save_text(text);
}

void MoteMainWindow::begin_save_as(bool save_as)
{
    save_as_requested_ = save_as;
    if (controller_)
        controller_->requestSnapshot();
}

void MoteMainWindow::save_text(const std::string &text)
{
    const bool wants_save_as = save_as_requested_;
    save_as_requested_ = false;

    std::string path = file_path_;
    if (path.empty() || wants_save_as) {
        const std::string dir = last_dir_.empty() ? documents_dir() : last_dir_;
        std::string suggested = path;
        if (suggested.empty())
            suggested = dir + "\\未命名.md";
        if (const std::string forced = env_value("MOTE_SAVE_AS"); !forced.empty())
            path = forced;
        else
            path = MoteSaveDialog(hwnd_, L"另存为", suggested, L"md");
        if (path.empty()) {
            reset_after_save();
            return;
        }
        path = with_extension(path, "md");
    }

    if (!write_text(text, path)) {
        reset_after_save();
        return;
    }

    file_path_ = path;
    last_dir_ = parent_dir(path);
    last_text_ = text;
    controller_->notifySaved(text);
    // 另存为可能换了目录：图片落盘位置跟随新的 .md 路径
    controller_->setBaseDir(last_dir_);
    update_title();
    recent_files().add(path);
    log_line("NATIVE save " + path);
    status_message("已保存：" + path);
    run_after_save();
}

bool MoteMainWindow::write_text(const std::string &text, const std::string &path)
{
    // 编辑器内部统一 LF；原文件是 CRLF 时还原，避免「打开再保存」把整篇行尾改掉
    std::string payload = text;
    if (crlf_) {
        payload.clear();
        payload.reserve(text.size() + text.size() / 16);
        for (const char c : text) {
            if (c == '\n')
                payload += "\r\n";
            else
                payload.push_back(c);
        }
    }
    if (write_text_file(path, payload))
        return true;
    MoteAlert(hwnd_, L"保存失败", "无法写入文件：\n" + path);
    return false;
}

void MoteMainWindow::prompt_export_pdf()
{
    if (!controller_ || file_path_.empty())
        return;
    std::string base = file_name(file_path_);
    const size_t dot = base.find_last_of('.');
    if (dot != std::string::npos)
        base = base.substr(0, dot);
    const std::string suggested = parent_dir(file_path_) + "\\" + base + ".pdf";

    if (!env_value("MOTE_PDF_PROMPT").empty()) {
        log_line("NATIVE pdf suggested=" + suggested);
        return;
    }
    std::string path;
    if (const std::string forced = env_value("MOTE_PDF_AS"); !forced.empty())
        path = forced;
    else
        path = MoteSaveDialog(hwnd_, L"导出 PDF", suggested, L"pdf");
    if (path.empty())
        return;
    path = with_extension(path, "pdf");

    status_message("正在导出 PDF…");
    controller_->requestExportPdf(path);
}

void MoteMainWindow::export_html_ready(const std::string &html)
{
    if (html.empty()) {
        status_message("导出失败：页面没有返回内容");
        return;
    }

    std::string suggested;
    if (file_path_.empty()) {
        const std::string dir = last_dir_.empty() ? documents_dir() : last_dir_;
        suggested = dir + "\\未命名.html";
    } else {
        std::string base = file_name(file_path_);
        const size_t dot = base.find_last_of('.');
        if (dot != std::string::npos)
            base = base.substr(0, dot);
        suggested = parent_dir(file_path_) + "\\" + base + ".html";
    }

    if (!env_value("MOTE_EXPORT_PROMPT").empty()) {
        log_line("NATIVE export suggested=" + suggested);
        return;
    }
    std::string path;
    if (const std::string forced = env_value("MOTE_EXPORT_AS"); !forced.empty())
        path = forced;
    else
        path = MoteSaveDialog(hwnd_, L"导出 HTML", suggested, L"html");
    if (path.empty())
        return;
    path = with_extension(path, "html");

    // 图片相对路径按 .md 所在目录解析；未命名文档退回上次目录
    const std::string base_dir = file_path_.empty()
        ? (last_dir_.empty() ? documents_dir() : last_dir_)
        : parent_dir(file_path_);
    int missing = 0;
    const std::string filled = MoteInlineLocalImages(html, base_dir, &missing);
    if (!write_text_file(path, filled)) {
        MoteAlert(hwnd_, L"导出失败", "无法写入文件：\n" + path);
        return;
    }
    log_line("NATIVE export path=" + path + " missing=" + std::to_string(missing));
    if (missing > 0)
        status_message("已导出到 " + path + "（" + std::to_string(missing) + " 张图片缺失）");
    else
        status_message("已导出到 " + path);
}

void MoteMainWindow::export_pdf_requested(const std::string &path)
{
    if (!host_ || path.empty())
        return;

    // 同名旧文件不能算本次成功：先删，成功与否由产物是否生成判定
    std::error_code error;
    std::filesystem::remove(std::filesystem::path(utf8_to_wide(path)), error);

    PdfHost pdf;
    pdf.evaluate = [this](const std::string &script,
                          std::function<void(bool, const std::string &)> callback) {
        host_->evaluate_script_result(script, std::move(callback));
    };
    pdf.print = [this](const std::string &target, double scale,
                       std::function<void(bool)> callback) {
        host_->print_to_pdf(target, scale, std::move(callback));
    };

    MoteExportPdf(pdf, path, [this, path](bool ok, const std::string &message) {
        if (!ok) {
            log_line("NATIVE pdf failed " + message);
            status_message(message);
            MoteAlert(hwnd_, L"导出失败", message);
            return;
        }
        std::error_code error;
        const auto size = std::filesystem::file_size(std::filesystem::path(utf8_to_wide(path)),
                                                     error);
        log_line("NATIVE pdf path=" + path + " size="
                 + std::to_string(error ? 0 : size));
        status_message("已导出到 " + path);
    });
}

bool MoteMainWindow::prepare_for_replace(AfterSave after, const std::string &path,
                                        const std::string &text)
{
    if (!controller_ || !controller_->dirty())
        return true;

    switch (MoteConfirmUnsaved(hwnd_, display_name())) {
    case MoteSaveChoice::Cancel:
        return false;
    case MoteSaveChoice::Discard:
        return true;
    case MoteSaveChoice::Save:
        after_save_ = after;
        after_save_path_ = path;
        after_save_text_ = text;
        controller_->requestSnapshot();
        return false;
    }
    return false;
}

void MoteMainWindow::run_after_save()
{
    const AfterSave after = after_save_;
    const std::string path = after_save_path_;
    const std::string text = after_save_text_;
    reset_after_save();

    switch (after) {
    case AfterSave::OpenDialog:
        open_document();
        break;
    case AfterSave::OpenPath:
        if (!path.empty())
            open_path(path);
        break;
    case AfterSave::NewDocument:
        start_new_document();
        break;
    case AfterSave::Close:
        DestroyWindow(hwnd_);
        break;
    case AfterSave::ExportPdf:
        prompt_export_pdf();
        break;
    case AfterSave::DropDocument:
        load_dropped_text(text);
        break;
    case AfterSave::None:
        break;
    }
}

void MoteMainWindow::reset_after_save()
{
    after_save_ = AfterSave::None;
    after_save_path_.clear();
    after_save_text_.clear();
}

bool MoteMainWindow::confirm_close()
{
    if (!controller_ || !controller_->dirty())
        return true;

    switch (MoteConfirmUnsaved(hwnd_, display_name())) {
    case MoteSaveChoice::Cancel:
        return false;
    case MoteSaveChoice::Discard:
        return true;
    case MoteSaveChoice::Save:
        after_save_ = AfterSave::Close;
        controller_->requestSnapshot();
        return false;
    }
    return false;
}

