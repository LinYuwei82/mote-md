void MoteMainWindow::file_drop_requested(const std::string &path)
{
    if (path.empty())
        return;
    // 拖放等同双击：新窗口打开，不替换当前文档
    open_requested_path(path);
}

bool MoteMainWindow::clipboard_image(std::vector<std::uint8_t> *bytes, std::string *mime)
{
    if (!OpenClipboard(hwnd_))
        return false;

    bool found = false;
    // 浏览器/截图工具常直接给 PNG；没有时再解 CF_DIB
    const UINT png_format = RegisterClipboardFormatW(L"PNG");
    if (png_format != 0) {
        if (HANDLE data = GetClipboardData(png_format)) {
            if (auto *locked = static_cast<const std::uint8_t *>(GlobalLock(data))) {
                const size_t size = GlobalSize(data);
                if (size > 0) {
                    bytes->assign(locked, locked + size);
                    *mime = "image/png";
                    found = true;
                }
                GlobalUnlock(data);
            }
        }
    }

    if (!found) {
        if (HANDLE data = GetClipboardData(CF_DIB)) {
            if (auto *locked = static_cast<const std::uint8_t *>(GlobalLock(data))) {
                const size_t size = GlobalSize(data);
                std::vector<std::uint8_t> dib(locked, locked + size);
                GlobalUnlock(data);
                std::vector<std::uint8_t> png;
                if (encode_dib_to_png(dib, &png)) {
                    *bytes = std::move(png);
                    *mime = "image/png";
                    found = true;
                }
            }
        }
    }

    CloseClipboard();
    return found;
}

bool MoteMainWindow::paste_clipboard_image()
{
    if (!controller_ || source_on_)
        return false;
    if (!clipboard_has_image())
        return false;
    controller_->clipboardCommand("paste");
    return true;
}

bool MoteMainWindow::handle_accelerator(UINT key, WORD modifiers)
{
    mote::CommandId command = mote::CommandId::New;
    const bool matched = mote::win::command_for_shortcut(modifiers, key, &command);
    if (!env_value("MOTE_KEYLOG").empty())
        log_line("NATIVE key vk=" + std::to_string(key)
                 + " mods=" + std::to_string(modifiers)
                 + (matched ? " cmd=" + std::to_string(static_cast<int>(command)) : ""));
    // Ctrl+V 先问剪贴板是不是图片：Chromium 转码会丢 alpha，外壳自己走图片管线
    if (key == 'V' && modifiers == FCONTROL)
        return paste_clipboard_image();
    if (!matched)
        return false;
    // 编辑类命令（撤销/剪切/复制/粘贴）留给 WebView2 原生处理
    perform_command(command);
    return true;
}

void MoteMainWindow::ensure_drop_target()
{
    if (!hwnd_ || !controller_)
        return;

    HWND wanted = mote::win::find_drop_window(hwnd_);
    if (!wanted)
        wanted = hwnd_;
    if (drop_target_ && drop_hwnd_ == wanted && IsWindow(drop_hwnd_))
        return;
    revoke_drop_target();

    mote::win::DropCallbacks callbacks;
    callbacks.can_accept = [this](const std::vector<std::string> &paths) {
        return controller_ && controller_->acceptsNativeFileDrop(paths);
    };
    callbacks.perform = [this](const std::vector<std::string> &paths) {
        if (controller_)
            controller_->handleNativeFileDrop(paths);
    };

    std::string error;
    HWND target_hwnd = wanted;
    void *target = mote::win::register_drop_target(wanted, callbacks, &error);
    if (!target && wanted != hwnd_) {
        // 子窗口注册失败（例如属于其他进程且拒绝）：退回主窗口
        target_hwnd = hwnd_;
        target = mote::win::register_drop_target(hwnd_, callbacks, &error);
    }
    drop_target_ = target;
    drop_hwnd_ = target ? target_hwnd : nullptr;
    if (!target) {
        log_line("NATIVE drop target unavailable: " + error);
    } else {
        wchar_t name[64] = {};
        GetClassNameW(drop_hwnd_, name, 64);
        log_line("NATIVE drop target on " + wide_to_utf8(name) + " "
                 + std::to_string(reinterpret_cast<size_t>(drop_hwnd_)));
    }
}

void MoteMainWindow::revoke_drop_target()
{
    if (drop_target_) {
        mote::win::revoke_drop_target(drop_hwnd_, drop_target_);
        drop_target_ = nullptr;
    }
    drop_hwnd_ = nullptr;
}

void MoteMainWindow::drop_received(const std::string &name, const std::string &text)
{
    (void)name;
    // 拖入等同「打开另一份文档」：有未保存修改时先问，不能在用户不知情时覆盖。
    if (!prepare_for_replace(AfterSave::DropDocument, "", text))
        return;
    load_dropped_text(text);
}

void MoteMainWindow::load_dropped_text(const std::string &text)
{
    // WebView 不暴露拖入文件的真实路径，只能作为「未命名」文档载入
    file_path_.clear();
    last_dir_.clear();
    last_text_ = text;
    controller_->setMarkdown(text, "");
    update_title();
    status_message("已载入拖入的文档（未关联磁盘路径，保存时会询问位置）");
}

