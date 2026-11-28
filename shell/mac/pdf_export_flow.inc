void pdfRunChunk(PdfJob *job, WKWebView *web);

void pdfFinish(PdfJob *job, WKWebView *web)
{
    [web evaluateJavaScript:@"window.mote && window.mote.pdfEnd()" completionHandler:nil];
    if (job->pageCount <= 0) {
        pdfAbort(job, web, "导出失败：没有可导出的正文");
        return;
    }

    // 按段组装：内容流与字体在段内共用，页面用 MediaBox 取景
    NSData *output = pdfAssemble(job);
    const BOOL written = output
        && [output writeToFile:@(job->path.c_str()) atomically:YES];
    NSDictionary *attributes = [[NSFileManager defaultManager]
        attributesOfItemAtPath:@(job->path.c_str())
                         error:NULL];
    const BOOL usable = written && [attributes[NSFileSize] unsignedLongLongValue] > 0;
    if (!usable) {
        [[NSFileManager defaultManager] removeItemAtPath:@(job->path.c_str()) error:NULL];
        if (job->completion)
            job->completion(false, "导出失败：无法写入 " + job->path);
        delete job;
        return;
    }

    if (job->completion)
        job->completion(true, std::string());
    delete job;
}

void pdfRunChunk(PdfJob *job, WKWebView *web)
{
    if (job->aborted)
        return;
    const bool pagePhase = job->chunkIndex < job->chunks.size();
    if (!pagePhase && job->fontIndex >= job->fontChunks.size()) {
        pdfFinish(job, web);
        return;
    }
    const std::pair<double, double> band =
        pagePhase ? job->chunks[job->chunkIndex] : job->fontChunks[job->fontIndex];
    const double bandTop = band.first;
    const double bandBottom = band.second;

    WKPDFConfiguration *configuration = [[WKPDFConfiguration alloc] init];
    configuration.rect = CGRectMake(0, bandTop, job->width, bandBottom - bandTop);
    [web createPDFWithConfiguration:configuration
                 completionHandler:^(NSData *data, NSError *error) {
                   if (job->aborted)
                       return;
                   if (!data || error) {
                       pdfAbort(job, web, "导出失败：无法渲染页面");
                       return;
                   }
                   if (pagePhase) {
                       if (!pdfStorePage(job, data)) {
                           pdfAbort(job, web, "导出失败：文档过长，无法分页导出");
                           return;
                       }
                       job->chunkIndex++;
                   } else {
                       job->fontPDFs.push_back(data);
                       job->fontIndex++;
                   }
                   dispatch_async(dispatch_get_main_queue(), ^{
                     pdfRunChunk(job, web);
                   });
                 }];
}

std::vector<double> parseCuts(NSDictionary *dimensions, double height)
{
    std::vector<double> cuts;
    id raw = dimensions[@"cuts"];
    if (![raw isKindOfClass:[NSArray class]])
        return cuts;
    for (id item in (NSArray *)raw) {
        if (![item isKindOfClass:[NSNumber class]])
            continue;
        const double cut = [item doubleValue];
        if (cut >= 0 && cut <= height)
            cuts.push_back(cut);
    }
    return cuts;
}

void pdfBeginExport(PdfJob *job, WKWebView *webView);
void pdfWaitContent(PdfJob *job, WKWebView *webView, int attempt);

