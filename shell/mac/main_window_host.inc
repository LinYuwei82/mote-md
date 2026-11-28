namespace {

// EditorHost → AppKit 的转发层。owner 是应用级单窗口，生命周期覆盖整个进程。
class ShellHost final : public mote::EditorHost
{
public:
    explicit ShellHost(MoteMainWindow *window) : m_owner(window) {}

    void evaluateJs(const std::string &script) override
    {
        [m_owner evaluateScript:script];
    }
    void loadPage(const std::string &baseDir) override
    {
        [m_owner loadPageInDirectory:baseDir];
    }
    void setClipboard(const std::string &text, const std::string &html) override
    {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        [pasteboard clearContents];
        NSString *plain = [NSString stringWithUTF8String:text.c_str()];
        [pasteboard setString:plain ?: @"" forType:NSPasteboardTypeString];
        if (!html.empty()) {
            NSString *marked = [NSString stringWithUTF8String:html.c_str()];
            if (marked)
                [pasteboard setString:marked forType:NSPasteboardTypeHTML];
        }
    }
    std::string clipboardText() override
    {
        NSString *text = [[NSPasteboard generalPasteboard]
            stringForType:NSPasteboardTypeString];
        return text ? std::string(text.UTF8String) : std::string();
    }
    void openExternal(const std::string &url) override
    {
        [m_owner openExternalUrl:url];
    }
    void saveRequested(const std::string &text) override
    {
        [m_owner saveText:text];
    }
    void openRequested() override
    {
        [m_owner openDocument];
    }
    void dropReceived(const std::string &name, const std::string &text) override
    {
        [m_owner acceptDroppedName:name text:text];
    }
    void exportHtmlReady(const std::string &html) override
    {
        [m_owner htmlExportReady:html];
    }
    void exportPdfRequested(const std::string &path) override
    {
        [m_owner requestPdfExport:path];
    }
    void exportPdfFailed(const std::string &message) override
    {
        [m_owner pdfExportFailed:message];
    }
    void fileDropRequested(const std::string &path) override
    {
        [m_owner openPathFromDrop:path];
    }
    void statusMessage(const std::string &message) override
    {
        [m_owner showStatus:[NSString stringWithUTF8String:message.c_str()]];
    }
    void errorOccurred(const std::string &message) override
    {
        NSString *plain = [NSString stringWithUTF8String:message.c_str()];
        [m_owner showStatus:[NSString stringWithFormat:@"前端错误：%@", plain ?: @""]];
    }
    void ready() override
    {
        [m_owner pageBecameReady];
    }
    void dirtyChanged(bool dirty) override
    {
        (void)dirty;
        [m_owner updateWindowTitle];
    }
    void viewStateChanged(const mote::ViewState &state) override
    {
        [m_owner applyViewState:state];
    }
    void statsChanged(int cjk, int words) override
    {
        if (std::getenv("MOTE_KEYLOG"))
            std::fprintf(stderr, "NATIVE stats cjk=%d words=%d\n", cjk, words);
    }
    void logMessage(const std::string &message) override
    {
        if (std::getenv("MOTE_KEYLOG") || mote::perfEnabled())
            std::fprintf(stderr, "JSLOG %s\n", message.c_str());
    }

private:
    __unsafe_unretained MoteMainWindow *m_owner;
};

} // namespace
