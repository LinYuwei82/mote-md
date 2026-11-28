void WebHostView::initialize()
{
    // 动态加载 Loader，不引入 WebView2Loader.lib；
    // 缺失时给出可操作的提示，而不是启动即崩。
    loader_ = LoadLibraryW(L"WebView2Loader.dll");
    if (!loader_) {
        log_line(L"load WebView2Loader.dll failed");
        fail(L"缺少 WebView2Loader.dll。\n\n请重新解压完整压缩包，或重新安装 Mote。");
        return;
    }
    log_line(L"WebView2Loader.dll loaded");

    auto get_version = reinterpret_cast<GetVersionFn>(
        GetProcAddress(loader_, "GetAvailableCoreWebView2BrowserVersionString"));
    auto create_environment = reinterpret_cast<CreateEnvironmentFn>(
        GetProcAddress(loader_, "CreateCoreWebView2EnvironmentWithOptions"));
    if (!get_version || !create_environment) {
        log_line(L"GetProcAddress failed");
        fail(L"WebView2Loader.dll 版本不匹配（缺少环境创建接口）。");
        return;
    }

    LPWSTR version = nullptr;
    const HRESULT version_result = get_version(nullptr, &version);
    if (FAILED(version_result) || !version) {
        log_line(L"GetAvailableCoreWebView2BrowserVersionString failed");
        fail(L"未检测到 Microsoft Edge WebView2 Runtime。\n\n"
             L"请安装运行时后重试：https://go.microsoft.com/fwlink/p/?LinkId=2124703");
        return;
    }
    log_line((std::wstring(L"WebView2 runtime: ") + version).c_str());
    CoTaskMemFree(version);

    const std::wstring data_directory = user_data_directory();
    log_line((std::wstring(L"data dir: ") + data_directory).c_str());
    const HRESULT created = create_environment(
        nullptr, data_directory.c_str(), nullptr,
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment *environment) -> HRESULT {
                log_line(L"env callback fired");
                mote::perfMark("win:webview_env");
                if (!*alive_)
                    return S_OK;
                if (FAILED(result) || !environment) {
                    log_line(L"env creation failed");
                    fail(L"WebView2 环境创建失败。");
                    return S_OK;
                }
                environment_ = environment;
                environment_->CreateCoreWebView2Controller(
                    parent_,
                    Microsoft::WRL::Callback<
                        ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [this](HRESULT controller_result,
                               ICoreWebView2Controller *controller) -> HRESULT {
                            log_line(L"controller callback fired");
                            mote::perfMark("win:webview_controller");
                            if (*alive_)
                                on_controller_created(controller_result, controller);
                            return S_OK;
                        })
                        .Get());
                return S_OK;
            })
            .Get());
    if (FAILED(created)) {
        log_line(L"CreateCoreWebView2EnvironmentWithOptions failed");
        fail(L"WebView2 环境创建失败。");
    }
}

void WebHostView::on_controller_created(HRESULT result, ICoreWebView2Controller *controller)
{
    if (FAILED(result) || !controller) {
        fail(L"WebView2 控制器创建失败。");
        return;
    }
    controller_ = controller;
    controller_->put_IsVisible(TRUE);

    // 关掉 WebView2 自带的 HTML5 外部拖放：开着时 Chromium 会占用子窗口的
    // IDropTarget，宿主注册的文件拖放收不到 Drop（拖进来毫无反应）。
    // 编辑器页面本身不需要 HTML5 拖放，文件拖放统一走 shell/win/drop_target。
    Microsoft::WRL::ComPtr<ICoreWebView2Controller4> controller4;
    if (SUCCEEDED(controller_.As(&controller4)) && controller4)
        controller4->put_AllowExternalDrop(FALSE);

    RECT bounds = {};
    GetClientRect(parent_, &bounds);
    controller_->put_Bounds(bounds);

    if (FAILED(controller_->get_CoreWebView2(webview_.GetAddressOf())) || !webview_) {
        fail(L"WebView2 初始化失败。");
        return;
    }

    // Chromium 自带的浏览器快捷键会先于 AcceleratorKeyPressed 吃掉部分组合键
    // （典型是 Ctrl+Shift+S），让外壳的菜单快捷键无法触发。页面自己处理了
    // Ctrl+S/O/Z/Y，查找条等也在页面里实现，关掉这批内部快捷键不会丢功能。
    // 必须在 get_CoreWebView2 之后设置：此前 webview_ 还是空的，条件会直接短路。
    Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
    Microsoft::WRL::ComPtr<ICoreWebView2Settings3> settings3;
    if (SUCCEEDED(webview_->get_Settings(&settings)) && settings
        && SUCCEEDED(settings.As(&settings3)) && settings3)
        settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);

    webview_->AddScriptToExecuteOnDocumentCreated(kBridgeScript, nullptr);

    // 页面消息：先比对 URL fragment 的页面代次，丢掉上一个页面迟到的消息
    webview_->add_WebMessageReceived(
        Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this](ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
                if (!*alive_ || !args || !message_)
                    return S_OK;
                LPWSTR source = nullptr;
                LPWSTR json = nullptr;
                args->get_Source(&source);
                args->get_WebMessageAsJson(&json);
                const bool current = source && is_current_source(source);
                if (current && json)
                    message_(wide_to_utf8(json));
                if (source)
                    CoTaskMemFree(source);
                if (json)
                    CoTaskMemFree(json);
                return S_OK;
            })
            .Get(),
        &message_token_);

    webview_->add_NavigationCompleted(
        Microsoft::WRL::Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [this](ICoreWebView2 *, ICoreWebView2NavigationCompletedEventArgs *args) -> HRESULT {
                if (!*alive_)
                    return S_OK;
                BOOL success = FALSE;
                if (args)
                    args->get_IsSuccess(&success);
                if (!success) {
                    fail(L"编辑器页面加载失败。");
                    return S_OK;
                }
                log_line(L"page loaded");
                mote::perfMark("win:nav_finish");
                if (page_loaded_)
                    page_loaded_();
                return S_OK;
            })
            .Get(),
        &navigation_token_);

    // WebView2 在消息循环之前截获键盘，TranslateAccelerator 只对原生菜单生效；
    // 编辑区里的组合键统一在这里交给外壳（Ctrl+V 的图片粘贴也走这条）。
    if (accelerator_) {
        controller_->add_AcceleratorKeyPressed(
            Microsoft::WRL::Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
                [this](ICoreWebView2Controller *,
                       ICoreWebView2AcceleratorKeyPressedEventArgs *args) -> HRESULT {
                    if (!*alive_ || !args || !accelerator_)
                        return S_OK;
                    COREWEBVIEW2_KEY_EVENT_KIND kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                    args->get_KeyEventKind(&kind);
                    if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                        && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)
                        return S_OK;
                    UINT key = 0;
                    args->get_VirtualKey(&key);
                    WORD modifiers = 0;
                    if (GetKeyState(VK_CONTROL) < 0)
                        modifiers |= FCONTROL;
                    if (GetKeyState(VK_SHIFT) < 0)
                        modifiers |= FSHIFT;
                    if (GetKeyState(VK_MENU) < 0)
                        modifiers |= FALT;
                    if (accelerator_(key, modifiers))
                        args->put_Handled(TRUE);
                    return S_OK;
                })
                .Get(),
            &accelerator_token_);
    }

    if (page_pending_) {
        page_pending_ = false;
        load_page(pending_dir_);
    }
}

