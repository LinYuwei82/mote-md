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

