void EditorController::undo()
{
    m_host.evaluateJs(js::undo());
}

void EditorController::redo()
{
    m_host.evaluateJs(js::redo());
}

void EditorController::clipboardCommand(const std::string &command)
{
    // 页面算内容、原生写剪贴板：复制与剪切共用一条回路，剪切由页面删选区
    if (command == "copy" || command == "cut") {
        m_host.evaluateJs(js::clipboardCopy(command == "cut"));
        return;
    }
    if (command != "paste")
        return;

    // 图片优先，与页面原生粘贴分支同一口径：解码后的字节交给图片落盘逻辑
    std::vector<std::uint8_t> image;
    std::string mime;
    if (m_host.clipboardImage(&image, &mime) && !image.empty()) {
        saveImageBytes(image, mime.empty() ? "image/png" : mime, "paste", true);
        return;
    }

    const std::string text = m_host.clipboardText();
    if (text.empty()) {
        m_host.statusMessage("剪贴板里没有可粘贴的文本");
        return;
    }
    m_host.evaluateJs(js::clipboardPaste(text));
}

