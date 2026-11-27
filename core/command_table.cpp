#include "core/command_table.h"

#include <algorithm>
#include <utility>

namespace mote {

namespace {

CommandSpec command(CommandId id, std::string title, std::vector<std::string> shortcuts = {},
                    std::string formatAction = {}, bool checkable = false,
                    bool disabledInSource = false)
{
    CommandSpec spec;
    spec.id = id;
    spec.title = std::move(title);
    spec.shortcuts = std::move(shortcuts);
    spec.formatAction = std::move(formatAction);
    spec.checkable = checkable;
    spec.disabledInSource = disabledInSource;
    return spec;
}

CommandSpec format(CommandId id, std::string title, std::string action,
                   std::vector<std::string> shortcuts = {})
{
    return command(id, std::move(title), std::move(shortcuts), std::move(action));
}

const std::vector<MenuSpec> &menuTable()
{
    static const std::vector<MenuSpec> table = [] {
        MenuSpec file;
        file.id = MenuId::File;
        file.title = "文件";
        file.items = {CommandId::New, CommandId::NewWindow, CommandId::Open,
                      CommandId::Separator, CommandId::Save,
                      CommandId::SaveAs, CommandId::ExportHtml, CommandId::ExportPdf};

        MenuSpec edit;
        edit.id = MenuId::Edit;
        edit.title = "编辑";
        edit.items = {CommandId::Undo, CommandId::Redo, CommandId::Separator, CommandId::Cut,
                      CommandId::Copy, CommandId::Paste, CommandId::SelectAll};

        MenuSpec formatMenu;
        formatMenu.id = MenuId::Format;
        formatMenu.title = "格式";
        formatMenu.items = {CommandId::FormatBold, CommandId::FormatItalic,
                            CommandId::FormatInlineCode, CommandId::FormatLink,
                            CommandId::Separator, CommandId::FormatH1, CommandId::FormatH2,
                            CommandId::FormatH3, CommandId::FormatParagraph,
                            CommandId::Separator, CommandId::FormatUl, CommandId::FormatOl,
                            CommandId::FormatQuote, CommandId::Separator,
                            CommandId::FormatCodeBlock, CommandId::FormatTable,
                            CommandId::FormatHr};

        MenuSpec view;
        view.id = MenuId::View;
        view.title = "视图";
        view.items = {CommandId::ToggleToc, CommandId::ToggleSource, CommandId::Separator,
                      CommandId::ToggleDark, CommandId::FollowSystem, CommandId::Separator,
                      CommandId::ZoomIn, CommandId::ZoomOut, CommandId::ZoomReset};

        return std::vector<MenuSpec>{file, edit, formatMenu, view};
    }();
    return table;
}

const std::vector<CommandSpec> &commandTable()
{
    static const std::vector<CommandSpec> table = {
        // 文件
        command(CommandId::New, "新建", {"cmd+n"}),
        command(CommandId::NewWindow, "新建窗口", {"cmd+shift+n"}),
        command(CommandId::Open, "打开", {"cmd+o"}),
        command(CommandId::Save, "保存", {"cmd+s"}),
        command(CommandId::SaveAs, "另存为", {"cmd+shift+s"}),
        // Cmd+E 是源码模式，且 macOS 菜单把 Shift 视为同一 key equivalent，
        // 所以导出 HTML 用 Option+Cmd+E
        command(CommandId::ExportHtml, "导出 HTML…", {"cmd+option+e"}),
        command(CommandId::ExportPdf, "导出 PDF…", {"cmd+p"}, {}, false, true),
        // 编辑
        command(CommandId::Undo, "撤销", {"cmd+z"}),
        command(CommandId::Redo, "重做", {"cmd+shift+z"}),
        command(CommandId::Cut, "剪切", {"cmd+x"}),
        command(CommandId::Copy, "复制", {"cmd+c"}),
        command(CommandId::Paste, "粘贴", {"cmd+v"}),
        command(CommandId::SelectAll, "全选", {"cmd+a"}),
        // 格式
        format(CommandId::FormatBold, "粗体", "bold", {"cmd+b"}),
        format(CommandId::FormatItalic, "斜体", "italic", {"cmd+i"}),
        format(CommandId::FormatInlineCode, "行内代码", "inlineCode", {"cmd+shift+k"}),
        format(CommandId::FormatLink, "链接", "link", {"cmd+k"}),
        format(CommandId::FormatH1, "标题 1", "h1", {"cmd+1"}),
        format(CommandId::FormatH2, "标题 2", "h2", {"cmd+2"}),
        format(CommandId::FormatH3, "标题 3", "h3", {"cmd+3"}),
        format(CommandId::FormatParagraph, "正文", "paragraph"),
        format(CommandId::FormatUl, "无序列表", "ul", {"cmd+shift+8"}),
        format(CommandId::FormatOl, "有序列表", "ol", {"cmd+shift+7"}),
        format(CommandId::FormatQuote, "引用", "quote", {"cmd+shift+b"}),
        format(CommandId::FormatCodeBlock, "代码块", "codeBlock", {"cmd+shift+c"}),
        format(CommandId::FormatTable, "表格", "table", {"cmd+shift+t"}),
        format(CommandId::FormatHr, "分隔线", "hr"),
        // 视图
        command(CommandId::ToggleToc, "目录", {"cmd+shift+l"}, {}, true),
        command(CommandId::ToggleSource, "源码模式", {"cmd+e", "cmd+/"}, {}, true),
        command(CommandId::ToggleDark, "深色模式", {"cmd+shift+d"}, {}, true),
        command(CommandId::FollowSystem, "跟随系统外观", {}, {}, true),
        // Cmd+= 在 macOS 上可能以 equal 或 plus 到达，两种都注册
        command(CommandId::ZoomIn, "放大", {"cmd+equal", "cmd+shift+equal", "cmd+plus"}),
        command(CommandId::ZoomOut, "缩小", {"cmd+minus"}),
        command(CommandId::ZoomReset, "实际大小", {"cmd+0"}),
    };
    return table;
}

} // namespace

const std::vector<MenuSpec> &menus()
{
    return menuTable();
}

const CommandSpec *findCommand(CommandId id)
{
    const auto &table = commandTable();
    const auto it = std::find_if(table.begin(), table.end(),
                                 [id](const CommandSpec &spec) { return spec.id == id; });
    return it == table.end() ? nullptr : &*it;
}

} // namespace mote
