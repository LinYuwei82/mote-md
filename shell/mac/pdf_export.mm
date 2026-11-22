#import "pdf_export.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <regex>
#include <set>
#include <string>
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

// ---------- 组装：把每页 createPDF 结果复制成 A4 页 ----------
// 每页保留自己的内容流（文本层干净），但字体程序换成整篇的超集、按字体族
// 只嵌入一次，因此体积接近 Typora；这是两遍导出：先逐页抓内容，再抓一遍
// 全篇取超集字体。

static void pdfSkipWS(const std::string &s, size_t &i)
{
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n'))
        ++i;
}

static bool pdfReadInt(const std::string &s, size_t &i, long long &v)
{
    pdfSkipWS(s, i);
    if (i >= s.size() || !isdigit((unsigned char)s[i]))
        return false;
    v = 0;
    while (i < s.size() && isdigit((unsigned char)s[i]))
        v = v * 10 + (s[i++] - '0');
    return true;
}

struct PdfChunkInfo {
    std::map<int, std::string> bodies;
    int pageNum = 0;
};

static bool pdfParseChunk(NSData *data, PdfChunkInfo &out)
{
    const std::string text((const char *)data.bytes, data.length);
    const size_t sx = text.rfind("startxref");
    if (sx == std::string::npos)
        return false;
    size_t i = sx + 9;
    long long xref = 0;
    if (!pdfReadInt(text, i, xref) || xref <= 0 || (size_t)xref >= text.size())
        return false;

    size_t q = (size_t)xref;
    if (text.compare(q, 4, "xref") != 0)
        return false;
    q += 4;

    std::map<int, size_t> offsets;
    while (true) {
        pdfSkipWS(text, q);
        if (q >= text.size())
            return false;
        if (text.compare(q, 7, "trailer") == 0)
            break;
        long long start = 0, count = 0;
        if (!pdfReadInt(text, q, start) || !pdfReadInt(text, q, count))
            return false;
        for (long long k = 0; k < count; ++k) {
            long long off = 0, gen = 0;
            char type = 0;
            if (!pdfReadInt(text, q, off) || !pdfReadInt(text, q, gen))
                return false;
            pdfSkipWS(text, q);
            if (q >= text.size())
                return false;
            type = text[q++];
            while (q < text.size() && text[q] != '\n')
                ++q;
            if (type == 'n')
                offsets[(int)(start + k)] = (size_t)off;
        }
    }

    const size_t trailerEnd = text.find("startxref", q);
    if (trailerEnd == std::string::npos)
        return false;
    const std::string trailer = text.substr(q, trailerEnd - q);
    if (trailer.find("/Prev") != std::string::npos)
        return false; // 不处理增量更新

    for (const auto &kv : offsets) {
        const size_t off = kv.second;
        if (off == 0 || off >= text.size())
            continue;
        size_t next = text.size();
        for (const auto &other : offsets)
            if (other.second > off && other.second < next)
                next = other.second;
        const std::string raw = text.substr(off, next - off);
        const size_t obj = raw.find("obj");
        if (obj == std::string::npos)
            continue;
        std::string body = raw.substr(obj + 3);
        const size_t end = body.rfind("endobj");
        if (end != std::string::npos)
            body.erase(end);
        while (!body.empty() && isspace((unsigned char)body.front()))
            body.erase(body.begin());
        while (!body.empty() && isspace((unsigned char)body.back()))
            body.pop_back();
        if (body.empty())
            continue;
        out.bodies[kv.first] = body;
        if (out.pageNum == 0) {
            static const std::regex pageType("/Type\\s*/Page(?!s)");
            if (std::regex_search(body, pageType))
                out.pageNum = kv.first;
        }
    }
    return out.pageNum != 0;
}

static std::string pdfRewriteRefs(const std::string &s, const std::map<int, int> &remap)
{
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size();) {
        if (!isdigit((unsigned char)s[i])) {
            out += s[i++];
            continue;
        }
        size_t j = i;
        while (j < s.size() && isdigit((unsigned char)s[j]))
            ++j;
        const int num = atoi(s.substr(i, j - i).c_str());
        size_t k = j;
        while (k < s.size() && isspace((unsigned char)s[k]))
            ++k;
        if (k < s.size() && s[k] == '0') {
            size_t m = k + 1;
            while (m < s.size() && isspace((unsigned char)s[m]))
                ++m;
            if (m < s.size() && s[m] == 'R') {
                const auto it = remap.find(num);
                out += std::to_string(it == remap.end() ? num : it->second);
                out += " 0 R";
                i = m + 1;
                continue;
            }
        }
        out.append(s, i, j - i);
        i = j;
    }
    return out;
}

static std::string pdfFmt(double v)
{
    char buf[64];
    snprintf(buf, sizeof(buf), "%.2f", v);
    return buf;
}

