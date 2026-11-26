#pragma once

#include <windows.h>

#include <functional>

// Windows 在线更新适配器。分层（与 macOS 共用同一份状态机）：
//   modules/update 检测层   清单解析、Ed25519 验签、版本比较（两端共用）
//   modules/update 编排层   mote::UpdateEngine：时机、节流、并发防重、
//                           验签→解析→判定统一顺序、跳过规则、提示文案
//   本文件       平台层   WinHTTP 取清单/下载、注册表持久化、TaskDialog
//                           渲染、SHA256 校验、静默安装 / 绿色包指引
//
// 壳内不得复制任何判定或文案逻辑——历史上两端各写一份状态机曾产生
// 「win 判定前不验签」等双胞胎偏差，全部收口进引擎。
namespace mote::win {

// 更新检查用的定时器 id（WM_TIMER）与后台结果消息（WM_APP + 8）
constexpr UINT_PTR kUpdateTimer = 4;
constexpr UINT kUpdateResultMessage = WM_APP + 8;

// 主窗口注入的两个回调：更新前判断文档是否有未保存修改，
// 以及安装程序拉起后如何退出应用（走正常关闭流程，不绕过 dirty 检查）。
void set_update_hooks(std::function<bool()> is_dirty, std::function<void()> quit);

// 窗口创建后调用一次：10 秒后首次后台检查，之后每 24 小时一次
void start_update_checker(HWND hwnd);

// WM_TIMER(kUpdateTimer) 的处理：重置为 24 小时周期，把 tick 交给引擎（节流在引擎内）
void run_update_timer(HWND hwnd);

// 菜单「检查更新…」：引擎立即检查，无论结果都给出提示
void check_for_updates_now(HWND hwnd);

// WM_APP 的 fetch 结果消息：交回引擎 onManifest；true 表示消息属于更新模块
bool handle_update_message(HWND hwnd, LPARAM lparam);

} // namespace mote::win
