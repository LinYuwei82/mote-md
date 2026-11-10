#ifndef PREVIEWVIEW_H
#define PREVIEWVIEW_H

#include <QFont>
#include <QHash>
#include <QTextBrowser>

QT_BEGIN_NAMESPACE
class QTextDocument;
QT_END_NAMESPACE

namespace MarkdownViewer {

// 代码块行号栏的几何，全部以行号字体的空格宽度为单位，随缩放自动成比例
namespace CodeGutter {

// 行号右端到代码左端的净距
constexpr qreal GapSpaces = 3.0;
// 行号左端到行号栏左边缘的内缩（代码块内边距之外再加一点）
constexpr qreal LeadSpaces = 1.0;
// 分隔线到代码左端的距离，小于 GapSpaces，线更靠近代码一侧
constexpr qreal SeparatorFromCodeSpaces = 1.7;

} // namespace CodeGutter

// 预览控件。代码块行号不写进 QTextDocument，而是在 paintEvent 里按行框几何
// 单独绘制：行号不参与文本排版（等宽对齐、行距、背景都不受影响），也不属于
// 可选中文本，复制时不会带进剪贴板。
class PreviewView : public QTextBrowser
{
    Q_OBJECT

public:
    explicit PreviewView(QWidget *parent = nullptr);

    // 行号字体（等宽、Light、字号略小于代码）；为空时不画行号
    void setLineNumberFont(const QFont &font);

protected:
    void paintEvent(QPaintEvent *event) override;

private:
    void rebuildLineNumbers() const;

    QFont m_lineNumberFont;
    mutable QHash<int, int> m_lineNumbers; // blockNumber -> 逻辑行号（每个代码块从 1 起）
    mutable const QTextDocument *m_numberedDocument = nullptr;
};

} // namespace MarkdownViewer

#endif // PREVIEWVIEW_H
