#pragma once

#include <windows.h>

#include <string>

enum class MoteSaveChoice { Save, Discard, Cancel };

// Win32 对话框层（阶段 B N1）：文件选择、未保存确认与错误提示。
std::string MoteOpenMarkdownDialog(HWND owner, const std::string &initial_dir);
std::string MoteSaveDialog(HWND owner, const std::wstring &title,
                           const std::string &suggested_path,
                           const std::wstring &extension);
MoteSaveChoice MoteConfirmUnsaved(HWND owner, const std::wstring &display_name);
void MoteAlert(HWND owner, const std::wstring &title, const std::string &message);
