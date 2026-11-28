void pdfBeginExport(PdfJob *job, WKWebView *webView)
{
    [webView evaluateJavaScript:@"window.mote && window.mote.pdfBegin()"
              completionHandler:^(id result, NSError *error) {
            (void)error;
            NSString *json = nil;
            if ([result isKindOfClass:[NSString class]])
                json = (NSString *)result;
            else if ([result isKindOfClass:[NSDictionary class]])
                json = [[NSString alloc]
                    initWithData:[NSJSONSerialization dataWithJSONObject:result
                                                                 options:0
                                                                   error:NULL]
                        encoding:NSUTF8StringEncoding];
            NSDictionary *dimensions = nil;
            if (json.length > 0) {
                id parsed = [NSJSONSerialization
                    JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding]
                               options:0
                                 error:NULL];
                if ([parsed isKindOfClass:[NSDictionary class]])
                    dimensions = parsed;
            }

            const double width = [dimensions[@"w"] doubleValue];
            const double height = [dimensions[@"h"] doubleValue];
            std::vector<double> cuts = parseCuts(dimensions, height);
            if (width < 10 || height < 10 || cuts.size() < 2) {
                [webView evaluateJavaScript:@"window.mote && window.mote.pdfEnd()"
                          completionHandler:nil];
                if (job->completion)
                    job->completion(false, "导出失败：没有可导出的正文");
                delete job;
                return;
            }
            std::sort(cuts.begin(), cuts.end());
            job->width = width;
            job->height = height;
            job->pages = pdfPlanPages(cuts, height, width);
            if (job->pages.empty() || job->pages.back().bottom < height - 0.5) {
                // 超过页数上限时宁可报错，也不能把后半篇悄悄丢掉
                pdfAbort(job, webView, "导出失败：文档过长，无法完整导出");
                return;
            }
            for (const PdfPage &page : job->pages) {
                if (page.bottom - page.top > kPdfChunkPx + 0.01) {
                    pdfAbort(job, webView, "导出失败：文档中有超高元素，无法完整导出");
                    return;
                }
            }
            job->chunks = pdfChunks(job->pages);
            job->fontChunks = pdfFontChunks(job->pages);
            pdfRunChunk(job, webView);
              }];
}

void pdfWaitContent(PdfJob *job, WKWebView *webView, int attempt)
{
    [webView
        evaluateJavaScript:
            @"String(!!(window.mote&&window.mote.pdfContentReady&&window.mote.pdfContentReady()))"
      completionHandler:^(id ready, NSError *error) {
        const BOOL contentReady = [ready isKindOfClass:[NSString class]]
            && [(NSString *)ready isEqualToString:@"true"];
        // 每 100ms 查一次，最多等 8 秒；真不可用就照常导出
        if (!contentReady && !error && attempt < 80) {
            dispatch_after(
                dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                dispatch_get_main_queue(), ^{
                  pdfWaitContent(job, webView, attempt + 1);
                });
            return;
        }
        pdfBeginExport(job, webView);
      }];
}

