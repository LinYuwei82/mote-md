void EditorController::applyFormat(const std::string &action)
{
    // 格式动作名由前端 formatAction 统一解释，菜单、斜杠、右键三个入口共用
    m_host.evaluateJs(js::format(action));
}

void EditorController::requestExportHtml(const std::string &title)
{
    // 前端把整篇渲染结果拼成自包含 HTML 后经消息回传
    m_host.evaluateJs(js::exportHtml(title));
}

void EditorController::requestExportPdf(const std::string &path)
{
    if (path.empty()) {
        m_host.exportPdfFailed("导出失败：没有指定保存位置");
        return;
    }
    // 另存为会换目录并重载页面；保存完成立刻导出时页面还没 ready。
    // 这里先记下目标，等 ready 后再交给平台执行（平台自行等待图片/字体稳定）。
    if (!m_pageReady) {
        m_pendingPdfPath = path;
        return;
    }
    m_host.exportPdfRequested(path);
}

void EditorController::insertImage(const std::string &relativePath)
{
    m_host.evaluateJs(js::insertImage(relativePath));
}

