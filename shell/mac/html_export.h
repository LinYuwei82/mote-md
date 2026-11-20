#pragma once

#import <Cocoa/Cocoa.h>

// 把导出 HTML 中指向本地的 <img src> 内联为 data URI，保证单文件可分享。
// baseDir 是 .md 所在目录；读取失败的图片替换为缺失提示并计入 missingCount。
NSString *MoteInlineLocalImages(NSString *html, NSString *baseDir, int *missingCount);
