#pragma once

#include <windows.h>

// 自定义「关于 Mote」对话框：图标、版本(构建号)、版权、官网链接、检查更新。
// 应用级模态（owner 禁用），重复调用只前置同一个对话框。
void show_about_dialog(HWND owner);
