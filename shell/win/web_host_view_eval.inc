bool WebHostView::is_current_source(const std::wstring &source) const
{
    const size_t hash = source.find_last_of(L'#');
    // 没有 fragment 时无法判断代次，直接放行；带 fragment 则必须匹配
    if (hash == std::wstring::npos)
        return true;
    return source.substr(hash + 1) == L"g" + std::to_wstring(generation_);
}

void WebHostView::evaluate_script(const std::string &script)
{
    if (!webview_ || script.empty())
        return;
    webview_->ExecuteScript(utf8_to_wide(script).c_str(), nullptr);
}

void WebHostView::evaluate_script_result(
    const std::string &script, std::function<void(bool, const std::string &)> callback)
{
    if (!webview_ || script.empty())
        return;
    auto alive = alive_;
    webview_->ExecuteScript(
        utf8_to_wide(script).c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [alive, callback](HRESULT error, LPCWSTR result) -> HRESULT {
                if (!*alive)
                    return S_OK;
                const std::string text = result ? wide_to_utf8(result) : std::string();
                if (callback)
                    callback(SUCCEEDED(error), text);
                return S_OK;
            })
            .Get());
}

void WebHostView::capture_preview(const std::string &path, std::function<void(bool)> callback)
{
    if (!webview_ || path.empty()) {
        if (callback)
            callback(false);
        return;
    }
    Microsoft::WRL::ComPtr<IStream> stream;
    const std::wstring wide = utf8_to_wide(path);
    if (FAILED(SHCreateStreamOnFileEx(wide.c_str(),
                                      STGM_CREATE | STGM_WRITE | STGM_SHARE_DENY_WRITE,
                                      FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream))) {
        if (callback)
            callback(false);
        return;
    }
    auto alive = alive_;
    webview_->CapturePreview(
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
        Microsoft::WRL::Callback<ICoreWebView2CapturePreviewCompletedHandler>(
            [alive, callback](HRESULT error) -> HRESULT {
                if (*alive && callback)
                    callback(SUCCEEDED(error));
                return S_OK;
            })
            .Get());
}