// 记录一页 createPDF 的结果
bool pdfStorePage(PdfJob *job, NSData *data)
{
    if (++job->pageCount > kPdfMaxPages)
        return false;
    job->pagePDFs.push_back(data);
    return true;
}

// 从一段 PDF 里取：字体族（去掉子集前缀）→ 字体程序（FontFile*）的原始对象体
static void pdfCollectFonts(NSData *data, std::map<std::string, std::string> &out)
{
    PdfChunkInfo info;
    if (!pdfParseChunk(data, info))
        return;
    static const std::regex nameRe("/FontName\\s*/([A-Za-z0-9+._-]+)");
    static const std::regex fileRe("/(FontFile3|FontFile2|FontFile)\\s+(\\d+)\\s+0\\s+R");
    for (const auto &kv : info.bodies) {
        std::smatch nm;
        if (!std::regex_search(kv.second, nm, nameRe))
            continue;
        std::smatch fm;
        if (!std::regex_search(kv.second, fm, fileRe))
            continue;
        std::string name = nm[1].str();
        const size_t plus = name.find('+');
        if (plus != std::string::npos)
            name = name.substr(plus + 1);
        const auto it = info.bodies.find(atoi(fm[2].str().c_str()));
        if (it != info.bodies.end() && out.find(name) == out.end())
            out[name] = it->second;
    }
}

