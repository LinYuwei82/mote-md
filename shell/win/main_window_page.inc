void MoteMainWindow::evaluate_script(const std::string &script)
{
    if (host_)
        host_->evaluate_script(script);
}

void MoteMainWindow::load_page(const std::string &base_dir)
{
    mote::perfMark("win:loadpage_call");
    if (host_)
        host_->load_page(base_dir);
}

void MoteMainWindow::navigation_completed()
{
    if (!controller_)
        return;
    host_->evaluate_script(mote::js::enableStatusBar("win"));
    host_->focus();
    ensure_drop_target();
    update_title();
    log_line("NATIVE navigation completed");
}

void MoteMainWindow::page_ready()
{
    mote::perfMark("win:page_ready_cb");
    log_line("NATIVE ready gen=" + std::to_string(controller_->pageGeneration()));
    if (!pending_status_.empty())
        show_status(pending_status_);
    update_title();
    update_menu_state();
    // 诊断钩子全部进程级只跑一次：多窗口下每个新窗口的 ready 不能再触发，
    // 否则 MOTE_COMMAND=newwindow 会连环开窗口
    static bool startup_command_done = false;
    static bool open2_done = false;
    static bool diagnostics_started = false;
    // MOTE_COMMAND 诊断钩子：页面就绪后再等 700ms，避开首帧布局
    if (!startup_command_done && !env_value("MOTE_COMMAND").empty())
        SetTimer(hwnd_, kStartupCommandTimer, 700, nullptr);

    // 与 mac 同名钩子：首屏就绪 600ms 后再打开第二个文件（测热打开）
    if (!open2_done && !env_value("MOTE_OPEN2").empty()) {
        open2_done = true;
        SetTimer(hwnd_, kOpen2Timer, 600, nullptr);
    }

    // 与 mac 同名的诊断钩子：MOTE_EVAL 打一条 JSLOG，MOTE_SNAPSHOT 出 PNG
    if (!diagnostics_started) {
        diagnostics_started = true;
        // 等导航完成后再取页面状态：ready 消息到达时 WebView2 仍在导航，
        // 此刻调用 ExecuteScript 会被静默丢弃（只剩 scheduled、没有结果）
        if (!env_value("MOTE_EVAL").empty()) {
            // MOTE_EVAL_DELAY 与 MOTE_SNAPSHOT_DELAY 同义：跨窗口回归需要
            // 把 eval 推到第二窗口就绪之后再跑
            const std::string raw = env_value("MOTE_EVAL_DELAY");
            const double delay = !raw.empty() ? std::atof(raw.c_str()) : 700.0;
            SetTimer(hwnd_, kEvalTimer, static_cast<UINT>(delay < 0 ? 0 : delay), nullptr);
            log_line("NATIVE eval scheduled");
        }
        const std::string snapshot = env_value("MOTE_SNAPSHOT");
        if (!snapshot.empty()) {
            const std::string raw = env_value("MOTE_SNAPSHOT_DELAY");
            const double delay = !raw.empty() ? std::atof(raw.c_str()) : 2000.0;
            SetTimer(hwnd_, kSnapshotTimer, static_cast<UINT>(delay < 0 ? 0 : delay), nullptr);
        }
        // 与 mac 同名同义：页面就绪 900ms 后把指定路径当成一次真实拖放。
        // mac 用 ':' 分隔；Windows 盘符本身带 ':'，这里改成分号。
        {
            const std::string paths = env_value("MOTE_DROP");
            if (!paths.empty()) {
                const std::string list = paths;
                size_t start = 0;
                while (start <= list.size()) {
                    const size_t end = list.find(';', start);
                    const std::string item = list.substr(
                        start, end == std::string::npos ? std::string::npos : end - start);
                    if (!item.empty())
                        drop_probe_paths_.push_back(item);
                    if (end == std::string::npos)
                        break;
                    start = end + 1;
                }
                if (!drop_probe_paths_.empty()) {
                    log_line("NATIVE drop probe scheduled paths="
                             + std::to_string(drop_probe_paths_.size()));
                    SetTimer(hwnd_, kDropProbeTimer, 900, nullptr);
                }
            }
        }
    }
}

void MoteMainWindow::dirty_changed()
{
    update_title();
}

void MoteMainWindow::status_message(const std::string &text)
{
    show_status(text);
}

void MoteMainWindow::error_message(const std::string &text)
{
    show_status("前端错误：" + text);
}

void MoteMainWindow::show_status(const std::string &text)
{
    if (text.empty())
        return;
    // 先拷一份：调用方可能直接传 pending_status_ 本身，下面 clear() 会让引用变空
    const std::string message = text;
    // 已送达就清掉缓存：否则每次页面重载后的 ready 都会重放上一条旧状态
    if (controller_ && controller_->pageReady()) {
        pending_status_.clear();
        host_->evaluate_script(mote::js::statusMessage(message));
        return;
    }
    pending_status_ = message;
}

