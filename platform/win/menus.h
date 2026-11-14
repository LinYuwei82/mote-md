#pragma once

#include <windows.h>

#include "core/command_table.h"

// Windows 菜单栏：内容与顺序完全来自 core/command_table，平台只负责
// 「命令表 → HMENU / HACCEL」和勾选/禁用状态。
namespace mote::win {

// 文件菜单末尾的「退出」不属于 core 命令表（macOS 由应用菜单承担）
constexpr UINT kExitCommandId = 40005;

HMENU build_main_menu();
HACCEL build_accelerators();

void set_command_checked(HMENU menu, CommandId id, bool checked);
void set_command_enabled(HMENU menu, CommandId id, bool enabled);

} // namespace mote::win
