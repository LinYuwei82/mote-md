void WebHostView::resize(int width, int height)
{
    if (!controller_)
        return;
    RECT bounds = { 0, 0, width, height };
    controller_->put_Bounds(bounds);
}

void WebHostView::focus()
{
    if (controller_)
        controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}

void WebHostView::fail(const wchar_t *message)
{
    log_line((std::wstring(L"FAIL ") + message).c_str());
    // 打点/自动化模式不弹阻塞对话框（无头会话里会卡死整个进程）
    if (!mote::perfEnabled())
        MessageBoxW(parent_, message, L"Mote", MB_OK | MB_ICONERROR);
}
