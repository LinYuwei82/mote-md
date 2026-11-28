LRESULT MoteMainWindow::handle_message(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    LRESULT result = 0;
    switch (message) {
    case WM_CREATE:
        return handle_create(hwnd);
    case kForwardMessage:
        return handle_forward();
    case WM_INITMENUPOPUP:
        if (recent_menu_ && (HMENU)wparam == recent_menu_)
            rebuild_recent_menu();
        return 0;
    case WM_COMMAND:
        return handle_command(hwnd, wparam);
    case kShortcutMessage:
        perform_command(static_cast<mote::CommandId>(wparam));
        return 0;
    case mote::win::kUpdateResultMessage:
        mote::win::handle_update_message(hwnd, lparam);
        return 0;
    case WM_TIMER:
        if (handle_timer(hwnd, wparam, &result))
            return result;
        break;
    case WM_SETTINGCHANGE:
        if (handle_setting_change(wparam, lparam, &result))
            return result;
        break;
    case mote::win::kDropMessage:
        return handle_native_drop(lparam);
    case WM_SIZE:
        layout();
        return 0;
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
        if (handle_key_down(wparam, &result))
            return result;
        break;
    case WM_CLOSE:
        if (confirm_close())
            DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        return handle_destroy(hwnd);
    case WM_GETMINMAXINFO:
        return handle_get_min_max_info(hwnd, lparam);
    case WM_DPICHANGED:
        return handle_dpi_changed(hwnd, lparam);
    default:
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    // WM_TIMER / WM_SETTINGCHANGE / WM_KEYDOWN 未命中的分支落到这里，与 default 一样交默认窗口过程
    return DefWindowProcW(hwnd, message, wparam, lparam);
}
