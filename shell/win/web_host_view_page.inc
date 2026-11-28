void WebHostView::load_page(const std::string &base_dir)
{
    if (!webview_) {
        // 控制器还没建好：记住目录，建好后补一次导航
        page_pending_ = true;
        pending_dir_ = base_dir;
        return;
    }

    ++generation_;
    std::wstring url;
    if (!build_page(base_dir, &url)) {
        fail(L"无法准备编辑器页面。\n\n请确认发布包内的 web 目录完整。");
        return;
    }
    log_line(L"navigate editor page");
    webview_->Navigate(url.c_str());
    mote::perfMark("win:navigate");
}

bool WebHostView::build_page(const std::string &base_dir, std::wstring *url)
{
    const std::wstring web_dir = exe_directory() + L"\\web";
    std::string page = read_file(web_dir + L"\\editor.html");
    const std::string css = read_file(web_dir + L"\\editor.css");
    const std::string js = read_file(web_dir + L"\\editor.js");
    if (page.empty() || css.empty() || js.empty())
        return false;

    // mermaid.min.js（3.3MB）不再内联进页面：每次换页都重新解析它是启动与
    // 打开文件慢的主要原因。这里只留懒加载声明，库文件在下方拷到页面同目录，
    // 前端文档里出现 mermaid 块时才动态加载；缺文件时 mermaid 块保持源码显示。
    std::error_code mec;
    const std::wstring mermaid_src = web_dir + L"\\mermaid.min.js";
    const auto mermaid_size = std::filesystem::file_size(mermaid_src, mec);
    std::string mermaid_stub;
    if (!mec && mermaid_size > 0)
        mermaid_stub = "window.MOTE_MERMAID_SRC=\".mote-mermaid-"
            + std::to_string(GetCurrentProcessId()) + ".js\";";

    std::string style = wide_to_utf8(font_face_css());
    style += css;
    replace_all(page, "__MOTE_CSS__", style);
    replace_all(page, "__MOTE_MERMAID__", mermaid_stub);
    const std::string flag = inline_proto_enabled()
        ? "window.MOTE_INLINE_PROTO=true;"
        : "window.MOTE_INLINE_PROTO=false;";
    const std::string perf_flag = mote::perfEnabled() ? "window.MOTE_PERF=true;" : "";
    replace_all(page, "__MOTE_JS__", flag + perf_flag + js);

    if (!base_dir.empty()) {
        const std::string base = html_escape(directory_url(base_dir));
        const size_t head = page.find("</head>");
        if (!base.empty() && head != std::string::npos) {
            page.insert(head, "<base href=\"" + base + "\">");
        }
    }

    // 页目录选择与 core 的免重载判定同口径：文档目录在 %USERPROFILE% 内
    // （或未命名）→ 页面固定写 %TEMP%\MoteNative，换目录无需重载；
    // 越界目录 → 页面写进该目录（沿用旧的读权限形态），由 core 触发重载。
    std::wstring directory;
    const auto under_profile = [](const std::wstring &dir) {
        wchar_t buf[MAX_PATH] = {};
        const DWORD n = GetEnvironmentVariableW(L"USERPROFILE", buf, MAX_PATH);
        if (n == 0 || n >= MAX_PATH)
            return false;
        std::wstring root = buf;
        while (!root.empty() && root.back() == L'\\')
            root.pop_back();
        if (dir.size() < root.size() || dir.compare(0, root.size(), root) != 0)
            return false;
        return dir.size() == root.size() || dir[root.size()] == L'\\';
    };
    const std::wstring base_w = utf8_to_wide(base_dir);
    if (base_dir.empty() || under_profile(base_w)) {
        wchar_t temp[MAX_PATH] = {};
        GetTempPathW(MAX_PATH, temp);
        directory = temp;
        if (!directory.empty() && directory.back() == L'\\')
            directory.pop_back();
        directory += L"\\MoteNative";
        std::error_code ec;
        std::filesystem::create_directories(directory, ec);
    } else {
        directory = base_w;
    }

    const std::wstring name = L"\\.mote-preview-"
        + std::to_wstring(GetCurrentProcessId()) + L".html";
    const std::wstring page_path = directory + name;

    // mermaid 库与临时页面同目录（WebView2 可读取），按需加载
    const std::wstring mermaid_path = directory + L"\\.mote-mermaid-"
        + std::to_wstring(GetCurrentProcessId()) + L".js";
    if (!mec && mermaid_size > 0) {
        std::error_code pec;
        const auto have = std::filesystem::file_size(mermaid_path, pec);
        if (pec || have != mermaid_size)
            std::filesystem::copy_file(mermaid_src, mermaid_path,
                std::filesystem::copy_options::overwrite_existing, pec);
    }
    if (!mermaid_file_.empty() && mermaid_file_ != mermaid_path)
        DeleteFileW(mermaid_file_.c_str());
    mermaid_file_ = (!mec && mermaid_size > 0) ? mermaid_path : std::wstring();

    if (!write_file(page_path, page))
        return false;
    mote::perfMark("win:page_written");

    if (!page_file_.empty() && page_file_ != page_path)
        DeleteFileW(page_file_.c_str());
    page_file_ = page_path;

    wchar_t raw_url[2048] = {};
    DWORD length = 2048;
    if (FAILED(UrlCreateFromPathW(page_path.c_str(), raw_url, &length, 0)))
        return false;

    std::wstring target(raw_url);
    target += L"#g";
    target += std::to_wstring(generation_);
    *url = target;
    return true;
}

