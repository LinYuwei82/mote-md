#pragma once

#include <functional>
#include <string>

// Windows PDF 导出（阶段 B N4）：先调页面 pdfBegin() 隐藏外壳，再按 A4 打印，
// 完成或失败都调 pdfEnd() 还原。主机能力由外壳注入，便于复用与测试。
struct PdfHost {
    std::function<void(const std::string &script,
                       std::function<void(bool, const std::string &)>)>
        evaluate;
    std::function<void(const std::string &path, double scale, std::function<void(bool)>)>
        print;
};

void MoteExportPdf(const PdfHost &host, const std::string &path,
                   std::function<void(bool, const std::string &)> done);