void MoteMainWindow::set_clipboard(const std::string &text, const std::string &html)
{
    if (!OpenClipboard(hwnd_))
        return;
    EmptyClipboard();

    const std::wstring wide = utf8_to_wide(text);
    std::string utf16(reinterpret_cast<const char *>(wide.data()), wide.size() * 2);
    utf16.append(2, '\0'); // CF_UNICODETEXT 需要双字节结尾
    put_clipboard_bytes(CF_UNICODETEXT, utf16);

    if (!html.empty()) {
        static const char kPrefix[] = "<!--StartFragment-->";
        static const char kSuffix[] = "<!--EndFragment-->";
        const std::string body = std::string(kPrefix) + html + kSuffix;
        char probe[256] = {};
        const int header_length = std::snprintf(
            probe, sizeof(probe),
            "Version:0.9\r\nStartHTML:%010u\r\nEndHTML:%010u\r\n"
            "StartFragment:%010u\r\nEndFragment:%010u\r\n",
            0u, 0u, 0u, 0u);
        char header[256] = {};
        std::snprintf(header, sizeof(header),
                      "Version:0.9\r\nStartHTML:%010u\r\nEndHTML:%010u\r\n"
                      "StartFragment:%010u\r\nEndFragment:%010u\r\n",
                      static_cast<unsigned>(header_length),
                      static_cast<unsigned>(header_length + body.size()),
                      static_cast<unsigned>(header_length + sizeof(kPrefix) - 1),
                      static_cast<unsigned>(header_length + sizeof(kPrefix) - 1
                                            + html.size()));
        put_clipboard_bytes(RegisterClipboardFormatW(L"HTML Format"),
                            std::string(header) + body);
    }
    CloseClipboard();
}

std::string MoteMainWindow::clipboard_text()
{
    // 资源管理器复制的文件列表不是可粘贴正文
    if (IsClipboardFormatAvailable(CF_HDROP))
        return std::string();
    if (!OpenClipboard(hwnd_))
        return std::string();
    std::string result;
    if (HANDLE data = GetClipboardData(CF_UNICODETEXT)) {
        if (auto *wide = static_cast<const wchar_t *>(GlobalLock(data))) {
            result = wide_to_utf8(wide);
            GlobalUnlock(data);
        }
    }
    CloseClipboard();
    return result;
}

void MoteMainWindow::open_external(const std::string &raw_url)
{
    // 链接文本直接来自文档，可以是任意内容。规则与 macOS 端一致：
    //   http/https/mailto            → 交给系统默认程序
    //   file: / 无 scheme 的相对路径  → 本地文件；.md 在应用内打开，其余交系统
    //   其它 scheme（javascript:/ms-*/vbscript: 等）→ 一律拒绝
    std::string url = raw_url;
    // 去掉首尾空白与控制字符，否则 " javascript:..." 这类可以绕过 scheme 判断
    while (!url.empty() && static_cast<unsigned char>(url.front()) <= 0x20)
        url.erase(url.begin());
    while (!url.empty() && static_cast<unsigned char>(url.back()) <= 0x20)
        url.pop_back();
    if (url.empty())
        return;
    // 文档内锚点由页面自己滚动，不走外壳
    if (url.front() == '#')
        return;

    std::string scheme;
    const size_t colon = url.find(':');
    // 冒号前出现 / ? # 说明不是 scheme（如 "./a.md"），按相对路径处理
    if (colon != std::string::npos && url.find_first_of("/?#") >= colon) {
        scheme = url.substr(0, colon);
        for (char &c : scheme) {
            if (c >= 'A' && c <= 'Z') {
                c = static_cast<char>(c - 'A' + 'a');
            } else if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                         || c == '+' || c == '-' || c == '.')) {
                // 非法 scheme 字符：不当作外链，落到本地路径分支由存在性检查兜底
                scheme.clear();
                break;
            }
        }
    }

    if (scheme == "http" || scheme == "https" || scheme == "mailto") {
        ShellExecuteW(hwnd_, L"open", utf8_to_wide(url).c_str(), nullptr, nullptr,
                      SW_SHOWNORMAL);
        return;
    }

    // 盘符（C:/x.md、C:\x.md）不是 scheme：单字母当本地绝对路径，交给下面的路径分支
    if (scheme.size() == 1 && scheme[0] >= 'a' && scheme[0] <= 'z')
        scheme.clear();

    std::string local;
    if (scheme == "file") {
        std::string rest = url.substr(5);
        if (rest.rfind("///", 0) == 0)
            rest.erase(0, 3);            // file:///C:/x → C:/x
        else if (rest.rfind("//", 0) == 0)
            rest = "\\\\" + rest.substr(2); // UNC：//server/share → \\server\share
        local = url_to_local_path(rest);
    } else if (scheme.empty()) {
        // 去掉 ?query / #fragment 后再当文件路径用
        std::string bare = url;
        const size_t cut = bare.find_first_of("?#");
        if (cut != std::string::npos)
            bare.erase(cut);
        if (bare.empty())
            return;
        bare = url_to_local_path(bare);
        // 根路径（\server\share）与盘符路径（C:\docs\x.md）都不拼 last_dir_
        const bool rooted = (!bare.empty() && bare.front() == '\\')
            || (bare.size() >= 2 && bare[1] == ':');
        local = (rooted || last_dir_.empty()) ? bare : last_dir_ + "\\" + bare;
    } else {
        status_message("不支持打开的链接类型：" + raw_url);
        return;
    }

    // 路径是 UTF-8，必须经 utf8_to_wide 构造 path，否则中文名按 ANSI 解释
    const std::filesystem::path target(utf8_to_wide(local));
    std::error_code error;
    if (local.empty() || !std::filesystem::exists(target, error)) {
        MoteAlert(hwnd_, L"链接目标不存在", "找不到链接指向的文件：\n" + raw_url);
        return;
    }
    if (mote::isMarkdownPath(local)) {
        if (prepare_for_replace(AfterSave::OpenPath, local))
            open_path(local);
        return;
    }
    ShellExecuteW(hwnd_, L"open", utf8_to_wide(local).c_str(), nullptr, nullptr,
                  SW_SHOWNORMAL);
}
