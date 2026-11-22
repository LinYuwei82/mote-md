#import "pdf_export.h"

#include <algorithm>
#include <utility>
#include <vector>

namespace {

const CGFloat kPdfPageW = 595.28;
const CGFloat kPdfPageH = 841.89;
// 与 Typora 导出的 A4 样张一致：左右 37.6pt、上下 45.4pt，正文宽 520.08pt。
// 导出态 CSS 把 #editor 固定成 693.44px（=520.08pt），因此纸面上的 1pt 就是 CSS 里的 1pt。
const CGFloat kPdfMarginLeft = 37.6;
const CGFloat kPdfMarginRight = 37.6;
const CGFloat kPdfMarginTop = 45.4;
const CGFloat kPdfMarginBottom = 45.4;
const CGFloat kPdfContentW = kPdfPageW - kPdfMarginLeft - kPdfMarginRight;
const CGFloat kPdfContentH = kPdfPageH - kPdfMarginTop - kPdfMarginBottom;
const double kPdfChunkPx = 13800.0; // 单次 createPDF 的高度上限（低于 14400pt）
const int kPdfMaxPages = 200;

struct PdfPage {
    double top = 0;
    double bottom = 0;
    double scale = 1;
};

struct PdfJob {
    std::string path;
    std::vector<PdfPage> pages;
    std::vector<std::pair<double, double>> chunks;
    double width = 0;
    double height = 0;
    size_t chunkIndex = 0;
    int pageCount = 0;
    CGContextRef ctx = nullptr;
    CFMutableDataRef buffer = nullptr;
    bool aborted = false;
    std::function<void(bool, const std::string &)> completion;
};

void pdfCleanup(PdfJob *job)
{
    if (job->ctx) {
        CGPDFContextClose(job->ctx);
        CGContextRelease(job->ctx);
        job->ctx = nullptr;
    }
    if (job->buffer) {
        CFRelease(job->buffer);
        job->buffer = nullptr;
    }
}

void pdfAbort(PdfJob *job, WKWebView *web, const std::string &message)
{
    if (job->aborted)
        return;
    job->aborted = true;
    [web evaluateJavaScript:@"window.mote && window.mote.pdfEnd()" completionHandler:nil];
    pdfCleanup(job);
    [[NSFileManager defaultManager] removeItemAtPath:@(job->path.c_str()) error:NULL];
    if (job->completion)
        job->completion(false, message);
    delete job;
}

// 先按安全切点排页，再把连续页打成一段（每段高度低于 createPDF 上限）。
// 分包边界落在页边界上，不会因为段尾放不下一页而多出空白。
std::vector<PdfPage> pdfPlanPages(const std::vector<double> &cuts, double height, double width)
{
    std::vector<PdfPage> pages;
    if (width <= 0 || height <= 0 || cuts.size() < 2)
        return pages;
    const double scale = kPdfContentW / width;
    const double sliceSrc = kPdfContentH / scale;
    double y = 0;
    while (y < height - 0.5 && pages.size() < static_cast<size_t>(kPdfMaxPages)) {
        const double limit = y + sliceSrc;
        double bottom = -1;
        for (const double cut : cuts) {
            if (cut > y + 0.5 && cut <= limit + 0.01)
                bottom = cut;
        }
        double pageScale = scale;
        if (bottom < 0) {
            // 页内没有安全切点：单个超高原子块整段缩放放进一页，宁可缩小也不劈开
            for (const double cut : cuts) {
                if (cut > y + 0.5) {
                    bottom = cut;
                    break;
                }
            }
            if (bottom < 0)
                bottom = height;
            pageScale = std::min(scale, kPdfContentH / (bottom - y));
        }
        if (bottom <= y + 0.5)
            break;
        PdfPage page;
        page.top = y;
        page.bottom = bottom;
        page.scale = pageScale;
        pages.push_back(page);
        y = bottom;
    }
    return pages;
}

std::vector<std::pair<double, double>> pdfChunks(const std::vector<PdfPage> &pages)
{
    // 每页单独 createPDF：早先按 18 页成段、再把同一段切给每一页，会让每页
    // 内容流重复整段的绘制指令，导出体积膨胀十几倍（7.9MB）。单页成段后每个
    // 内容流只含本页内容（内容流共 0.55MB，与 Typora 相当）；2 页成段虽能少
    // 嵌入一些字体子集，但会把下一页的文字带进本页文本层，影响检索与复制，
    // 所以不采用。
    std::vector<std::pair<double, double>> chunks;
    chunks.reserve(pages.size());
    for (const PdfPage &page : pages)
        chunks.emplace_back(page.top, page.bottom);
    return chunks;
}

// 把一段 createPDF 结果按事先排好的页绘制成 A4 矢量页
bool pdfDrawChunk(PdfJob *job, NSData *data, double chunkTop, double chunkBottom)
{
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((CFDataRef)data);
    CGPDFDocumentRef doc = CGPDFDocumentCreateWithProvider(provider);
    CGDataProviderRelease(provider);
    if (!doc || CGPDFDocumentGetNumberOfPages(doc) < 1) {
        if (doc)
            CGPDFDocumentRelease(doc);
        return false;
    }
    CGPDFPageRef sourcePage = CGPDFDocumentGetPage(doc, 1);
    const CGRect box = CGPDFPageGetBoxRect(sourcePage, kCGPDFMediaBox);
    if (box.size.width <= 0 || box.size.height <= 0) {
        CGPDFDocumentRelease(doc);
        return false;
    }

    for (const PdfPage &page : job->pages) {
        if (page.top < chunkTop - 0.5 || page.bottom > chunkBottom + 0.5)
            continue;
        if (++job->pageCount > kPdfMaxPages) {
            CGPDFDocumentRelease(doc);
            return false;
        }
        const double bandTop = page.top - chunkTop;
        const double bandBottom = page.bottom - chunkTop;
        const CGFloat outH = (bandBottom - bandTop) * page.scale;
        CGPDFContextBeginPage(job->ctx, NULL);
        CGContextSaveGState(job->ctx);
        // 内容贴内容区顶部（每页一致），最后一页不足时底部留白
        CGContextTranslateCTM(job->ctx, kPdfMarginLeft,
                              kPdfMarginBottom + kPdfContentH - outH);
        CGContextScaleCTM(job->ctx, page.scale, page.scale);
        CGContextTranslateCTM(job->ctx, 0, -(box.size.height - bandBottom));
        CGContextClipToRect(job->ctx, CGRectMake(0, box.size.height - bandBottom,
                                                 box.size.width, bandBottom - bandTop));
        CGContextDrawPDFPage(job->ctx, sourcePage);
        CGContextRestoreGState(job->ctx);
        CGPDFContextEndPage(job->ctx);
    }
    CGPDFDocumentRelease(doc);
    return true;
}

void pdfRunChunk(PdfJob *job, WKWebView *web);

void pdfFinish(PdfJob *job, WKWebView *web)
{
    [web evaluateJavaScript:@"window.mote && window.mote.pdfEnd()" completionHandler:nil];
    if (job->pageCount <= 0) {
        pdfAbort(job, web, "导出失败：没有可导出的正文");
        return;
    }

    // 必须先关闭 context（写 trailer 与 xref），再取字节；顺序颠倒会得到截断的 PDF
    if (job->ctx) {
        CGPDFContextClose(job->ctx);
        CGContextRelease(job->ctx);
        job->ctx = nullptr;
    }
    NSData *output = nil;
    if (job->buffer) {
        const NSUInteger length = CFDataGetLength(job->buffer);
        if (length > 0) {
            output = [NSData dataWithBytes:CFDataGetBytePtr(job->buffer)
                                    length:length];
        }
        CFRelease(job->buffer);
        job->buffer = nullptr;
    }

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
    if (job->chunkIndex >= job->chunks.size()) {
        pdfFinish(job, web);
        return;
    }
    const std::pair<double, double> band = job->chunks[job->chunkIndex];
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
                   if (!pdfDrawChunk(job, data, bandTop, bandBottom)) {
                       pdfAbort(job, web, "导出失败：文档过长，无法分页导出");
                       return;
                   }
                   job->chunkIndex++;
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

} // namespace

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

namespace {

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

            const CGRect mediaBox = CGRectMake(0, 0, kPdfPageW, kPdfPageH);
            job->buffer = CFDataCreateMutable(kCFAllocatorDefault, 0);
            CGDataConsumerRef consumer = job->buffer
                ? CGDataConsumerCreateWithCFData(job->buffer)
                : nullptr;
            if (consumer) {
                job->ctx = CGPDFContextCreate(consumer, &mediaBox, NULL);
                CGDataConsumerRelease(consumer);
            }
            if (!job->ctx) {
                pdfAbort(job, webView, "导出失败：无法生成 PDF");
                return;
            }
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

} // namespace
