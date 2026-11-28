void set_update_hooks(std::function<bool()> is_dirty, std::function<void()> quit)
{
    g_is_dirty = std::move(is_dirty);
    g_quit = std::move(quit);
}

void start_update_checker(HWND hwnd)
{
    SetTimer(hwnd, kUpdateTimer, kStartupDelayMs, nullptr);
}

void run_update_timer(HWND hwnd)
{
    // 首次由 10 秒定时器触发，之后固定 24 小时；节流口径在引擎里（两端同源）
    KillTimer(hwnd, kUpdateTimer);
    SetTimer(hwnd, kUpdateTimer, 24 * 60 * 60 * 1000, nullptr);
    engine_bundle(hwnd).engine->tick(std::time(nullptr));
}

void check_for_updates_now(HWND hwnd)
{
    engine_bundle(hwnd).engine->checkNow(std::time(nullptr));
}

bool handle_update_message(HWND, LPARAM lparam)
{
    std::unique_ptr<FetchContext> ctx(reinterpret_cast<FetchContext *>(lparam));
    if (!ctx)
        return false;
    // 回调内部即 engine->onManifest，已在 UI 线程
    if (ctx->done)
        ctx->done(ctx->status, ctx->body, ctx->error);
    return true;
}
