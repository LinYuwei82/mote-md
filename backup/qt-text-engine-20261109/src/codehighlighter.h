#ifndef CODEHIGHLIGHTER_H
#define CODEHIGHLIGHTER_H

class QTextDocument;

namespace MarkdownViewer {

// 按代码围栏的语言标识给文档里的代码块上色。
// 只改字符前景色，字体与背景沿用 styleDocument 里设置的等宽字体和浅灰底色；
// 语言标识缺失或无法识别时不做任何处理。
void applySyntaxHighlighting(QTextDocument *doc);

} // namespace MarkdownViewer

#endif // CODEHIGHLIGHTER_H