static NSData *pdfAssemble(PdfJob *job)
{
    std::string out = "%PDF-1.3\n%\xE2\xE3\xCF\xD3\n";
    std::map<int, std::string> objects;
    int nextNum = 1;
    const int pagesNum = nextNum++;
    std::vector<int> pageRefs;

    std::vector<std::map<std::string, std::string>> groupFonts;
    for (NSData *data : job->fontPDFs) {
        std::map<std::string, std::string> fonts;
        pdfCollectFonts(data, fonts);
        groupFonts.push_back(fonts);
    }
    std::map<std::pair<int, std::string>, int> groupFontObj;

    static const std::regex mbRe("/MediaBox\\s*\\[\\s*([-0-9.]+)\\s+([-0-9.]+)\\s+([-0-9.]+)\\s+([-0-9.]+)\\s*\\]");
    static const std::regex resRe("/Resources\\s+(\\d+)\\s+0\\s+R");
    static const std::regex contArrRe("/Contents\\s*\\[([^\\]]*)\\]");
    static const std::regex contOneRe("/Contents\\s+(\\d+)\\s+0\\s+R");
    static const std::regex refRe("(\\d+)\\s+0\\s+R");
    static const std::regex descFileRe("/(FontFile3|FontFile2|FontFile)\\s+(\\d+)\\s+0\\s+R");
    static const std::regex descNameRe("/FontName\\s*/([A-Za-z0-9+._-]+)");
    static const std::regex skipRe("/Type\\s*/(Pages|Catalog|Annot)\\b");

    auto groupOfPage = [&](const PdfPage &page) -> int {
        for (size_t g = 0; g < job->fontChunks.size(); ++g) {
            if (page.top >= job->fontChunks[g].first - 0.5
                && page.bottom <= job->fontChunks[g].second + 0.5)
                return (int)g;
        }
        return -1;
    };

    for (size_t pi = 0; pi < job->pagePDFs.size() && pi < job->pages.size(); ++pi) {
        PdfChunkInfo info;
        if (!pdfParseChunk(job->pagePDFs[pi], info))
            return nil;
        const std::string &pageBody = info.bodies[info.pageNum];
        double pageW = 0, pageH = 0;
        std::smatch m;
        if (std::regex_search(pageBody, m, mbRe)) {
            pageW = atof(m[3].str().c_str()) - atof(m[1].str().c_str());
            pageH = atof(m[4].str().c_str()) - atof(m[2].str().c_str());
        }
        if (pageW <= 0 || pageH <= 0)
            return nil;

        int resNum = 0;
        if (std::regex_search(pageBody, m, resRe))
            resNum = atoi(m[1].str().c_str());
        std::vector<int> contentNums;
        if (std::regex_search(pageBody, m, contArrRe)) {
            const std::string arr = m[1].str();
            for (auto it = std::sregex_iterator(arr.begin(), arr.end(), refRe);
                 it != std::sregex_iterator(); ++it)
                contentNums.push_back(atoi((*it)[1].str().c_str()));
        } else if (std::regex_search(pageBody, m, contOneRe)) {
            contentNums.push_back(atoi(m[1].str().c_str()));
        }
        if (contentNums.empty() || resNum == 0)
            return nil;

        const int g = groupOfPage(job->pages[pi]);
        const std::map<std::string, std::string> *group =
            (g >= 0 && (size_t)g < groupFonts.size()) ? &groupFonts[(size_t)g] : nullptr;

        std::map<int, std::string> pageFontFiles;
        for (const auto &kv : info.bodies) {
            std::smatch fm;
            if (!std::regex_search(kv.second, fm, descFileRe))
                continue;
            std::smatch nm;
            if (!std::regex_search(kv.second, nm, descNameRe))
                continue;
            std::string name = nm[1].str();
            const size_t plus = name.find('+');
            if (plus != std::string::npos)
                name = name.substr(plus + 1);
            pageFontFiles[atoi(fm[2].str().c_str())] = name;
        }

        std::map<int, int> remap;
        std::set<int> redirected;
        for (const auto &kv : info.bodies) {
            const int oldNum = kv.first;
            const auto ff = pageFontFiles.find(oldNum);
            if (ff != pageFontFiles.end() && group) {
                const auto fit = group->find(ff->second);
                if (fit != group->end()) {
                    const auto key = std::make_pair(g, ff->second);
                    auto gfo = groupFontObj.find(key);
                    if (gfo == groupFontObj.end()) {
                        const int num = nextNum++;
                        objects[num] = fit->second;
                        gfo = groupFontObj.emplace(key, num).first;
                    }
                    remap[oldNum] = gfo->second;
                    redirected.insert(oldNum);
                    continue;
                }
            }
            remap[oldNum] = nextNum++;
        }

        for (const auto &kv : info.bodies) {
            if (redirected.count(kv.first))
                continue;
            const std::string &body = kv.second;
            const int newNum = remap[kv.first];
            bool skip = (kv.first == info.pageNum) || std::regex_search(body, skipRe);
            if (skip) {
                objects[newNum] = "null";
                continue;
            }
            const size_t streamPos = body.find("stream");
            if (streamPos == std::string::npos)
                objects[newNum] = pdfRewriteRefs(body, remap);
            else
                objects[newNum] = pdfRewriteRefs(body.substr(0, streamPos), remap)
                                + body.substr(streamPos);
        }

        const double s = job->pages[pi].scale;
        // createPDF 的页盒可能比请求的分段高度略高（有取整余量），
        // 多出的空白在盒底部、正文贴着盒顶；先把它抬回，再按内容区顶部对齐。
        const double bandH = job->pages[pi].bottom - job->pages[pi].top;
        const double lift = pageH - bandH;
        const double outH = bandH * s;
        const double ty = kPdfMarginBottom + kPdfContentH - outH;
        const std::string prefix = "q " + pdfFmt(s) + " 0 0 " + pdfFmt(s) + " "
                                 + pdfFmt(kPdfMarginLeft) + " " + pdfFmt(ty) + " cm\n"
                                 + "1 0 0 1 0 " + pdfFmt(-lift) + " cm\n";
        const int scaleNum = nextNum++;
        const int restoreNum = nextNum++;
        objects[scaleNum] = "<< /Length " + std::to_string(prefix.size()) + " >>\nstream\n"
                          + prefix + "endstream";
        objects[restoreNum] = "<< /Length 2 >>\nstream\nQ\nendstream";

        std::string contents = "[ " + std::to_string(scaleNum) + " 0 R";
        for (int c : contentNums)
            contents += " " + std::to_string(remap[c]) + " 0 R";
        contents += " " + std::to_string(restoreNum) + " 0 R ]";
        const std::string body = "<< /Type /Page /Parent " + std::to_string(pagesNum)
            + " 0 R /MediaBox [0 0 " + pdfFmt(kPdfPageW) + " " + pdfFmt(kPdfPageH)
            + "] /Resources " + std::to_string(remap[resNum]) + " 0 R /Contents "
            + contents + " >>";
        const int pageNum = nextNum++;
        objects[pageNum] = body;
        pageRefs.push_back(pageNum);
    }

    if (pageRefs.empty())
        return nil;

    std::string kids = "[";
    for (int r : pageRefs)
        kids += " " + std::to_string(r) + " 0 R";
    kids += " ]";
    objects[pagesNum] = "<< /Type /Pages /Count " + std::to_string(pageRefs.size())
                      + " /Kids " + kids + " >>";
    const int catalogNum = nextNum++;
    objects[catalogNum] = "<< /Type /Catalog /Pages " + std::to_string(pagesNum) + " 0 R >>";

    std::vector<size_t> offsets((size_t)nextNum, 0);
    for (int n = 1; n < nextNum; ++n) {
        const auto it = objects.find(n);
        if (it == objects.end())
            continue;
        offsets[(size_t)n] = out.size();
        out += std::to_string(n) + " 0 obj\n" + it->second + "\nendobj\n";
    }
    const size_t xrefOff = out.size();
    out += "xref\n0 " + std::to_string(nextNum) + "\n";
    out += "0000000000 65535 f \n";
    for (int n = 1; n < nextNum; ++n) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%010zu 00000 n \n", offsets[(size_t)n]);
        out += buf;
    }
    out += "trailer\n<< /Size " + std::to_string(nextNum) + " /Root "
         + std::to_string(catalogNum) + " 0 R >>\nstartxref\n" + std::to_string(xrefOff)
         + "\n%%EOF\n";

    return [NSData dataWithBytes:out.data() length:out.size()];
}

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

} // namespace
