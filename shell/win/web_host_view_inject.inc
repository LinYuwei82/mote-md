void WebHostView::inject_markdown(const std::string &text)
{
    if (!webview_) {
        // 页面未就绪时 core 会缓存正文，等 ready 后重走这里
        return;
    }

    const std::string quoted = mote::quoteJson(text);
    // 通道一：单条脚本，体积最省
    if (quoted.size() <= kScriptBudget) {
        mote::perfMark("win:inject_script");
        evaluate_script(mote::js::setMarkdown(text));
        return;
    }

    // 通道二：PostWebMessageAsJson，由文档创建时注入的桥接脚本转交页面
    const std::string payload =
        "{\"__mote\":\"setMarkdown\",\"text\":" + quoted + "}";
    if (payload.size() <= kMessageBudget
        && SUCCEEDED(webview_->PostWebMessageAsJson(utf8_to_wide(payload).c_str()))) {
        mote::perfMark("win:inject_message");
        return;
    }

    // 通道三：分片 ExecuteScript，最后一片之后拼接并交给页面
    auto run = [this](const std::string &script) {
        webview_->ExecuteScript(utf8_to_wide(script).c_str(), nullptr);
    };
    run("window.__moteInject=[];");
    size_t chunks = 0;
    for (const std::string &chunk : mote::splitUtf8ByBudget(text, kScriptBudget)) {
        run("window.__moteInject.push(" + mote::quoteJson(chunk) + ");");
        ++chunks;
    }
    run("(function(){var t=(window.__moteInject||[]).join('');"
        "window.__moteInject=[];window.mote&&window.mote.setMarkdown(t);})();");
    if (mote::perfEnabled())
        std::fprintf(stderr, "[perf] win:inject_chunks %zu pieces\n", chunks);
}

