void WebHostView::print_to_pdf(const std::string &path, double scale,
                               std::function<void(bool)> callback)
{
    if (!webview_ || path.empty()) {
        if (callback)
            callback(false);
        return;
    }
    Microsoft::WRL::ComPtr<ICoreWebView2_7> web7;
    if (FAILED(webview_.As(&web7)) || !web7) {
        if (callback)
            callback(false);
        return;
    }

    // A4 纵向；边距沿用 mac 的 51pt / 56.7pt（换算成英寸）
    Microsoft::WRL::ComPtr<ICoreWebView2Environment6> env6;
    Microsoft::WRL::ComPtr<ICoreWebView2PrintSettings> settings;
    if (SUCCEEDED(environment_.As(&env6))
        && SUCCEEDED(env6->CreatePrintSettings(&settings)) && settings) {
        settings->put_PageWidth(8.27);
        settings->put_PageHeight(11.69);
        settings->put_MarginLeft(51.0 / 72.0);
        settings->put_MarginRight(51.0 / 72.0);
        settings->put_MarginTop(56.7 / 72.0);
        settings->put_MarginBottom(56.7 / 72.0);
        settings->put_ShouldPrintBackgrounds(TRUE);
        settings->put_ShouldPrintHeaderAndFooter(FALSE);
        if (scale > 0.0)
            settings->put_ScaleFactor(scale);
    }

    auto alive = alive_;
    web7->PrintToPdf(
        utf8_to_wide(path).c_str(), settings.Get(),
        Microsoft::WRL::Callback<ICoreWebView2PrintToPdfCompletedHandler>(
            [alive, callback](HRESULT error, BOOL success) -> HRESULT {
                if (*alive && callback)
                    callback(SUCCEEDED(error) && success);
                return S_OK;
            })
            .Get());
}

