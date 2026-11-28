bool EditorController::saveImageBytes(const std::vector<std::uint8_t> &bytes,
                                      const std::string &mime, const std::string &hint,
                                      bool isPaste)
{
    const StoredImage stored = storeImage(m_baseDir, bytes, mime, hint, isPaste);
    if (!stored.ok) {
        m_host.statusMessage(stored.error);
        return false;
    }
    insertImage(stored.relativePath);
    m_host.statusMessage("已保存图片：" + stored.relativePath);
    return true;
}

bool EditorController::saveImageFile(const std::string &path)
{
    bool ok = false;
    const std::vector<std::uint8_t> bytes = readFileBytes(path, &ok);
    if (!ok) {
        m_host.statusMessage("图片未插入：无法读取 " + fileNameOf(path));
        return false;
    }
    return saveImageBytes(bytes, std::string(), fileNameOf(path), false);
}

