#include "pdf_export.h"

#include <algorithm>
#include <cstdlib>

namespace {

// A4 内容区宽 8.27in - 2*51pt = 6.85in，约 658 CSS px（96dpi）。
// 正文比它宽时整体缩小，避免右侧被裁；窄正文保持 100%。
constexpr double kA4ContentPx = 658.0;

std::string unquote_json(const std::string &text)
{
    if (text.size() < 2 || text.front() != '"')
        return text;
    std::string out;
    out.reserve(text.size());
    for (size_t i = 1; i + 1 < text.size(); ++i) {
        if (text[i] == '\\' && i + 2 < text.size()) {
            ++i;
            out.push_back(text[i] == 'n' ? '\n' : text[i]);
        } else {
            out.push_back(text[i]);
        }
    }
    return out;
}

double json_number(const std::string &json, const char *key)
{
    const std::string needle = std::string("\"") + key + "\":";
    const size_t at = json.find(needle);
    if (at == std::string::npos)
        return 0.0;
    return std::atof(json.c_str() + at + needle.size());
}

} // namespace

void MoteExportPdf(const PdfHost &host, const std::string &path,
                   std::function<void(bool, const std::string &)> done)
{
    if (!host.evaluate || !host.print || path.empty()) {
        if (done)
            done(false, "导出失败：页面还没准备好");
        return;
    }

    host.evaluate("window.mote && window.mote.pdfBegin()",
                  [host, path, done](bool ok, const std::string &result) {
                      const std::string json = ok ? unquote_json(result) : std::string();
                      const double width = json_number(json, "w");
                      const double height = json_number(json, "h");
                      if (width < 10 || height < 10) {
                          host.evaluate("window.mote && window.mote.pdfEnd()", {});
                          if (done)
                              done(false, "导出失败：没有可导出的正文");
                          return;
                      }
                      const double scale = std::min(1.0, kA4ContentPx / width);
                      host.print(path, scale, [host, done](bool success) {
                          // 失败路径也必须还原外壳，页面不能停在导出态
                          host.evaluate("window.mote && window.mote.pdfEnd()", {});
                          if (done) {
                              if (success)
                                  done(true, std::string());
                              else
                                  done(false, "导出失败：无法生成 PDF");
                          }
                      });
                  });
}
