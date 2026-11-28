void EditorController::injectMarkdown(const std::string &text)
{
    perfMark("core:inject_send");
    m_host.injectDocument(text);
    m_hasPending = false;
}

void EditorController::requestSnapshot()
{
    m_host.evaluateJs(js::requestSnapshot());
}

void EditorController::notifySaved(const std::string &text)
{
    m_lastSavedText = text;
    const bool wasDirty = m_dirty;
    m_dirty = false;
    m_host.evaluateJs(js::markSaved(text));
    if (wasDirty)
        m_host.dirtyChanged(false);
}

