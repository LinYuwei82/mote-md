void MoteExportPdf(WKWebView *webView, const std::string &path,
                   std::function<void(bool, const std::string &)> completion)
{
    if (!webView) {
        if (completion)
            completion(false, "导出失败：页面还没准备好");
        return;
    }
    // 同名旧文件不能算本次成功：先删，成功与否由产物是否存在、非空判定
    [[NSFileManager defaultManager] removeItemAtPath:@(path.c_str()) error:NULL];

    PdfJob *job = new PdfJob();
    job->path = path;
    job->completion = std::move(completion);

    // 先进入导出态（隐藏外壳）并量整篇正文尺寸与安全切点；pdfBegin 只加 body class，
    // 失败路径也必须 pdfEnd 还原。导出样式依赖内嵌字体与图片：量高度前先等它们解码完，
    // 否则图片块高度为 0，createPDF 也会把图片画成空白。
    pdfWaitContent(job, webView, 0);
}

