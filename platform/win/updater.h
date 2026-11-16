#pragma once

#include <windows.h>

#include <functional>

// Windows 在线更新，口径对齐 macOS：OSS 放清单 + 自研检查 + 自研下载校验 + 静默安装。
//   core/update   解析清单、比较版本、给出决策（两端共用）
//   本文件        取清单（WinHTTP）、下载并校验 SHA256、交给安装包静默升级
//
// 清单不复用 macOS 的 latest.json：那份指向 .dmg，Windows 读同目录的
// windows.json（指向绿色包 zip），避免把 .dmg 当成 Windows 安装包。
namespace mote::win {

// 更新检查用的定时器 id（WM_TIMER）与后台结果消息（WM_APP + 8）
constexpr UINT_PTR kUpdateTimer = 4;
constexpr UINT kUpdateResultMessage = WM_APP + 8;

// 主窗口注入的两个回调：更新前判断文档是否有未保存修改，
// 以及安装程序拉起后如何退出应用（走正常关闭流程，不绕过 dirty 检查）。
void set_update_hooks(std::function<bool()> is_dirty, std::function<void()> quit);

// 窗口创建后调用一次：10 秒后首次后台检查，之后每 24 小时一次
void start_update_checker(HWND hwnd);

// WM_TIMER(kUpdateTimer) 的处理：重置间隔并按上次检查时间节流
void run_update_timer(HWND hwnd);

// 菜单「检查更新…」：立即检查，无论结果都给出提示
void check_for_updates_now(HWND hwnd);

// 后台检查结果回到窗口线程后由这里消费；总是返回 true（消息属于更新模块）
bool handle_update_message(HWND hwnd, LPARAM lparam);

} // namespace mote::win
