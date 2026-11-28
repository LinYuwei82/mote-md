WebHostView::WebHostView(HWND parent, std::function<void()> on_page_loaded,
                         std::function<void(std::string_view)> on_message,
                         std::function<bool(UINT, WORD)> on_accelerator)
    : parent_(parent)
    , page_loaded_(std::move(on_page_loaded))
    , message_(std::move(on_message))
    , accelerator_(std::move(on_accelerator))
{
    initialize();
}

WebHostView::~WebHostView()
{
    *alive_ = false;
    if (controller_) {
        if (accelerator_token_.value)
            controller_->remove_AcceleratorKeyPressed(accelerator_token_);
        controller_->Close();
        controller_.Reset();
    }
    webview_.Reset();
    environment_.Reset();
    if (loader_) {
        FreeLibrary(loader_);
        loader_ = nullptr;
    }
    // 临时页面写在文档目录，退出时尽量清理自己那份
    if (!page_file_.empty())
        DeleteFileW(page_file_.c_str());
    if (!mermaid_file_.empty())
        DeleteFileW(mermaid_file_.c_str());
}

