#pragma once

#include <windows.h>

#include "core/command_table.h"

// Windows 菜单栏：内容与顺序完全来自 core/command_table，平台只负责
// 「命令表 → HMENU / HACCEL」和勾选/禁用状态。
namespace mote::win {

// 文件菜单末尾的「退出」不属于 core 命令表（macOS 由应用菜单承担）
constexpr UINT kExitCommandId = 40005;
// 「检查更新…」同样只在平台层：macOS 放在应用菜单，Windows 放在文件菜单
constexpr UINT kCheckUpdateCommandId = 40006;
// 「关于 Mote…」：自定义关于对话框入口（about_dialog.cpp）
constexpr UINT kAboutCommandId = 40007;
// 「打开最近…」子菜单：条目在 WM_INITMENUPOPUP 时按 id 区间重建，
// kRecentCommandBase + i 对应列表第 i 项，末尾固定「清除记录」
constexpr UINT kRecentCommandBase = 40100;
constexpr UINT kRecentMaxItems = 10;
constexpr UINT kRecentClearCommandId = 40110;

// recent_submenu 非空时输出「打开最近…」子菜单句柄，供窗口按句柄识别
// WM_INITMENUPOPUP 并重建条目。
HMENU build_main_menu(HMENU *recent_submenu = nullptr);
HACCEL build_accelerators();

// WebView2 在消息循环之前截获键盘，TranslateAccelerator 收不到编辑区的按键；
// 外壳在 AcceleratorKeyPressed 里用它把「修饰键 + 虚拟键」映射回命令表。
// 与加速键表同源同义：跳过交给 WebView2 原生编辑的命令，重复项取先出现的。
bool command_for_shortcut(WORD modifiers, UINT key, CommandId *id);

void set_command_checked(HMENU menu, CommandId id, bool checked);
void set_command_enabled(HMENU menu, CommandId id, bool enabled);

} // namespace mote::win
