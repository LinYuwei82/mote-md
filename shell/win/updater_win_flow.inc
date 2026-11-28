HRESULT CALLBACK download_dialog_callback(HWND hwnd, UINT msg, WPARAM, LPARAM, LONG_PTR data)
{
    auto *state = reinterpret_cast<DownloadState *>(data);
    switch (msg) {
    case TDN_TIMER:
        if (state->finished.load()) {
            SendMessageW(hwnd, TDM_CLICK_BUTTON, IDOK, 0);
        } else {
            const long long written = state->written.load();
            const long long expected = state->expected_size.load();
            std::wstring text;
            if (expected > 0) {
                const int pct = static_cast<int>(written * 100 / expected);
                text = std::to_wstring(pct) + L"% — "
                    + (written > 0 ? human_size(written) : L"0 MB")
                    + L" / " + human_size(expected);
                SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_POS, pct, 0);
            } else {
                // 服务器没给 Content-Length，保持 MB 口径
                text = L"已下载 "
                    + (written > 0 ? human_size(written) : L"0 MB");
            }
            SendMessageW(hwnd, TDM_SET_ELEMENT_TEXT, TDE_CONTENT,
                         reinterpret_cast<LPARAM>(text.c_str()));
        }
        return S_OK;
    case TDN_BUTTON_CLICKED:
        if (!state->finished.load())
            state->cancel = true;
        return S_OK;
    }
    return S_OK;
}

// 阻塞展示下载对话框，工作线程由调用方负责 join
void run_download_dialog(HWND hwnd, DownloadState *state, std::thread *worker)
{
    TASKDIALOGCONFIG config = {};
    config.cbSize = sizeof(config);
    config.hwndParent = hwnd;
    config.dwFlags =
        TDF_ALLOW_DIALOG_CANCELLATION | TDF_CALLBACK_TIMER | TDF_POSITION_RELATIVE_TO_WINDOW
        | TDF_SHOW_PROGRESS_BAR;
    config.pszWindowTitle = L"Mote";
    config.pszMainIcon = TD_INFORMATION_ICON;
    config.pszMainInstruction = L"正在下载更新…";
    config.pszContent = L"正在连接更新服务器。";
    config.pfCallback = download_dialog_callback;
    config.lpCallbackData = reinterpret_cast<LONG_PTR>(state);
    TaskDialogIndirect(&config, nullptr, nullptr, nullptr);

    if (!state->finished.load())
        state->cancel = true;
    if (worker->joinable())
        worker->join();
}

