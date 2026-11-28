namespace {

// dir 是否等于 root 或位于其下（按路径段边界比较，兼容 / 与 \\ 分隔符）
bool underRoot(const std::string &dir, const std::string &root)
{
    if (root.empty() || dir.size() < root.size()
        || dir.compare(0, root.size(), root) != 0)
        return false;
    if (dir.size() == root.size())
        return true;
    const char sep = dir[root.size()];
    return sep == '/' || sep == '\\';
}

} // namespace

