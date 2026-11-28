bool EditorController::acceptsNativeFileDrop(const std::vector<std::string> &paths) const
{
    for (const std::string &path : paths) {
        if (isMarkdownPath(path) || isImagePath(path))
            return true;
    }
    return false;
}

bool EditorController::handleNativeFileDrop(const std::vector<std::string> &paths)
{
    bool recognized = false;
    for (const std::string &path : paths) {
        if (isMarkdownPath(path)) {
            recognized = true;
            std::error_code error;
            const std::string absolute =
                std::filesystem::absolute(path, error).lexically_normal().string();
            m_host.fileDropRequested(error ? path : absolute);
            return true;
        }
    }
    for (const std::string &path : paths) {
        if (isImagePath(path)) {
            recognized = true;
            saveImageFile(path);
        }
    }
    return recognized;
}

