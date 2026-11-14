#pragma once

#include <string>
#include <vector>

namespace mote {

enum class MenuId { File, Edit, Format, View };

enum class CommandId {
    Separator = 0,
    // 文件
    New,
    Open,
    Save,
    SaveAs,
    ExportHtml,
    ExportPdf,
    // 编辑
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    // 格式（与前端 formatAction 一一对应）
    FormatBold,
    FormatItalic,
    FormatInlineCode,
    FormatLink,
    FormatH1,
    FormatH2,
    FormatH3,
    FormatParagraph,
    FormatUl,
    FormatOl,
    FormatQuote,
    FormatCodeBlock,
    FormatTable,
    FormatHr,
    // 视图
    ToggleToc,
    ToggleSource,
    ToggleDark,
    FollowSystem,
    ZoomIn,
    ZoomOut,
    ZoomReset,
};

// 快捷键统一写成 "cmd+shift+z"：修饰键顺序固定 cmd/ctrl/option/shift，
// 键名用小写字母、数字或 equal/plus/minus/slash 这类单词（便于跨平台解析）。
struct CommandSpec {
    CommandId id;
    std::string title;
    std::vector<std::string> shortcuts; // 第一项是菜单显示用，其余是备用键（如 Cmd+/）
    std::string formatAction;           // 仅格式命令非空
    bool checkable = false;
    bool disabledInSource = false;
};

struct MenuSpec {
    MenuId id;
    std::string title;
    std::vector<CommandId> items; // 含 CommandId::Separator
};

// 菜单栏唯一来源：Qt 外壳与原生外壳都按这张表生成，保证两端顺序、标题、
// 快捷键一致。应用菜单（关于/隐藏/退出）与窗口菜单由系统约定，不在此表内。
const std::vector<MenuSpec> &menus();
const CommandSpec *findCommand(CommandId id);

} // namespace mote
