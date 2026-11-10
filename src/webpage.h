#ifndef WEBPAGE_H
#define WEBPAGE_H

#include <QString>

// macOS / Windows 两个宿主共用的页面装配：
// 把 qrc 里的前端资源（editor.html/css/js 与内置代码字体）内联成一整页。
QString motePageHtml();

// 把字符串编码成 JSON 字面量（含引号），用于安全嵌进 evaluateJavaScript /
// ExecuteScript 的脚本里。
QString moteJsonLiteral(const QString &text);

#endif // WEBPAGE_H
