#include "previewview.h"

#include <QAbstractTextDocumentLayout>
#include <QPainter>
#include <QScrollBar>
#include <QTextBlock>
#include <QTextDocument>
#include <QTextFrame>
#include <QTextLayout>

namespace MarkdownViewer {

namespace {

const QColor kLineNumberColor(0x9a, 0xa3, 0xad);
const QColor kGutterSeparatorColor(0xd9, 0xde, 0xe4);

} // namespace

PreviewView::PreviewView(QWidget *parent)
    : QTextBrowser(parent)
{
}

void PreviewView::setLineNumberFont(const QFont &font)
{
    m_lineNumberFont = font;
    update();
}

void PreviewView::rebuildLineNumbers() const
{
    m_lineNumbers.clear();

    const QTextDocument *doc = document();
    int number = 0;
    for (QTextBlock block = doc->begin(); block.isValid(); block = block.next()) {
        // 只有被包进代码 frame 的 nonBreakableLines 块才是代码块
        if (!block.blockFormat().nonBreakableLines()
            || doc->frameAt(block.position()) == doc->rootFrame()) {
            number = 0;
            continue;
        }
        m_lineNumbers.insert(block.blockNumber(), ++number);
    }
    m_numberedDocument = doc;
}

void PreviewView::paintEvent(QPaintEvent *event)
{
    QTextBrowser::paintEvent(event);

    QTextDocument *doc = document();
    QAbstractTextDocumentLayout *layout = doc ? doc->documentLayout() : nullptr;
    if (!layout || m_lineNumberFont.pointSizeF() <= 0)
        return;

    if (m_numberedDocument != doc)
        rebuildLineNumbers();
    if (m_lineNumbers.isEmpty())
        return;

    const int scrollY = verticalScrollBar()->value();
    // 从视口顶部所在的字符往下找可见块，避免每帧遍历整篇文档
    int position = layout->hitTest(QPointF(qMax<qreal>(1, doc->documentMargin()), scrollY + 2),
                                   Qt::FuzzyHit);
    if (position < 0)
        position = 0;
    QTextBlock block = doc->findBlock(position);

    QPainter painter(viewport());
    painter.setFont(m_lineNumberFont);

    const QFontMetricsF numberMetrics(m_lineNumberFont);
    const qreal space = numberMetrics.horizontalAdvance(QLatin1Char(' '));
    const qreal gap = space * CodeGutter::GapSpaces;
    const qreal viewportBottom = scrollY + viewport()->height();

    QVector<QTextFrame *> drawnFrames;
    for (; block.isValid(); block = block.next()) {
        const QRectF blockRect = layout->blockBoundingRect(block);
        if (blockRect.top() > viewportBottom)
            break;
        if (blockRect.bottom() < scrollY)
            continue;

        const int number = m_lineNumbers.value(block.blockNumber());
        if (number <= 0)
            continue;

        // 行框几何用光标矩形取：它已经是视口坐标，且随滚动条自动平移；
        // 基线再加首行的 ascent，比例行高多出来的空间只落在行框下方，不受影响。
        const QTextCursor cursor(block);
        const QRectF lineRect = cursorRect(cursor);
        if (!lineRect.isValid())
            continue;

        // 行号栏与代码之间的竖线：每个代码块只画一条，从 frame 内容区的上端
        // 延伸到下端（向内缩掉 padding 与 margin），因此不会缺一截、也不会
        // 溢出浅灰底；首末行在视口外时同样正确。
        QTextFrame *frame = doc->frameAt(block.position());
        if (frame && frame != doc->rootFrame() && !drawnFrames.contains(frame)) {
            drawnFrames.append(frame);
            const QTextFrameFormat frameFormat = frame->frameFormat();
            const QRectF frameRect = layout->frameBoundingRect(frame);
            const qreal top = frameRect.top() + frameFormat.topMargin() + frameFormat.padding()
                - scrollY;
            const qreal bottom = frameRect.bottom() - frameFormat.bottomMargin()
                - frameFormat.padding() - scrollY;
            const qreal separatorX = lineRect.left() - space * CodeGutter::SeparatorFromCodeSpaces;
            painter.fillRect(QRectF(separatorX, top, 1.0, bottom - top), kGutterSeparatorColor);
        }

        const QTextLayout *blockLayout = block.layout();
        const QTextLine line = blockLayout ? blockLayout->lineAt(0) : QTextLine();
        const qreal baseline = lineRect.top() + (line.isValid() ? line.ascent()
                                                               : numberMetrics.ascent());

        const QString label = QString::number(number);
        const qreal labelWidth = numberMetrics.horizontalAdvance(label);
        painter.setPen(kLineNumberColor);
        painter.drawText(QPointF(lineRect.left() - gap - labelWidth, baseline), label);
    }
}

} // namespace MarkdownViewer