// 用户确认后：下载 → 复验清单签名（纵深防御）→ 校验 SHA256 → 安装版静默升级 / 绿色版交给用户解压
void begin_download(HWND hwnd, const UpdateTarget &target, const std::string &manifestText)
{
    // 安装版会覆盖当前目录的可执行文件，绿色版要求用户解压覆盖也得先退出；
    // 两条路径都要先保存，否则 quit 流程可能因保存确认而被用户取消，更新包已下载却退出不了
    if (g_is_dirty && g_is_dirty()) {
        MoteAlert(hwnd, L"请先保存", "文档有未保存的修改，保存后再更新。");
        return;
    }
    if (target.url.empty()) {
        MoteAlert(hwnd, L"检查更新失败", "更新清单缺少当前安装形态对应的更新包。");
        return;
    }
    if (target.sha256.empty()) {
        MoteAlert(hwnd, L"无法校验更新包", "更新清单缺少 SHA256，已取消下载。");
        return;
    }

    wchar_t temp[MAX_PATH] = {};
    if (GetTempPathW(MAX_PATH, temp) == 0) {
        MoteAlert(hwnd, L"下载失败", "无法定位临时目录。");
        return;
    }
    std::error_code ec;
    const std::filesystem::path dir = std::filesystem::path(temp) / L"Mote-update";
    std::filesystem::create_directories(dir, ec);
    const std::filesystem::path dest = dir / url_file_name(utf8_to_wide(target.url));
    std::filesystem::remove(dest, ec);

    DownloadState state;
    state.expected_sha256 = target.sha256;
    state.manifest_text = manifestText;
    state.path = dest;
    DownloadState *raw = &state;

    if (log_enabled())
        update_log("download %s -> %s", target.url.c_str(),
                   wide_to_utf8(dest.wstring()).c_str());

    std::thread worker([url = utf8_to_wide(target.url), dest, raw] {
        constexpr int kMaxAttempts = 3;
        constexpr int kRetryIntervalMs = 2000;

        bool ok = false;
        for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
            bool retryable = false;
            if (log_enabled())
                update_log("download attempt %d/%d", attempt, kMaxAttempts);
            ok = download_file(url, dest, raw, &retryable);
            if (ok)
                break;
            // 用户点了取消：不再重试
            if (raw->cancel.load())
                break;
            // 不可重试（地址非法 / 磁盘权限 / 4xx）：直接放弃
            if (!retryable) {
                if (log_enabled())
                    update_log("download failed (non-retryable): %s",
                               wide_to_utf8(raw->error).c_str());
                break;
            }
            if (attempt < kMaxAttempts) {
                if (log_enabled())
                    update_log("download failed (retryable), sleep %d ms before retry",
                               kRetryIntervalMs);
                std::this_thread::sleep_for(
                    std::chrono::milliseconds(kRetryIntervalMs));
                // 重置进度条，让 UI 重新从 0 开始
                raw->written.store(0);
                raw->expected_size.store(0);
            }
        }

        if (ok) {
            // 判定链已在引擎里验过清单签名；这里对下载时使用的同一份
            // manifest_text 复验一次，属纵深防御（防判定后被内存篡改等极端情况）
            std::string verify_error;
            if (!verifyUpdateManifestSignature(raw->manifest_text, kUpdateManifestPublicKey,
                                               &verify_error)) {
                ok = false;
                raw->error = L"更新清单验签失败，已放弃更新。";
                if (log_enabled())
                    update_log("manifest verify failed: %s", verify_error.c_str());
            }
        }
        if (ok) {
            std::string actual;
            if (!sha256_file(dest, &actual)) {
                ok = false;
                raw->error = L"无法计算下载文件的哈希";
            } else if (!equals_ignore_case(actual, raw->expected_sha256)) {
                ok = false;
                raw->error = L"更新包校验失败（SHA256 不一致），已删除下载内容。";
            }
        }
        raw->ok = ok;
        raw->finished = true;
    });

    run_download_dialog(hwnd, raw, &worker);

    if (!raw->ok) {
        std::filesystem::remove(dest, ec);
        if (raw->cancel && raw->error.empty()) {
            if (log_enabled())
                update_log("download cancelled");
            return;
        }
        if (log_enabled())
            update_log("download failed: %s", wide_to_utf8(raw->error).c_str());
        MoteAlert(hwnd, L"更新失败",
                  raw->error.empty() ? "下载更新包失败。" : wide_to_utf8(raw->error));
        return;
    }

    if (log_enabled())
        update_log("download ok bytes=%lld", raw->written.load());

    if (target.installer) {
        // /RELAUNCH=1 由 mote.iss 的 [Run] 识别，安装完成后自动启动新版本
        const std::wstring params =
            L"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RELAUNCH=1";
        const HINSTANCE launched =
            ShellExecuteW(hwnd, L"open", dest.c_str(), params.c_str(), nullptr, SW_SHOWNORMAL);
        if (reinterpret_cast<INT_PTR>(launched) <= 32) {
            MoteAlert(hwnd, L"无法启动安装程序",
                      "更新包已下载，请手动运行：\n" + wide_to_utf8(dest.wstring()));
            return;
        }
        if (log_enabled())
            update_log("installer launched, quitting");
        if (g_quit)
            g_quit();
        return;
    }

    // 绿色版：Mote.exe 正在运行，覆盖前必须先退出，否则解压会被「文件被占用」挡住
    MoteAlert(hwnd, L"更新包已下载",
              "已通过清单签名与 SHA256 校验：\n" + wide_to_utf8(dest.wstring())
                  + "\n\n将打开所在文件夹并退出 Mote，解压覆盖后重新打开即可。");
    const std::wstring args = L"/select,\"" + dest.wstring() + L"\"";
    ShellExecuteW(hwnd, L"open", L"explorer.exe", args.c_str(), nullptr, SW_SHOWNORMAL);
    if (g_quit)
        g_quit();
}

