void EditorController::handleMessage(std::string_view json)
{
    JsonValue message;
    if (!parseJson(json, message) || !message.isObject())
        return;
    const std::string type = message.stringAt("type");

    if (type == "ready") {
        perfMark("core:ready_msg");
        m_pageReady = true;
        // 先把 <base> 与待注入正文推到当前页，再对外发 ready：
        // 顺序反了会让正文里的相对图片按旧目录解析。
        applyBaseHref();
        if (m_hasPending)
            injectMarkdown(m_pendingText);
        applyTheme();
        m_host.ready();
        // 另存为后立刻导出：页面刚重载完，等图片与字体稳定由平台负责
        if (!m_pendingPdfPath.empty()) {
            const std::string pending = m_pendingPdfPath;
            m_pendingPdfPath.clear();
            m_host.exportPdfRequested(pending);
        }
        return;
    }
    if (type == "view") {
        ViewState state;
        state.toc = message.boolAt("toc");
        state.source = message.boolAt("source");
        state.zoom = message.numberAt("zoom", 1.0);
        m_host.viewStateChanged(state);
        return;
    }
    if (type == "dirty") {
        m_dirty = message.boolAt("value");
        m_host.dirtyChanged(m_dirty);
        return;
    }
    if (type == "stats") {
        m_host.statsChanged(static_cast<int>(message.numberAt("cjk")),
                            static_cast<int>(message.numberAt("words")));
        return;
    }
    if (type == "save") {
        m_host.saveRequested(message.stringAt("text"));
        return;
    }
    if (type == "open") {
        m_host.openRequested();
        return;
    }
    if (type == "drop") {
        m_host.dropReceived(message.stringAt("name"), message.stringAt("text"));
        return;
    }
    if (type == "image") {
        const std::vector<std::uint8_t> data = base64Decode(message.stringAt("data"));
        if (data.empty()) {
            m_host.statusMessage("图片未插入：剪贴板内容为空");
            return;
        }
        const std::string source = message.stringAt("source");
        saveImageBytes(data, message.stringAt("mime"), message.stringAt("name"),
                       source != "drop");
        return;
    }
    if (type == "crossSelection") {
        // 页面自建跨块选区（原型）：只影响菜单复制/剪切的路由，不改正文
        m_crossSelection = message.boolAt("active");
        return;
    }
    if (type == "editCommand") {
        // 页面（右键菜单）把编辑命令交回宿主，与编辑菜单、快捷键同一条路径
        clipboardCommand(message.stringAt("command"));
        return;
    }
    if (type == "clipboardWrite") {
        // 页面算好的内容落到系统剪贴板（复制/剪切共用这一条回路）。
        // html 是可选字段：不带就只写纯文本。
        m_host.setClipboard(message.stringAt("text"), message.stringAt("html"));
        return;
    }
    if (type == "openLink") {
        m_host.openExternal(message.stringAt("href"));
        return;
    }
    if (type == "export") {
        m_host.exportHtmlReady(message.stringAt("html"));
        return;
    }
    if (type == "status") {
        m_host.statusMessage(message.stringAt("message"));
        return;
    }
    if (type == "error") {
        m_host.errorOccurred(message.stringAt("message"));
        return;
    }
    if (type == "log") {
        m_host.logMessage(message.stringAt("message"));
        return;
    }
}

