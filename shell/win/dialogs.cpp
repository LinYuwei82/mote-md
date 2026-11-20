#include "dialogs.h"

#include "env.h"
#include "win_encoding/encoding.h"

#include <commctrl.h>
#include <shobjidl.h>
#include <wrl/client.h>

#include <cstdlib>
#include <string>

namespace {

using win_encoding::utf8_to_wide;
using win_encoding::wide_to_utf8;

void set_folder(IFileDialog *dialog, const std::string &directory)
{
    if (!dialog || directory.empty())
        return;
    Microsoft::WRL::ComPtr<IShellItem> folder;
    const std::wstring wide = utf8_to_wide(directory);
    if (SUCCEEDED(SHCreateItemFromParsingName(wide.c_str(), nullptr, IID_PPV_ARGS(&folder)))
        && folder) {
        dialog->SetDefaultFolder(folder.Get());
        dialog->SetFolder(folder.Get());
    }
}

std::string item_path(IShellItem *item)
{
    if (!item)
        return std::string();
    PWSTR raw = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &raw)) || !raw)
        return std::string();
    // GetDisplayName 分配的内存由调用方用 CoTaskMemFree 释放，漏掉会每次打开/保存泄漏一块
    std::string path = wide_to_utf8(raw);
    CoTaskMemFree(raw);
    return path;
}

std::string ensure_extension(std::string path, const std::wstring &extension)
{
    if (path.empty() || extension.empty())
        return path;
    const size_t slash = path.find_last_of("\\/");
    const size_t dot = path.find_last_of('.');
    if (dot == std::string::npos || (slash != std::string::npos && dot < slash))
        path += "." + wide_to_utf8(extension);
    return path;
}

} // namespace

std::string MoteOpenMarkdownDialog(HWND owner, const std::string &initial_dir)
{
    Microsoft::WRL::ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&dialog)))
        || !dialog) {
        return std::string();
    }

    DWORD options = 0;
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST);
    dialog->SetTitle(L"打开 Markdown 文件");

    const COMDLG_FILTERSPEC types[] = {
        { L"Markdown", L"*.md;*.markdown;*.mdown;*.mkd;*.txt" },
        { L"所有文件", L"*.*" },
    };
    dialog->SetFileTypes(ARRAYSIZE(types), types);
    dialog->SetFileTypeIndex(1);
    set_folder(dialog.Get(), initial_dir);

    if (FAILED(dialog->Show(owner)))
        return std::string();

    Microsoft::WRL::ComPtr<IShellItem> item;
    if (FAILED(dialog->GetResult(&item)))
        return std::string();
    return item_path(item.Get());
}

std::string MoteSaveDialog(HWND owner, const std::wstring &title,
                           const std::string &suggested_path,
                           const std::wstring &extension)
{
    Microsoft::WRL::ComPtr<IFileSaveDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&dialog)))
        || !dialog) {
        return std::string();
    }

    DWORD options = 0;
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT);
    dialog->SetTitle(title.c_str());

    const std::wstring pattern = L"*." + extension;
    const COMDLG_FILTERSPEC types[] = {
        { L"文件", pattern.c_str() },
        { L"所有文件", L"*.*" },
    };
    dialog->SetFileTypes(ARRAYSIZE(types), types);
    dialog->SetFileTypeIndex(1);
    dialog->SetDefaultExtension(extension.c_str());

    if (!suggested_path.empty()) {
        const size_t slash = suggested_path.find_last_of("\\/");
        const std::string name =
            slash == std::string::npos ? suggested_path : suggested_path.substr(slash + 1);
        dialog->SetFileName(utf8_to_wide(name).c_str());
        if (slash != std::string::npos)
            set_folder(dialog.Get(), suggested_path.substr(0, slash));
    }

    if (FAILED(dialog->Show(owner)))
        return std::string();

    Microsoft::WRL::ComPtr<IShellItem> item;
    if (FAILED(dialog->GetResult(&item)))
        return std::string();
    return ensure_extension(item_path(item.Get()), extension);
}

MoteSaveChoice MoteConfirmUnsaved(HWND owner, const std::wstring &display_name)
{
    // 诊断用（MOTE_ANSWER=cancel|discard|save）：跳过弹窗直接给出答案
    const std::string forced = env_value("MOTE_ANSWER");
    if (!forced.empty()) {
        if (forced == "cancel")
            return MoteSaveChoice::Cancel;
        if (forced == "discard")
            return MoteSaveChoice::Discard;
        if (forced == "save")
            return MoteSaveChoice::Save;
    }

    const std::wstring content =
        L"“" + display_name + L"”有尚未保存的修改，是否保存？";
    TASKDIALOG_BUTTON buttons[] = {
        { 1000, L"保存" },
        { 1001, L"不保存" },
        { 1002, L"取消" },
    };
    TASKDIALOGCONFIG config = {};
    config.cbSize = sizeof(config);
    config.hwndParent = owner;
    config.dwCommonButtons = 0;
    config.pszWindowTitle = L"未保存的修改";
    config.pszMainInstruction = L"未保存的修改";
    config.pszContent = content.c_str();
    config.pButtons = buttons;
    config.cButtons = ARRAYSIZE(buttons);
    config.nDefaultButton = 1000;
    config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION;

    int pressed = 0;
    if (SUCCEEDED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr))) {
        if (pressed == 1000)
            return MoteSaveChoice::Save;
        if (pressed == 1001)
            return MoteSaveChoice::Discard;
        return MoteSaveChoice::Cancel;
    }

    // 没有视觉样式时退回系统确认框：是=保存，否=不保存
    const int answer = MessageBoxW(owner, content.c_str(), L"未保存的修改",
                                   MB_YESNOCANCEL | MB_ICONWARNING | MB_DEFBUTTON1);
    if (answer == IDYES)
        return MoteSaveChoice::Save;
    if (answer == IDNO)
        return MoteSaveChoice::Discard;
    return MoteSaveChoice::Cancel;
}

void MoteAlert(HWND owner, const std::wstring &title, const std::string &message)
{
    MessageBoxW(owner, utf8_to_wide(message).c_str(), title.c_str(),
                MB_OK | MB_ICONERROR);
}
