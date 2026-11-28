void EditorController::setMarkdown(const std::string &text, const std::string &baseDir)
{
    // 免重载判定：页面已按授权根取得读作用域，新目录同样落在根内——
    // 换文档只需改 <base> 并注入正文，不再重走整页导航与脚本解析。
    const bool inScope = m_pageLoaded && m_pageScopedToRoot
        && (baseDir.empty() || underRoot(baseDir, m_readAccessRoot));
    perfMark(m_pageLoaded && baseDir != m_baseDir
                 ? (inScope ? "core:setmd_inject" : "core:setmd_reload")
                 : "core:setmd_first");
    if (!m_pageLoaded || (baseDir != m_baseDir && !inScope)) {
        m_baseDir = baseDir;
        m_pendingText = text;
        m_hasPending = true;
        m_pageLoaded = true;
        m_pageReady = false;
        m_crossSelection = false;
        // 新文档以载入的文本为基准：打开/新建后立刻是「未修改」
        if (m_dirty) {
            m_dirty = false;
            m_host.dirtyChanged(false);
        }
        // 记录这次 loadPage 实际拿到的作用域：越界目录的页面只授了目录本身，
        // 之后的换目录仍需重载（壳的授权规则与此处判定保持一致）。
        m_pageScopedToRoot = !m_readAccessRoot.empty()
            && (baseDir.empty() || underRoot(baseDir, m_readAccessRoot));
        // 换页前推进代次：旧页面迟到的 ready 会带着旧 token，被消息桥丢弃
        ++m_pageGeneration;
        m_host.loadPage(baseDir);
        return;
    }

    if (baseDir != m_baseDir) {
        m_baseDir = baseDir;
        applyBaseHref();
        if (m_dirty) {
            m_dirty = false;
            m_host.dirtyChanged(false);
        }
    }
    m_pendingText = text;
    m_hasPending = true;
    if (m_pageReady)
        injectMarkdown(text);
}

void EditorController::newDocument()
{
    // 未命名文档没有磁盘位置：清掉 baseDir，图片粘贴会走「请先保存」提示。
    // 这里不能走 setBaseDir()（那会重载页面并把上一份正文带回来），只把 <base> 去掉。
    m_baseDir.clear();
    applyBaseHref();
    m_crossSelection = false;
    m_pendingText.clear();
    m_hasPending = false;
    m_host.evaluateJs(js::newDocument());
}

void EditorController::setBaseDir(const std::string &dir)
{
    if (dir == m_baseDir)
        return;
    m_baseDir = dir;
    if (!m_pageReady) {
        // 页面正在换页：接下来那次 loadPage 已经会用新目录
        return;
    }
    // 新目录仍在当前页面作用域内：只改 <base>，不重载页面
    if (m_pageScopedToRoot && (dir.empty() || underRoot(dir, m_readAccessRoot))) {
        applyBaseHref();
        return;
    }
    // 换目录必须重载页面：WebView 允许读取的目录在加载时固定，只改页内 <base>
    // 时新目录下的图片会被拒绝读取。代价：滚动位置回到顶部、撤销栈重置；
    // 正文用最近一次保存的内容恢复。
    m_pendingText = m_lastSavedText;
    m_hasPending = true;
    m_pageReady = false;
    m_crossSelection = false;
    m_pageScopedToRoot = !m_readAccessRoot.empty()
        && (dir.empty() || underRoot(dir, m_readAccessRoot));
    ++m_pageGeneration;
    m_host.loadPage(dir);
}

void EditorController::applyBaseHref()
{
    // 页面未就绪时先记在 m_baseDir 里，ready 分支会再推一次
    if (!m_pageReady)
        return;
    if (m_baseDir.empty()) {
        m_host.evaluateJs(js::clearBaseHref());
        return;
    }
    m_host.evaluateJs(js::applyBaseHref(fileUrlForDirectory(m_baseDir)));
}

