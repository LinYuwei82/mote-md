#include "menus.h"

#include <string>
#include <utility>
#include <vector>

namespace mote::win {

namespace {

struct ParsedShortcut {
    BYTE modifiers = 0;
    UINT key = 0;
};

std::wstring utf8_to_wide(const std::string &text)
{
    if (text.empty())
        return std::wstring();
    const int length = MultiByteToWideChar(CP_UTF8, 0, text.data(),
                                           static_cast<int>(text.size()), nullptr, 0);
    std::wstring wide(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        wide.data(), length);
    return wide;
}

bool key_from_token(const std::string &token, UINT *key)
{
    if (token.size() == 1) {
        const char ch = token[0];
        if (ch >= 'a' && ch <= 'z') {
            *key = static_cast<UINT>(ch - 'a' + 'A');
            return true;
        }
        if (ch >= '0' && ch <= '9') {
            *key = static_cast<UINT>(ch);
            return true;
        }
        // 命令表里少数快捷键直接用单字符符号（如源码模式的 "cmd+/"），
        // 与上面的单词形式等价处理，避免解析失败后被静默跳过。
        if (ch == '/') {
            *key = VK_OEM_2;
            return true;
        }
        return false;
    }
    // 符号键用词名表达，避免 "+" 既当分隔符又当键名
    if (token == "equal") {
        *key = VK_OEM_PLUS;
        return true;
    }
    if (token == "plus") {
        *key = VK_ADD;
        return true;
    }
    if (token == "minus") {
        *key = VK_OEM_MINUS;
        return true;
    }
    if (token == "slash") {
        *key = VK_OEM_2;
        return true;
    }
    return false;
}

std::wstring key_display(const std::string &token)
{
    if (token == "equal")
        return L"=";
    if (token == "plus")
        return L"+";
    if (token == "minus")
        return L"-";
    if (token == "slash")
        return L"/";
    std::wstring wide = utf8_to_wide(token);
    for (wchar_t &ch : wide) {
        if (ch >= L'a' && ch <= L'z')
            ch = static_cast<wchar_t>(ch - L'a' + L'A');
    }
    return wide;
}

bool parse_shortcut(const std::string &text, ParsedShortcut *parsed)
{
    ParsedShortcut result;
    bool has_key = false;
    size_t start = 0;
    while (start <= text.size()) {
        const size_t plus = text.find('+', start);
        const std::string token = text.substr(
            start, plus == std::string::npos ? std::string::npos : plus - start);
        if (!token.empty()) {
            if (token == "cmd" || token == "ctrl" || token == "control") {
                // 命令表的 cmd 是「主修饰键」：macOS 是 Command，Windows 是 Ctrl
                result.modifiers |= FCONTROL;
            } else if (token == "option" || token == "alt") {
                result.modifiers |= FALT;
            } else if (token == "shift") {
                result.modifiers |= FSHIFT;
            } else if (key_from_token(token, &result.key)) {
                has_key = true;
            } else {
                return false;
            }
        }
        if (plus == std::string::npos)
            break;
        start = plus + 1;
    }
    if (!has_key)
        return false;
    *parsed = result;
    return true;
}

std::wstring shortcut_display(const std::string &text)
{
    std::wstring display;
    size_t start = 0;
    while (start <= text.size()) {
        const size_t plus = text.find('+', start);
        const std::string token = text.substr(
            start, plus == std::string::npos ? std::string::npos : plus - start);
        if (!token.empty()) {
            if (!display.empty())
                display += L"+";
            if (token == "cmd" || token == "ctrl" || token == "control")
                display += L"Ctrl";
            else if (token == "option" || token == "alt")
                display += L"Alt";
            else if (token == "shift")
                display += L"Shift";
            else
                display += key_display(token);
        }
        if (plus == std::string::npos)
            break;
        start = plus + 1;
    }
    return display;
}

std::wstring menu_title(MenuId id, const std::string &fallback)
{
    switch (id) {
    case MenuId::File: return L"文件(&F)";
    case MenuId::Edit: return L"编辑(&E)";
    case MenuId::Format: return L"格式(&O)";
    case MenuId::View: return L"视图(&V)";
    }
    return utf8_to_wide(fallback);
}

// 这些编辑命令交给 WebView2 自带的加速键处理：只有 Chromium 的默认行为
// 在源码模式（textarea）和所见即所得模式下都正确，宿主拦截反而会破坏
// 文本域里的选区与粘贴。
bool uses_webview_native_edit(CommandId id)
{
    return id == CommandId::Cut || id == CommandId::Copy || id == CommandId::Paste
        || id == CommandId::SelectAll;
}

} // namespace

HMENU build_main_menu()
{
    HMENU menubar = CreateMenu();
    if (!menubar)
        return nullptr;

    for (const MenuSpec &spec : menus()) {
        HMENU popup = CreatePopupMenu();
        if (!popup)
            continue;
        for (const CommandId id : spec.items) {
            if (id == CommandId::Separator) {
                AppendMenuW(popup, MF_SEPARATOR, 0, nullptr);
                continue;
            }
            const CommandSpec *command = findCommand(id);
            if (!command)
                continue;
            std::wstring text = utf8_to_wide(command->title);
            if (!command->shortcuts.empty())
                text += L"\t" + shortcut_display(command->shortcuts.front());
            const bool checkable = command->checkable;
            AppendMenuW(popup, MF_STRING | (checkable ? MF_UNCHECKED : 0),
                        static_cast<UINT_PTR>(id), text.c_str());
        }
        if (spec.id == MenuId::File) {
            AppendMenuW(popup, MF_SEPARATOR, 0, nullptr);
            AppendMenuW(popup, MF_STRING, kExitCommandId, L"退出(&X)\tAlt+F4");
        }
        AppendMenuW(menubar, MF_POPUP, reinterpret_cast<UINT_PTR>(popup),
                    menu_title(spec.id, spec.title).c_str());
    }
    return menubar;
}

HACCEL build_accelerators()
{
    std::vector<ACCEL> entries;
    std::vector<std::pair<BYTE, UINT>> seen;
    for (const MenuSpec &menu : menus()) {
        for (const CommandId id : menu.items) {
            const CommandSpec *command = findCommand(id);
            if (!command || uses_webview_native_edit(id))
                continue;
            for (const std::string &shortcut : command->shortcuts) {
                ParsedShortcut parsed;
                if (!parse_shortcut(shortcut, &parsed))
                    continue;
                bool duplicate = false;
                for (const auto &item : seen) {
                    if (item.first == parsed.modifiers && item.second == parsed.key) {
                        duplicate = true;
                        break;
                    }
                }
                if (duplicate)
                    continue;
                seen.emplace_back(parsed.modifiers, parsed.key);

                ACCEL accel = {};
                accel.fVirt = static_cast<BYTE>(FVIRTKEY | parsed.modifiers);
                accel.key = static_cast<WORD>(parsed.key);
                accel.cmd = static_cast<WORD>(id);
                entries.push_back(accel);
            }
        }
    }
    if (entries.empty())
        return nullptr;
    return CreateAcceleratorTableW(entries.data(), static_cast<int>(entries.size()));
}

void set_command_checked(HMENU menu, CommandId id, bool checked)
{
    if (!menu)
        return;
    CheckMenuItem(menu, static_cast<UINT>(id),
                  MF_BYCOMMAND | (checked ? MF_CHECKED : MF_UNCHECKED));
}

void set_command_enabled(HMENU menu, CommandId id, bool enabled)
{
    if (!menu)
        return;
    EnableMenuItem(menu, static_cast<UINT>(id),
                   MF_BYCOMMAND | (enabled ? MF_ENABLED : MF_GRAYED));
}

} // namespace mote::win
