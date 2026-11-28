- (void)evaluateJavaScript:(NSString *)script
{
    [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (void)focusEditor
{
    [self.window makeFirstResponder:self.webView];
}

- (void)exportPdfToPath:(NSString *)path
             completion:(void (^)(BOOL, NSString *))completion
{
    const std::string target(path.UTF8String ?: "");
    MoteExportPdf(self.webView, target, [completion](bool ok, const std::string &message) {
        NSString *text = message.empty()
            ? nil
            : [NSString stringWithUTF8String:message.c_str()];
        if (completion)
            completion(ok, text);
    });
}

