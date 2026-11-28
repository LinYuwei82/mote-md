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
    // 每页一份 createPDF（内容干净）；再抓一份超高页用于提取超集字体
    std::vector<NSData *> pagePDFs;
    std::vector<std::pair<double, double>> fontChunks;
    std::vector<NSData *> fontPDFs;
    double width = 0;
    double height = 0;
    size_t chunkIndex = 0;
    size_t fontIndex = 0;
    int pageCount = 0;
    bool aborted = false;
    std::function<void(bool, const std::string &)> completion;
};

void pdfAbort(PdfJob *job, WKWebView *web, const std::string &message)
{
    if (job->aborted)
        return;
    job->aborted = true;
    [web evaluateJavaScript:@"window.mote && window.mote.pdfEnd()" completionHandler:nil];
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
    // 每页单独 createPDF：内容流只含本页内容，文本层干净。
    std::vector<std::pair<double, double>> chunks;
    chunks.reserve(pages.size());
    for (const PdfPage &page : pages)
        chunks.emplace_back(page.top, page.bottom);
    return chunks;
}

// 取一份覆盖整篇的 createPDF，只用来提取“超集字体”：拼装时同族字体只嵌入一次
std::vector<std::pair<double, double>> pdfFontChunks(const std::vector<PdfPage> &pages)
{
    // 中间产物不落盘，可以超过 PDF 单页 14400pt 的限制，尽量一次拿全篇字体
    const double kFontChunkPx = 200000.0;
    std::vector<std::pair<double, double>> chunks;
    double top = -1;
    double bottom = -1;
    for (const PdfPage &page : pages) {
        if (top < 0) {
            top = page.top;
            bottom = page.bottom;
            continue;
        }
        if (page.bottom - top > kFontChunkPx) {
            chunks.emplace_back(top, bottom);
            top = page.top;
            bottom = page.bottom;
        } else {
            bottom = page.bottom;
        }
    }
    if (top >= 0)
        chunks.emplace_back(top, bottom);
    return chunks;
}

