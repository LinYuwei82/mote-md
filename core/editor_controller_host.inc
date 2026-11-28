void EditorHost::injectDocument(const std::string &text)
{
    const std::string quoted = quoteJson(text);
    // 通道一：单条脚本
    if (quoted.size() <= kScriptBudget) {
        evaluateJs(js::setMarkdown(text));
        return;
    }
    // 通道二：分片 ExecuteScript，末片之后拼接交给页面（mac 无 PostWebMessageAsJson，
    // 故 core 默认只到分片；win 覆写为三通道，中间多一条消息通道）。
    perfMark("core:inject_chunks");
    evaluateJs("window.__moteInject=[];");
    for (const std::string &chunk : splitUtf8ByBudget(text, kScriptBudget))
        evaluateJs("window.__moteInject.push(" + quoteJson(chunk) + ");");
    evaluateJs("(function(){var t=(window.__moteInject||[]).join('');"
               "window.__moteInject=[];window.mote&&window.mote.setMarkdown(t);})();");
}

