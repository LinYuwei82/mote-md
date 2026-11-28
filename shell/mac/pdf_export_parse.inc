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

