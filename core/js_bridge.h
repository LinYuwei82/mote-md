#pragma once

#include "core/json.h"

#include <string>
#include <string_view>

namespace mote::js {

// 外壳 → 页面的脚本片段。页面未就绪时这些表达式本身可安全空转，
// 因此调用方不需要额外判断 ready（除 setMarkdown 的缓存语义外）。
std::string setMarkdown(std::string_view text);
std::string newDocument();
std::string requestSnapshot();
std::string markSaved(std::string_view text);
std::string undo();
std::string redo();
std::string clipboardCopy(bool cut);
std::string clipboardPaste(std::string_view text);
std::string toggleToc();
std::string toggleSource();
std::string zoomBy(int steps);
std::string resetZoom();
std::string setTheme(std::string_view mode);
std::string format(std::string_view action);
std::string exportHtml(std::string_view title);
std::string insertImage(std::string_view relativePath);

// <base href> 注入：页面未就绪时由 EditorController 在 ready 后补发
std::string applyBaseHref(std::string_view fileUrl);
std::string clearBaseHref();

// 状态栏移入前端：外壳给 body 加平台类后 #statusbar 才显示，
// 这样 Qt/Windows 构建不会多出一条与原生状态栏重复的条。
std::string enableStatusBar();
std::string statusMessage(std::string_view text);

} // namespace mote::js
