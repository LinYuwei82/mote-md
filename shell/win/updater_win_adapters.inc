// ---- 四个平台适配器 ----

// fetch 结果经 WM_APP 消息回到 UI 线程后再调回调（引擎要求主线程投递）
struct FetchContext {
    int status = 0;
    std::string body;
    std::string error;
    ManifestFetcher::Callback done;
};

class WinFetcher : public ManifestFetcher {
public:
    explicit WinFetcher(HWND hwnd) : hwnd_(hwnd) {}

    void asyncGet(const std::string &url, Callback done) override
    {
        const HWND hwnd = hwnd_;
        const std::wstring wide = utf8_to_wide(url);
        std::thread([hwnd, wide, done = std::move(done)]() mutable {
            auto ctx = std::make_unique<FetchContext>();
            ctx->done = std::move(done);
            std::wstring net_error;
            if (fetch_url(wide, &ctx->body, &net_error)) {
                ctx->status = 200;
            } else {
                ctx->status = 0;
                ctx->error = wide_to_utf8(net_error);
            }
            FetchContext *raw = ctx.release();
            if (!PostMessageW(hwnd, kUpdateResultMessage, 0,
                              reinterpret_cast<LPARAM>(raw)))
                delete raw;
        }).detach();
    }

private:
    HWND hwnd_;
};

class WinStore : public SettingsStore {
public:
    std::string getString(const std::string &key) override
    {
        const std::wstring stored = reg_read_string(RegName(key));
        if (!stored.empty())
            return wide_to_utf8(stored);
        // 旧版 LastUpdateCheck 是 DWORD：读不到字符串时按 DWORD 兼容一次
        if (key == update_keys::kLastCheckAt) {
            DWORD legacy = 0;
            if (reg_read_dword(kRegLastCheck, &legacy) && legacy > 0)
                return std::to_string(static_cast<unsigned long long>(legacy));
        }
        return std::string();
    }
    void setString(const std::string &key, const std::string &value) override
    {
        reg_write_string(RegName(key), utf8_to_wide(value));
    }
    void clearString(const std::string &key) override { reg_delete_value(RegName(key)); }

    // 32 位十六进制随机串（系统 CSPRNG，无需 COM 初始化）；失败返回空串，
    // 引擎会跳过灰度，不阻断更新主流程。
    std::string newInstallId() override
    {
        unsigned char bytes[16] = {};
        if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
            return std::string();
        return to_hex(std::vector<UCHAR>(bytes, bytes + sizeof(bytes)));
    }

private:
    static const wchar_t *RegName(const std::string &key)
    {
        if (key == update_keys::kLastCheckAt)
            return kRegLastCheck;
        if (key == update_keys::kSkippedVersion)
            return kRegSkipped;
        return kRegInstallId;
    }
};

// 「发现新版本」弹窗里的超链接：TDF_ENABLE_HYPERLINKS 只负责渲染，
// 点击后必须自己处理 TDN_HYPERLINK_CLICKED，否则点了没有任何反应
HRESULT CALLBACK prompt_dialog_callback(HWND hwnd, UINT message, WPARAM, LPARAM lparam, LONG_PTR)
{
    if (message == TDN_HYPERLINK_CLICKED && lparam) {
        const wchar_t *link = reinterpret_cast<const wchar_t *>(lparam);
        ShellExecuteW(hwnd, L"open", link, nullptr, nullptr, SW_SHOWNORMAL);
    }
    return S_OK;
}

class WinUi : public UpdateUi {
public:
    explicit WinUi(HWND hwnd) : hwnd_(hwnd) {}

    void showAlert(const std::string &title, const std::string &body) override
    {
        MoteAlert(hwnd_, utf8_to_wide(title), body);
    }

