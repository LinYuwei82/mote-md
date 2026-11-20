#pragma once

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <functional>
#include <string>

// 把页面渲染态整篇正文导出为 A4 矢量 PDF：
// 页面先 pdfBegin() 进入导出态并给出安全切点，这里按切点排页、分段抓取、再拼成 A4 页。
// completion 在主线程回调；成功时 message 为空。
void MoteExportPdf(WKWebView *webView, const std::string &path,
                   std::function<void(bool ok, const std::string &message)> completion);
