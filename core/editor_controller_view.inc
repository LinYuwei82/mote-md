void EditorController::toggleToc()
{
    m_host.evaluateJs(js::toggleToc());
}

void EditorController::toggleSource()
{
    m_host.evaluateJs(js::toggleSource());
}

void EditorController::zoomBy(int steps)
{
    m_host.evaluateJs(js::zoomBy(steps));
}

void EditorController::resetZoom()
{
    m_host.evaluateJs(js::resetZoom());
}

void EditorController::setTheme(const std::string &mode)
{
    m_theme = mode == "dark" ? "dark" : "light";
    applyTheme();
}

void EditorController::applyTheme()
{
    // 只切 CSS 变量，不重排正文；页面未就绪时先记住，ready 后由这里补发
    if (!m_pageReady)
        return;
    m_host.evaluateJs(js::setTheme(m_theme));
}