    Choice showPrompt(const PromptSpec &spec) override
    {
        std::wstring content = utf8_to_wide(spec.body);
        const std::wstring plain_content = content;
        bool has_notes = false;
        if (!spec.notes_url.empty()) {
            content += L"\n\n<a href=\"" + utf8_to_wide(spec.notes_url)
                + L"\">查看完整更新说明…</a>";
            has_notes = true;
        }
        const std::wstring title = utf8_to_wide(spec.title);

        TASKDIALOGCONFIG config = {};
        config.cbSize = sizeof(config);
        config.hwndParent = hwnd_;
        // 强制生效后不给关闭按钮：用户只能立即更新
        config.dwFlags = TDF_POSITION_RELATIVE_TO_WINDOW
            | (has_notes ? TDF_ENABLE_HYPERLINKS : 0)
            | (spec.allow_later ? TDF_ALLOW_DIALOG_CANCELLATION : 0);
        config.pszWindowTitle = L"Mote";
        config.pszMainIcon = TD_INFORMATION_ICON;
        config.pszMainInstruction = title.c_str();
        config.pszContent = content.c_str();
        config.pfCallback = prompt_dialog_callback;
        const TASKDIALOG_BUTTON mandatory_buttons[] = {
            {1001, L"立即更新"},
        };
        const TASKDIALOG_BUTTON buttons[] = {
            {1001, L"下载更新"},
            {1002, L"稍后"},
        };
        config.pButtons = spec.allow_later ? buttons : mandatory_buttons;
        config.cButtons = spec.allow_later ? ARRAYSIZE(buttons) : ARRAYSIZE(mandatory_buttons);

        int pressed = 0;
        if (FAILED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr))) {
            // 退回 MessageBox 时不能带 <a> 标记，否则会原样显示成尖括号文本
            std::wstring plain = plain_content;
            if (!spec.notes_url.empty())
                plain += L"\n\n更新说明：" + utf8_to_wide(spec.notes_url);
            if (!spec.allow_later)
                return MessageBoxW(hwnd_, plain.c_str(), title.c_str(),
                                   MB_OK | MB_ICONWARNING) == IDOK
                    ? Choice::Install
                    : Choice::Later;
            return MessageBoxW(hwnd_, plain.c_str(), title.c_str(),
                               MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON1)
                    == IDYES
                ? Choice::Install
                : Choice::Later;
        }
        return pressed == 1001 ? Choice::Install : Choice::Later;
    }

private:
    HWND hwnd_;
};

class WinInstaller : public PlatformInstaller {
public:
    explicit WinInstaller(HWND hwnd) : hwnd_(hwnd) {}

    bool preflight(std::string *, std::string *) override { return true; }

    long long preferredArtifactSize(const UpdateManifest &manifest) override
    {
        return pick_target(manifest).size;
    }

    void install(const UpdateManifest &manifest, const std::string &manifest_text) override
    {
        const UpdateTarget target = pick_target(manifest);
        if (log_enabled())
            update_log("target=%s installed=%d", target.url.c_str(),
                       target.installer ? 1 : 0);
        begin_download(hwnd_, target, manifest_text);
    }

private:
    HWND hwnd_;
};

// 进程级引擎（生命周期覆盖在途 fetch）
struct EngineBundle {
    std::unique_ptr<WinFetcher> fetcher;
    std::unique_ptr<WinStore> store;
    std::unique_ptr<WinUi> ui;
    std::unique_ptr<WinInstaller> installer;
    std::unique_ptr<UpdateEngine> engine;
};

EngineBundle &engine_bundle(HWND hwnd)
{
    static EngineBundle bundle;
    if (!bundle.engine) {
        bundle.fetcher = std::make_unique<WinFetcher>(hwnd);
        bundle.store = std::make_unique<WinStore>();
        bundle.ui = std::make_unique<WinUi>(hwnd);
        bundle.installer = std::make_unique<WinInstaller>(hwnd);

        UpdateEngineConfig config;
        config.platform = UpdatePlatform::Windows;
        const std::string override_url = env_value("MOTE_UPDATE_URL");
        config.manifest_url = override_url.empty() ? wide_to_utf8(kDefaultManifestUrl)
                                                   : override_url;
        config.current_version = MOTE_VERSION;
        config.current_os = current_os_version();
        config.os_label = "Windows";
        config.current_build = MOTE_BUILD;
        config.install_note = running_installed_copy()
            ? "当前是安装版：将下载安装包、验签并校验 SHA256 后静默安装并重启。"
            : "当前是绿色版：将下载并校验更新包，随后打开所在文件夹，解压覆盖即可。";
        bundle.engine = std::make_unique<UpdateEngine>(
            std::move(config), *bundle.fetcher, *bundle.store, *bundle.ui, *bundle.installer,
            engine_logger);
    }
    return bundle;
}

