#pragma once

#include <windows.h>

#include <functional>
#include <string>
#include <vector>

namespace mote::win {

// 系统级拖放：只接受 CF_HDROP 里的文件路径，能否处理由 core 判定。
// 回调在消息循环的下一轮执行，避免在 OLE 拖放循环里弹对话框或写磁盘。
struct DropCallbacks {
    std::function<bool(const std::vector<std::string> &)> can_accept;
    std::function<void(const std::vector<std::string> &)> perform;
};

// 主窗口收到的拖放结果：lparam 是 new std::vector<std::string>，处理方负责 delete
constexpr UINT kDropMessage = WM_APP + 1;

HWND find_drop_window(HWND host);

// 成功返回 IDropTarget（已做多重继承指针调整），失败返回 nullptr 并写 error。
void *register_drop_target(HWND hwnd, DropCallbacks callbacks, std::string *error);
void revoke_drop_target(HWND hwnd, void *target);

} // namespace mote::win
