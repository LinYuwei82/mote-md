#include "mainwindow.h"

#include "codehighlighter.h"
#include "previewview.h"

#include <QAction>
#include <QAbstractTextDocumentLayout>
#include <QApplication>
#include <QCloseEvent>
#include <QDesktopServices>
#include <QDir>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QElapsedTimer>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QFontDatabase>
#include <QHash>
#include <QLabel>
#include <QMessageBox>
#include <QMimeData>
#include <QPlainTextEdit>
#include <QPointer>
#include <QSaveFile>
#include <QScreen>
#include <QScrollBar>
#include <QSplitter>
#include <QStackedWidget>
#include <QStatusBar>
#include <QTextBlock>
#include <QTextBlockFormat>
#include <QTextBrowser>
#include <QTextCharFormat>
#include <QTextCursor>
#include <QTextDocument>
#include <QTextDocumentFragment>
#include <QTextFrame>
#include <QTextFrameFormat>
#include <QTextFragment>
#include <QTextTable>
#include <QTimer>
#include <QToolBar>
#include <QTreeWidget>
#include <QTreeWidgetItem>
#include <QVBoxLayout>
#include <cstdio>

namespace MarkdownViewer {

namespace {

// 正文基准字号；缩放、标题层级、代码块字号都以它为基准
constexpr qreal kBasePointSize = 16.5;
constexpr qreal kMinZoom = 0.6;
constexpr qreal kMaxZoom = 2.6;

// 代码字体相对正文的比例；行号再按 kLineNumberScale 缩小，墨色也弱化
constexpr qreal kCodeScale = 0.92;
constexpr qreal kLineNumberScale = 0.86;

const QColor kHeadingColor(0x0f, 0x17, 0x2a);
const QColor kCodeBackground(0xf4, 0xf6, 0xf8);
const QColor kTableBorder(0xd0, 0xd7, 0xde);

bool looksLikeMarkdown(const QString &path)
{
    const QString suffix = QFileInfo(path).suffix().toLower();
    return suffix == QLatin1String("md") || suffix == QLatin1String("markdown")
        || suffix == QLatin1String("mdown") || suffix == QLatin1String("mkd")
        || suffix == QLatin1String("txt");
}

// 仅在设置 MDVIEWER_TIMING=1 时输出分段耗时，用来定位打开慢在哪一段
bool timingEnabled()
{
    static const bool enabled = qEnvironmentVariableIsSet("MDVIEWER_TIMING");
    return enabled;
}

void logPhase(const char *phase, qint64 msec)
{
    if (timingEnabled())
        std::fprintf(stderr, "TIMING %-22s %7.1f ms\n", phase, double(msec));
}

// 代码块与行内代码统一用随包内置的 JetBrains Mono；若字体加载失败
// （资源缺失、系统拒绝加载），依次退回 Menlo / SF Mono / 系统等宽字体。
QString codeFontFamily()
{
    static const QString family = [] {
        const QStringList installed = QFontDatabase::families();
        for (const QString &candidate : {QStringLiteral("JetBrains Mono"),
                                         QStringLiteral("Menlo"),
                                         QStringLiteral("SF Mono")}) {
            if (installed.contains(candidate))
                return candidate;
        }
        return QFontDatabase::systemFont(QFontDatabase::FixedFont).family();
    }();
    return family;
}

// 行号用的字体：与代码同族、Light，字号再小一档；只用于绘制，不参与排版
QFont codeNumberFont(qreal basePointSize)
{
    QFont font;
    font.setFamilies({codeFontFamily()});
    font.setPointSizeF(basePointSize * kCodeScale * kLineNumberScale);
    font.setWeight(QFont::Light);
    return font;
}

// 代码块左侧行号栏的宽度（像素）。行号右对齐，右侧留 GapSpaces 个空格的净距
// （绘制端 PreviewView 用同一常数），左侧再留 LeadSpaces 个空格。
qreal codeGutterWidth(const QFont &numberFont, int lineCount)
{
    const QFontMetricsF metrics(numberFont);
    const int digits = qMax(2, QString::number(lineCount).size());
    return metrics.horizontalAdvance(QLatin1Char('0')) * digits
        + metrics.horizontalAdvance(QLatin1Char(' '))
            * (CodeGutter::LeadSpaces + CodeGutter::GapSpaces);
}

// Qt 的 Markdown 导入在「表格紧跟代码块」时会给单元格多塞一个空块，导致这一格
// 比同行高出半行（看起来像首行内容下沉）。单元格内首块为空且有后续块时删掉它。
void dropLeadingEmptyCellBlocks(QTextTable *table)
{
    for (int row = 0; row < table->rows(); ++row) {
        for (int column = 0; column < table->columns(); ++column) {
            const QTextTableCell cell = table->cellAt(row, column);
            if (cell.firstCursorPosition().block() == cell.lastCursorPosition().block())
                continue;

            QTextCursor cursor = cell.firstCursorPosition();
            const QTextBlock first = cursor.block();
            if (!first.text().isEmpty())
                continue;

            cursor.setPosition(first.position());
            cursor.setPosition(first.next().position(), QTextCursor::KeepAnchor);
            cursor.removeSelectedText();
        }
    }
}

void styleTables(QTextFrame *frame)
{
    for (QTextFrame::iterator it = frame->begin(); !it.atEnd(); ++it) {
        QTextFrame *child = it.currentFrame();
        if (!child)
            continue;

        if (auto *table = qobject_cast<QTextTable *>(child)) {
            QTextTableFormat tableFormat = table->format();
            tableFormat.setBorder(1);
            tableFormat.setBorderBrush(kTableBorder);
            tableFormat.setBorderStyle(QTextFrameFormat::BorderStyle_Solid);
            tableFormat.setCellPadding(6);
            tableFormat.setCellSpacing(0);
            tableFormat.setTopMargin(10);
            tableFormat.setBottomMargin(12);
            table->setFormat(tableFormat);
            dropLeadingEmptyCellBlocks(table);

            // Markdown 表格的首行是表头，加浅色底以便和内容区分
            if (table->rows() > 0) {
                QTextTableCellFormat headerFormat;
                headerFormat.setBackground(QColor(0xf6, 0xf8, 0xfa));
                for (int column = 0; column < table->columns(); ++column)
                    table->cellAt(0, column).setFormat(headerFormat);
            }
        }
        styleTables(child);
    }
}

// Markdown 导入后的代码块是「一行一个 block」，给每个 block 单独上背景时，
// 一旦用 lineHeight 或 margin 拉开行距，额外间距落在背景矩形之外，浅灰底就被切成
// 一条条断层。这里先把连续代码行整体收进一个带背景与内边距的 QTextFrame，
// 行距改由块行高控制，背景始终连续。
void wrapCodeBlocks(QTextDocument *doc)
{
    QList<QPair<int, int>> runs;
    for (QTextBlock block = doc->begin(); block.isValid();) {
        if (!block.blockFormat().nonBreakableLines()
            || doc->frameAt(block.position()) != doc->rootFrame()) {
            block = block.next();
            continue;
        }
        QTextBlock last = block;
        while (last.next().isValid() && last.next().blockFormat().nonBreakableLines())
            last = last.next();
        // 选中范围去掉最后一个块分隔符；最后一个块的位置即使到文档末尾也在合法范围内
        const int end = last.position() + last.length() - 1;
        runs.append({block.position(), end});
        block = last.next();
    }

    // 从后往前处理，前面代码段的字符位置不会被后面插入的 frame 影响
    for (int i = runs.size() - 1; i >= 0; --i) {
        const int start = runs.at(i).first;
        const int end = runs.at(i).second;
        if (end <= start)
            continue;

        QTextCursor cursor(doc);
        cursor.setPosition(start);
        cursor.setPosition(end, QTextCursor::KeepAnchor);
        const QTextDocumentFragment fragment = cursor.selection();
        // 片段首块并进 frame 里预留的空块时，块格式（nonBreakableLines 与代码语言）
        // 会被目标空块的格式覆盖，导致代码块首行没有等宽字体、行号和高亮，这里补回。
        const QTextBlockFormat firstFormat = cursor.blockFormat();
        cursor.removeSelectedText();

        QTextFrameFormat format;
        format.setBackground(kCodeBackground);
        format.setPadding(10);
        format.setMargin(0);
        format.setTopMargin(8);
        format.setBottomMargin(8);
        format.setBorder(0);
        QTextFrame *frame = cursor.insertFrame(format);

        QTextCursor inner = frame->firstCursorPosition();
        inner.insertFragment(fragment);
        // 插入空 frame 时会先留一个空块，删掉它，避免代码块顶部多出一行空白
        QTextBlock first = frame->begin().currentBlock();
        if (first.isValid() && first.text().isEmpty()) {
            QTextCursor empty(first);
            empty.select(QTextCursor::BlockUnderCursor);
            empty.removeSelectedText();
            first = frame->begin().currentBlock();
        }
        if (first.isValid()) {
            QTextCursor firstCursor(first);
            firstCursor.setBlockFormat(firstFormat);
        }
    }
}

// Markdown 导入后的文档只带结构，不含样式：这里统一补上标题字号、代码块底色、表格边框等
void styleDocument(QTextDocument *doc, qreal basePointSize)
{
    const QString monoFamily = codeFontFamily();
    static const qreal headingScale[] = {1.0, 1.62, 1.4, 1.22, 1.12, 1.02, 0.96};
    QElapsedTimer phaseTimer;
    if (timingEnabled())
        phaseTimer.start();

    wrapCodeBlocks(doc);
    logPhase("  codeFrames", phaseTimer.restart());

    // 行号槽宽度按代码块总行数的位数预留；同一块内所有行必须同宽，
    // 否则左边距不一致会把等宽列拆歪
    const QFont numberFont = codeNumberFont(basePointSize);
    QHash<int, qreal> gutters;
    for (QTextBlock block = doc->begin(); block.isValid();) {
        if (!block.blockFormat().nonBreakableLines()) {
            block = block.next();
            continue;
        }
        const QTextBlock runStart = block;
        int lines = 0;
        while (block.isValid() && block.blockFormat().nonBreakableLines()) {
            ++lines;
            block = block.next();
        }
        const qreal gutter = codeGutterWidth(numberFont, lines);
        for (QTextBlock line = runStart;
             line.isValid() && line.blockFormat().nonBreakableLines(); line = line.next())
            gutters.insert(line.blockNumber(), gutter);
    }

    for (QTextBlock block = doc->begin(); block.isValid(); block = block.next()) {
        const QTextBlockFormat original = block.blockFormat();
        QTextBlockFormat blockFormat = original;
        QTextCursor cursor(block);
        const bool insideRootFrame = doc->frameAt(block.position()) == doc->rootFrame();

        if (const int level = original.headingLevel(); level > 0) {
            blockFormat.setTopMargin(level == 1 ? 20 : 16);
            blockFormat.setBottomMargin(level <= 2 ? 10 : 6);
            blockFormat.setLineHeight(100, QTextBlockFormat::ProportionalHeight);
            cursor.setBlockFormat(blockFormat);

            QTextCharFormat charFormat;
            charFormat.setFontPointSize(basePointSize * headingScale[qBound(1, level, 6)]);
            charFormat.setFontWeight(level <= 2 ? QFont::Bold : QFont::DemiBold);
            charFormat.setForeground(kHeadingColor);
            cursor.movePosition(QTextCursor::EndOfBlock, QTextCursor::KeepAnchor);
            cursor.mergeCharFormat(charFormat);
            continue;
        }

        if (original.nonBreakableLines()) { // 代码块（已被包进带背景的 frame）
            // 行高 145%：等宽字体默认行距偏紧，视觉上会「挤」；背景由外层 frame 提供，
            // 这里加出来的行距不会再切断浅灰底。额外行距全落在行框下方，若末行也用
            // 145%，浅灰底下方会明显比上方空（上紧下松），所以末行单独收回到 112%。
            const QTextBlock next = block.next();
            const bool runEnd = !next.isValid() || !next.blockFormat().nonBreakableLines();
            blockFormat.setLineHeight(runEnd ? 112 : 145, QTextBlockFormat::ProportionalHeight);
            blockFormat.setTopMargin(0);
            blockFormat.setBottomMargin(0);
            // 左侧留出行号槽；行号本身由 PreviewView 绘制在槽内，不进入文档
            blockFormat.setLeftMargin(gutters.value(block.blockNumber()));
            blockFormat.setRightMargin(0);
            blockFormat.clearBackground();
            cursor.setBlockFormat(blockFormat);

            QTextCharFormat charFormat;
            charFormat.setFontFamilies({monoFamily});
            charFormat.setFontPointSize(basePointSize * kCodeScale);
            // 代码正文用随包的 Light 真实字面，比正文（PingFang ExtraLight）更细一档，
            // 不靠 Qt 合成变细，避免笔画发虚
            charFormat.setFontWeight(QFont::Light);
            cursor.movePosition(QTextCursor::EndOfBlock, QTextCursor::KeepAnchor);
            cursor.mergeCharFormat(charFormat);
            continue;
        }

        if (insideRootFrame) {
            blockFormat.setLineHeight(148, QTextBlockFormat::ProportionalHeight);
            cursor.setBlockFormat(blockFormat);

            // 行内代码也是等宽字体：先收集范围再统一改，避免边遍历 fragment 边改格式
            QList<QPair<int, int>> codeSpans;
            for (auto it = block.begin(); !it.atEnd(); ++it) {
                const QTextFragment fragment = it.fragment();
                if (fragment.isValid() && fragment.charFormat().fontFixedPitch())
                    codeSpans.append({fragment.position(), fragment.length()});
            }
            for (const auto &span : codeSpans) {
                QTextCursor codeCursor(block);
                codeCursor.setPosition(span.first);
                codeCursor.setPosition(span.first + span.second, QTextCursor::KeepAnchor);
                QTextCharFormat monoFormat;
                monoFormat.setFontFamilies({monoFamily});
                monoFormat.setFontWeight(QFont::Normal);
                codeCursor.mergeCharFormat(monoFormat);
            }
        }
    }

    styleTables(doc->rootFrame());
    logPhase("  styleTables", phaseTimer.restart());
    // 代码块的结构（等宽字体 + 浅灰底）已就绪，再按围栏语言补前景色
    applySyntaxHighlighting(doc);
    logPhase("  highlight", phaseTimer.restart());
}

} // namespace

MainWindow::MainWindow(QWidget *parent)
    : QMainWindow(parent)
{
    setAcceptDrops(true);
    setMinimumSize(680, 460);

    if (const QScreen *screen = QApplication::primaryScreen()) {
        const QRect available = screen->availableGeometry();
        resize(qMin(1180, int(available.width() * 0.92)),
               qMin(820, int(available.height() * 0.92)));
    } else {
        resize(1180, 820);
    }

    createActions();
    createUi();
    loadBuiltinSample();
}

void MainWindow::createActions()
{
    m_openAction = new QAction(tr("打开"), this);
    m_openAction->setShortcut(QKeySequence::Open);
    connect(m_openAction, &QAction::triggered, this, &MainWindow::openFileDialog);

    m_saveAction = new QAction(tr("保存"), this);
    m_saveAction->setShortcut(QKeySequence::Save);
    connect(m_saveAction, &QAction::triggered, this, &MainWindow::handleSave);

    m_saveAsAction = new QAction(tr("另存为"), this);
    m_saveAsAction->setShortcut(QKeySequence::SaveAs);
    connect(m_saveAsAction, &QAction::triggered, this, &MainWindow::handleSaveAs);

    m_editAction = new QAction(tr("编辑"), this);
    m_editAction->setCheckable(true);
    m_editAction->setShortcut(QKeySequence(QStringLiteral("Ctrl+E")));
    m_editAction->setToolTip(tr("在预览和编辑之间切换 (Ctrl+E)"));
    connect(m_editAction, &QAction::toggled, this, &MainWindow::handleToggleEdit);

    m_tocAction = new QAction(tr("目录"), this);
    m_tocAction->setCheckable(true);
    m_tocAction->setChecked(true);
    m_tocAction->setToolTip(tr("显示或隐藏左侧目录"));

    m_zoomInAction = new QAction(tr("放大"), this);
    m_zoomInAction->setShortcuts({QKeySequence::ZoomIn,
                                  QKeySequence(QStringLiteral("Ctrl+=")),
                                  QKeySequence(QStringLiteral("Ctrl++"))});
    connect(m_zoomInAction, &QAction::triggered, this, &MainWindow::handleZoomIn);

    m_zoomOutAction = new QAction(tr("缩小"), this);
    m_zoomOutAction->setShortcuts({QKeySequence::ZoomOut,
                                   QKeySequence(QStringLiteral("Ctrl+-"))});
    connect(m_zoomOutAction, &QAction::triggered, this, &MainWindow::handleZoomOut);

    m_zoomResetAction = new QAction(tr("重置"), this);
    m_zoomResetAction->setShortcut(QKeySequence(QStringLiteral("Ctrl+0")));
    m_zoomResetAction->setToolTip(tr("恢复默认字号 (Ctrl+0)"));
    connect(m_zoomResetAction, &QAction::triggered, this, &MainWindow::handleZoomReset);
}

void MainWindow::createUi()
{
    auto *toolBar = addToolBar(tr("工具栏"));
    toolBar->setMovable(false);
    toolBar->setToolButtonStyle(Qt::ToolButtonTextOnly);
    toolBar->addAction(m_openAction);
    toolBar->addAction(m_saveAction);
    toolBar->addAction(m_saveAsAction);
    toolBar->addSeparator();
    toolBar->addAction(m_editAction);
    toolBar->addSeparator();
    toolBar->addAction(m_zoomOutAction);
    toolBar->addAction(m_zoomResetAction);
    toolBar->addAction(m_zoomInAction);
    toolBar->addSeparator();
    toolBar->addAction(m_tocAction);

    m_tocPanel = new QWidget(this);
    m_tocPanel->setObjectName(QStringLiteral("TocPanel"));
    auto *tocLayout = new QVBoxLayout(m_tocPanel);
    tocLayout->setContentsMargins(0, 0, 0, 0);
    tocLayout->setSpacing(0);

    auto *tocTitle = new QLabel(tr("目录"), m_tocPanel);
    tocTitle->setObjectName(QStringLiteral("TocTitle"));

    m_toc = new QTreeWidget(m_tocPanel);
    m_toc->setHeaderHidden(true);
    m_toc->setColumnCount(1);
    m_toc->setIndentation(16);
    m_toc->setUniformRowHeights(true);
    m_toc->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    m_toc->setTextElideMode(Qt::ElideRight);
    m_toc->setFrameShape(QFrame::NoFrame);
    connect(m_toc, &QTreeWidget::itemClicked, this, &MainWindow::handleTocItemClicked);

    tocLayout->addWidget(tocTitle);
    tocLayout->addWidget(m_toc, 1);

    m_tocPanel->setMinimumWidth(180);
    m_tocPanel->setMaximumWidth(460);

    m_preview = new PreviewView(this);
    m_preview->setObjectName(QStringLiteral("Preview"));
    m_preview->setFrameShape(QFrame::NoFrame);
    m_preview->setOpenLinks(false);
    m_preview->setOpenExternalLinks(false);
    m_preview->setAcceptDrops(false);
    m_preview->document()->setDocumentMargin(28);
    connect(m_preview, &QTextBrowser::anchorClicked, this, &MainWindow::handleAnchorClicked);

    const QFont fixedFont = QFontDatabase::systemFont(QFontDatabase::FixedFont);
    m_editor = new QPlainTextEdit(this);
    m_editor->setObjectName(QStringLiteral("Editor"));
    m_editor->setFrameShape(QFrame::NoFrame);
    m_editor->setLineWrapMode(QPlainTextEdit::WidgetWidth);
    m_editor->setAcceptDrops(false);
    m_editor->setTabChangesFocus(false);
    QFont editorFont = fixedFont;
    editorFont.setPointSizeF(kBasePointSize * 0.95);
    editorFont.setWeight(QFont::Normal);
    m_editor->setFont(editorFont);
    m_editor->setTabStopDistance(QFontMetricsF(editorFont).horizontalAdvance(QLatin1Char(' ')) * 4);
    m_editor->setPlaceholderText(tr("在这里编辑 Markdown 源码…"));
    connect(m_editor, &QPlainTextEdit::textChanged, this, &MainWindow::handleEditorChanged);

    m_stack = new QStackedWidget(this);
    m_stack->addWidget(m_preview);
    m_stack->addWidget(m_editor);
    m_stack->setCurrentWidget(m_preview);

    m_splitter = new QSplitter(Qt::Horizontal, this);
    m_splitter->addWidget(m_tocPanel);
    m_splitter->addWidget(m_stack);
    m_splitter->setStretchFactor(0, 0);
    m_splitter->setStretchFactor(1, 1);
    m_splitter->setChildrenCollapsible(false);
    m_splitter->setSizes({290, 890});

    setCentralWidget(m_splitter);

    connect(m_tocAction, &QAction::toggled, m_tocPanel, &QWidget::setVisible);

    statusBar()->showMessage(tr("就绪 · 可以把 .md 文件拖进窗口打开"));
    updateWindowTitle();
    m_preview->setFocus();
}

void MainWindow::loadBuiltinSample()
{
    QFile file(QStringLiteral(":/samples/welcome.md"));
    if (!file.open(QIODevice::ReadOnly)) {
        m_markdown = tr("# 欢迎\n\n没有找到内置示例文档。\n");
        m_baseUrl = QUrl(QStringLiteral("qrc:/samples/"));
    } else {
        m_markdown = QString::fromUtf8(file.readAll());
        m_baseUrl = QUrl(QStringLiteral("qrc:/samples/"));
    }
    m_filePath.clear();
    renderPreview(true);
    markModified(false);
    updateWindowTitle();
}

void MainWindow::renderPreview(bool resetScroll)
{
    QElapsedTimer phaseTimer;
    if (timingEnabled())
        phaseTimer.start();

    const int savedScroll = resetScroll ? 0 : m_preview->verticalScrollBar()->value();

    // 先在脱离视图的文档里把样式与高亮全部改完，最后一次性交给 QTextBrowser。
    // 挂在视图上的文档每改一次字符格式都会触发控件重排，大文档下会慢到几秒。
    QPointer<QTextDocument> oldDoc = m_preview->document();
    QTextDocument *doc = new QTextDocument(m_preview);
    doc->setUndoRedoEnabled(false);
    doc->setBaseUrl(m_baseUrl);

    // 字体族与字重取自 app 级字体（PingFang SC ExtraLight），这里只按缩放调整字号
    QFont baseFont = QApplication::font();
    baseFont.setPointSizeF(kBasePointSize * m_zoom);
    doc->setDefaultFont(baseFont);
    doc->setDocumentMargin(28);
    doc->setMarkdown(m_markdown, QTextDocument::MarkdownDialectGitHub);
    logPhase("setMarkdown", phaseTimer.restart());
    styleDocument(doc, kBasePointSize * m_zoom);
    logPhase("styleDocument", phaseTimer.restart());
    m_preview->setLineNumberFont(codeNumberFont(kBasePointSize * m_zoom));

    m_preview->setDocument(doc);
    if (oldDoc && oldDoc != doc)
        oldDoc->deleteLater();

    rebuildToc();
    logPhase("rebuildToc", phaseTimer.restart());

    if (savedScroll > 0) {
        QTimer::singleShot(0, this, [this, savedScroll] {
            m_preview->verticalScrollBar()->setValue(savedScroll);
        });
    } else {
        // setMarkdown 之后光标可能落在文档末尾，这里显式回到开头并滚到顶部
        m_preview->moveCursor(QTextCursor::Start);
        m_preview->verticalScrollBar()->setValue(0);
        QTimer::singleShot(0, this, [this] {
            m_preview->moveCursor(QTextCursor::Start);
            m_preview->verticalScrollBar()->setValue(0);
        });
    }

    // 这里顺带把排版跑完，统计「文档真正可以显示」的耗时
    doc->documentLayout()->documentSize();
    logPhase("layout", phaseTimer.restart());
}

void MainWindow::rebuildToc()
{
    m_toc->clear();

    QList<QTreeWidgetItem *> parents(7, nullptr);
    const QTextDocument *doc = m_preview->document();

    for (QTextBlock block = doc->begin(); block.isValid(); block = block.next()) {
        const int level = block.blockFormat().headingLevel();
        if (level <= 0)
            continue;
        const QString title = block.text().trimmed();
        if (title.isEmpty())
            continue;

        auto *item = new QTreeWidgetItem(QStringList(title));
        item->setData(0, Qt::UserRole, block.blockNumber());
        item->setToolTip(0, title);

        QTreeWidgetItem *parent = nullptr;
        for (int parentLevel = level - 1; parentLevel >= 1; --parentLevel) {
            if (parents.at(parentLevel)) {
                parent = parents.at(parentLevel);
                break;
            }
        }
        if (parent)
            parent->addChild(item);
        else
            m_toc->addTopLevelItem(item);

        parents[level] = item;
        for (int deeper = level + 1; deeper < parents.size(); ++deeper)
            parents[deeper] = nullptr;
    }

    if (m_toc->topLevelItemCount() == 0) {
        auto *empty = new QTreeWidgetItem(QStringList(tr("（文档中没有标题）")));
        empty->setFlags(Qt::NoItemFlags);
        empty->setForeground(0, QColor(0x8c, 0x95, 0x9f));
        m_toc->addTopLevelItem(empty);
    }

    m_toc->expandAll();
}

void MainWindow::handleTocItemClicked(QTreeWidgetItem *item, int column)
{
    Q_UNUSED(column)
    if (!item)
        return;
    const QVariant blockNumber = item->data(0, Qt::UserRole);
    if (!blockNumber.isValid())
        return;

    const QTextBlock block = m_preview->document()->findBlockByNumber(blockNumber.toInt());
    if (!block.isValid())
        return;

    QTextCursor cursor(block);
    m_preview->setTextCursor(cursor);
    m_preview->ensureCursorVisible();
    m_preview->setFocus();
}

void MainWindow::applyZoom(qreal newZoom)
{
    const qreal clamped = qBound(kMinZoom, newZoom, kMaxZoom);
    if (qFuzzyCompare(clamped, m_zoom))
        return;
    m_zoom = clamped;

    renderPreview();

    QFont editorFont = QFontDatabase::systemFont(QFontDatabase::FixedFont);
    editorFont.setPointSizeF(kBasePointSize * 0.95 * m_zoom);
    editorFont.setWeight(QFont::Normal);
    m_editor->setFont(editorFont);
    m_editor->setTabStopDistance(QFontMetricsF(editorFont).horizontalAdvance(QLatin1Char(' ')) * 4);

    showStatus(tr("缩放：%1%").arg(qRound(m_zoom * 100)));
}

void MainWindow::setEditing(bool editing)
{
    if (editing == m_editing)
        return;

    if (editing) {
        m_syncingEditor = true;
        m_editor->setPlainText(m_markdown);
        m_syncingEditor = false;
        m_stack->setCurrentWidget(m_editor);
        m_tocPanel->setEnabled(false);
        m_editor->setFocus();
    } else {
        m_markdown = m_editor->toPlainText();
        renderPreview();
        m_stack->setCurrentWidget(m_preview);
        m_tocPanel->setEnabled(true);
    }

    m_editing = editing;
    m_editAction->setChecked(editing);
    showStatus(editing ? tr("编辑模式") : tr("预览模式"));
}

QString MainWindow::currentText() const
{
    return m_editing ? m_editor->toPlainText() : m_markdown;
}

QString MainWindow::displayName() const
{
    if (m_filePath.isEmpty())
        return tr("未命名.md");
    return QFileInfo(m_filePath).fileName();
}

void MainWindow::updateWindowTitle()
{
    setWindowTitle(tr("%1[*] - Mote").arg(displayName()));
    setWindowModified(m_dirty);
}

void MainWindow::markModified(bool modified)
{
    m_dirty = modified;
    setWindowModified(modified);
}

void MainWindow::showStatus(const QString &text)
{
    statusBar()->showMessage(text, 6000);
}

bool MainWindow::openFile(const QString &filePath)
{
    QElapsedTimer totalTimer;
    if (timingEnabled())
        totalTimer.start();

    const QFileInfo info(filePath);
    if (!info.exists() || !info.isFile()) {
        QMessageBox::warning(this, tr("无法打开"),
                             tr("文件不存在：\n%1").arg(filePath));
        return false;
    }

    QFile file(info.absoluteFilePath());
    if (!file.open(QIODevice::ReadOnly)) {
        QMessageBox::warning(this, tr("无法打开"),
                             tr("读取文件失败：\n%1\n%2").arg(filePath, file.errorString()));
        return false;
    }

    QString text = QString::fromUtf8(file.readAll());
    if (!text.isEmpty() && text.at(0) == QChar(0xFEFF))
        text.remove(0, 1);
    logPhase("readFile", totalTimer.restart());

    if (isEditing()) {
        m_editing = false;
        m_editAction->setChecked(false);
        m_tocPanel->setEnabled(true);
        m_stack->setCurrentWidget(m_preview);
    }

    m_markdown = text;
    m_filePath = info.absoluteFilePath();
    m_baseUrl = QUrl::fromLocalFile(info.absolutePath() + QLatin1Char('/'));

    renderPreview(true);
    markModified(false);
    updateWindowTitle();
    showStatus(tr("已打开：%1").arg(m_filePath));
    return true;
}

void MainWindow::openFileDialog()
{
    if (!maybeSave())
        return;
    const QString path = QFileDialog::getOpenFileName(
        this, tr("打开 Markdown 文件"), QDir::homePath(),
        tr("Markdown 文件 (*.md *.markdown *.mdown *.mkd);;文本文件 (*.txt);;所有文件 (*)"));
    if (path.isEmpty())
        return;
    openFile(path);
}

bool MainWindow::saveFile()
{
    if (m_filePath.isEmpty())
        return saveFileAs();
    return saveTo(m_filePath);
}

bool MainWindow::saveFileAs()
{
    QString suggested = m_filePath;
    if (suggested.isEmpty())
        suggested = QDir::homePath() + QLatin1Char('/') + tr("未命名.md");

    QString path = QFileDialog::getSaveFileName(
        this, tr("另存为"), suggested,
        tr("Markdown 文件 (*.md);;所有文件 (*)"));
    if (path.isEmpty())
        return false;
    if (QFileInfo(path).suffix().isEmpty())
        path += QLatin1String(".md");
    return saveTo(path);
}

bool MainWindow::saveTo(const QString &filePath)
{
    const QString text = currentText();

    QSaveFile file(filePath);
    if (!file.open(QIODevice::WriteOnly)) {
        QMessageBox::warning(this, tr("保存失败"),
                             tr("无法写入文件：\n%1\n%2").arg(filePath, file.errorString()));
        return false;
    }
    file.write(text.toUtf8());
    if (!file.commit()) {
        QMessageBox::warning(this, tr("保存失败"),
                             tr("写入文件失败：\n%1\n%2").arg(filePath, file.errorString()));
        return false;
    }

    m_markdown = text;
    m_filePath = QFileInfo(filePath).absoluteFilePath();
    m_baseUrl = QUrl::fromLocalFile(QFileInfo(m_filePath).absolutePath() + QLatin1Char('/'));

    if (!isEditing())
        renderPreview();

    markModified(false);
    updateWindowTitle();
    showStatus(tr("已保存：%1").arg(m_filePath));
    return true;
}

void MainWindow::handleSave()
{
    saveFile();
}

void MainWindow::handleSaveAs()
{
    saveFileAs();
}

void MainWindow::handleToggleEdit(bool checked)
{
    setEditing(checked);
}

void MainWindow::handleZoomIn()
{
    applyZoom(m_zoom * 1.1);
}

void MainWindow::handleZoomOut()
{
    applyZoom(m_zoom / 1.1);
}

void MainWindow::handleZoomReset()
{
    applyZoom(1.0);
}

void MainWindow::handleEditorChanged()
{
    if (m_syncingEditor)
        return;
    if (!m_dirty)
        markModified(true);
}

void MainWindow::handleAnchorClicked(const QUrl &url)
{
    // 文档内锚点跳转
    if (url.scheme().isEmpty() && url.path().isEmpty()) {
        if (!url.fragment().isEmpty())
            m_preview->scrollToAnchor(url.fragment());
        return;
    }

    QUrl target = url;
    if (target.isRelative())
        target = m_preview->document()->baseUrl().resolved(url);

    if (target.isLocalFile()) {
        const QString localPath = target.toLocalFile();
        if (!QFileInfo::exists(localPath)) {
            showStatus(tr("找不到文件：%1").arg(localPath));
            return;
        }
        if (looksLikeMarkdown(localPath)) {
            if (maybeSave())
                openFile(localPath);
            return;
        }
        if (!QDesktopServices::openUrl(target))
            showStatus(tr("无法用系统程序打开：%1").arg(localPath));
        return;
    }

    const QString scheme = target.scheme();
    if (scheme == QLatin1String("http") || scheme == QLatin1String("https")
        || scheme == QLatin1String("mailto")) {
        if (!QDesktopServices::openUrl(target))
            showStatus(tr("无法在浏览器中打开：%1").arg(target.toString()));
        return;
    }

    showStatus(tr("暂不支持打开该链接：%1").arg(url.toString()));
}

void MainWindow::dragEnterEvent(QDragEnterEvent *event)
{
    const QMimeData *mime = event->mimeData();
    if (!mime->hasUrls())
        return;
    for (const QUrl &url : mime->urls()) {
        if (url.isLocalFile() && looksLikeMarkdown(url.toLocalFile())) {
            event->acceptProposedAction();
            return;
        }
    }
}

void MainWindow::dropEvent(QDropEvent *event)
{
    const QMimeData *mime = event->mimeData();
    if (!mime->hasUrls())
        return;
    for (const QUrl &url : mime->urls()) {
        if (!url.isLocalFile())
            continue;
        const QString path = url.toLocalFile();
        if (!looksLikeMarkdown(path))
            continue;
        if (!maybeSave()) {
            event->ignore();
            return;
        }
        event->acceptProposedAction();
        openFile(path);
        return;
    }
}

bool MainWindow::maybeSave()
{
    if (!m_dirty)
        return true;

    const auto answer = QMessageBox::warning(
        this, tr("未保存的修改"),
        tr("“%1”有尚未保存的修改，是否保存？").arg(displayName()),
        QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel,
        QMessageBox::Save);

    if (answer == QMessageBox::Save)
        return saveFile();
    return answer == QMessageBox::Discard;
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    if (maybeSave())
        event->accept();
    else
        event->ignore();
}

} // namespace MarkdownViewer
