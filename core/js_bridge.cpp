#include "core/js_bridge.h"

namespace mote::js {

namespace {

std::string call(std::string_view method, const std::string &arguments = {})
{
    return "window.mote && window.mote." + std::string(method) + "(" + arguments + ");";
}

} // namespace

std::string setMarkdown(std::string_view text)
{
    return call("setMarkdown", quoteJson(text));
}

std::string newDocument()
{
    return call("newDocument");
}

std::string requestSnapshot()
{
    return call("requestSnapshot");
}

std::string markSaved(std::string_view text)
{
    return call("markSaved", quoteJson(text));
}

std::string undo()
{
    return call("undo");
}

std::string redo()
{
    return call("redo");
}

std::string clipboardCopy(bool cut)
{
    return call("clipboardCopy", cut ? "true" : "false");
}

std::string clipboardPaste(std::string_view text)
{
    return call("clipboardPaste", quoteJson(text));
}

std::string toggleToc()
{
    return call("toggleToc");
}

std::string toggleSource()
{
    return call("toggleSource");
}

std::string zoomBy(int steps)
{
    return call("zoomBy", std::to_string(steps));
}

std::string resetZoom()
{
    return call("resetZoom");
}

std::string setTheme(std::string_view mode)
{
    return call("setTheme", quoteJson(mode));
}

std::string format(std::string_view action)
{
    return call("format", quoteJson(action));
}

std::string exportHtml(std::string_view title)
{
    return call("exportHtml", quoteJson(title));
}

std::string insertImage(std::string_view relativePath)
{
    return call("insertImage", quoteJson(relativePath));
}

std::string applyBaseHref(std::string_view fileUrl)
{
    return "(function(){var h=document.head;if(!h)return;var b=h.querySelector('base');"
           "if(!b){b=document.createElement('base');h.insertBefore(b,h.firstChild);}"
           "b.href=" + quoteJson(fileUrl) + ";})();";
}

std::string clearBaseHref()
{
    return "(function(){var b=document.querySelector('base');"
           "if(b&&b.parentNode)b.parentNode.removeChild(b);})();";
}

} // namespace mote::js
