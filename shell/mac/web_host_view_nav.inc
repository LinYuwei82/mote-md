#pragma mark - WKNavigationDelegate

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler
{
    // 只放行本地临时页的首次加载；Cmd+Click 等外链由外壳另开浏览器
    NSURL *url = action.request.URL;
    if (!webView.URL) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (url && [[url absoluteString] isEqualToString:[webView.URL absoluteString]]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)action
                    windowFeatures:(WKWindowFeatures *)windowFeatures
{
    (void)webView;
    (void)configuration;
    (void)action;
    (void)windowFeatures;
    return nil;                // 不弹新窗口
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation
{
    (void)webView;
    (void)navigation;
    mote::perfMark("mac:nav_commit");
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation
{
    (void)webView;
    (void)navigation;
    mote::perfMark("mac:nav_finish");
}

