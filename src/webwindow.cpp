#include "webwindow.h"

#include "webview.h"

#include <QAction>
#include <QApplication>
#include <QCloseEvent>
#include <QDesktopServices>
#include <QDir>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QGuiApplication>
#include <QKeyEvent>
#include <QLabel>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QMimeData>
#include <QMimeDatabase>
#include <QRegularExpression>
#include <QSaveFile>
#include <QScreen>
#include <QShortcutEvent>
#include <QStatusBar>
#include <QStyleHints>
#include <QTimer>
#include <QToolBar>
#include <QUrl>

#include <cstdio>

namespace {

bool looksLikeMarkdown(const QString &path)
{
    const QString suffix = QFileInfo(path).suffix().toLower();
    return suffix == QLatin1String("md") || suffix == QLatin1String("markdown")
        || suffix == QLatin1String("mdown") || suffix == QLatin1String("mkd")
        || suffix == QLatin1String("txt");
}

// 把导出 HTML 里的本地图片 src 替换成 base64 data URI，保证单文件自包含。
// 已经是 data:/http(s) 的保持原样；读不到文件时换成一行提示文字（不留下本地路径）。
QString inlineLocalImages(const QString &html, const QString &baseDir, int *missingCount)
{
    static const QRegularExpression imgRe(
        QStringLiteral("<img\\b[^>]*?\\bsrc=\"([^\"]*)\"[^>]*?>"));

    QString out;
    int last = 0;
    int missing = 0;
    QRegularExpressionMatchIterator it = imgRe.globalMatch(html);
    while (it.hasNext()) {
        const QRegularExpressionMatch match = it.next();
        const QString src = match.captured(1);
        out += html.mid(last, match.capturedStart() - last);

        if (src.startsWith(QLatin1String("data:")) || src.startsWith(QLatin1String("http://"))
            || src.startsWith(QLatin1String("https://"))) {
            out += match.captured(0);
        } else {
            const QUrl url(src);
            const QString filePath = url.isLocalFile()
                ? url.toLocalFile()
                : QDir(baseDir).filePath(QUrl::fromPercentEncoding(src.toUtf8()));
            QFile file(filePath);
            if (file.open(QIODevice::ReadOnly)) {
                const QByteArray bytes = file.readAll();
                const QString mime = QMimeDatabase().mimeTypeForFile(filePath).name();
                const QString dataUri = QStringLiteral("data:%1;base64,%2")
                                            .arg(mime, QString::fromLatin1(bytes.toBase64()));
                QString tag = match.captured(0);
                tag.replace(QStringLiteral("src=\"%1\"").arg(src),
                            QStringLiteral("src=\"%1\"").arg(dataUri));
                out += tag;
            } else {
                ++missing;
                out += QStringLiteral("<span class=\"mote-img-missing\">[图片缺失]</span>");
            }
        }
        last = match.capturedEnd();
    }
    out += html.mid(last);
    if (missingCount)
        *missingCount = missing;
    return out;
}

} // namespace

WebWindow::WebWindow(QWidget *parent)
    : QMainWindow(parent)
{
    setAcceptDrops(true);
    setMinimumSize(760, 520);

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

    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        qApp->installEventFilter(this);
        std::fprintf(stderr, "QT shortcut undo=%s redo=%s\n",
                     m_undoAction->shortcut().toString().toUtf8().constData(),
                     m_redoAction->shortcut().toString().toUtf8().constData());
    }
    // 诊断用（MOTE_NEW=毫秒）：按时触发一次「新建」，用于自动化验证
    // 菜单动作 → 未保存确认 → 空白文档/状态重置这条完整链路。
    if (!qEnvironmentVariableIsEmpty("MOTE_NEW")) {
        const int delay = qEnvironmentVariableIntValue("MOTE_NEW");
        QTimer::singleShot(delay > 0 ? delay : 800, this, &WebWindow::newFile);
    }
}

void WebWindow::createActions()
{
    m_newAction = new QAction(tr("新建"), this);
    m_newAction->setShortcut(QKeySequence::New);
    connect(m_newAction, &QAction::triggered, this, &WebWindow::newFile);

    m_openAction = new QAction(tr("打开"), this);
    m_openAction->setShortcut(QKeySequence::Open);
    connect(m_openAction, &QAction::triggered, this, &WebWindow::openFileDialog);

    m_saveAction = new QAction(tr("保存"), this);
    m_saveAction->setShortcut(QKeySequence::Save);
    connect(m_saveAction, &QAction::triggered, this, &WebWindow::handleSave);

    m_saveAsAction = new QAction(tr("另存为"), this);
    m_saveAsAction->setShortcut(QKeySequence::SaveAs);
    connect(m_saveAsAction, &QAction::triggered, this, &WebWindow::handleSaveAs);

    // 导出 HTML：用 Option+Cmd+E。Cmd+E 是「源码模式」，而 macOS 原生菜单把
    // 大写 E 的 Shift 视为同一个 key equivalent（Cmd+Shift+E 实测不触发、也不报冲突），
    // 所以改用带 Option 的组合，与现有 24 项均无重叠。
    m_exportAction = new QAction(tr("导出 HTML…"), this);
    m_exportAction->setShortcut(QKeySequence(Qt::CTRL | Qt::ALT | Qt::Key_E));
    connect(m_exportAction, &QAction::triggered, this, &WebWindow::handleExportHtml);

    // 导出 PDF：渲染态整篇正文、A4、无页眉页脚。源码模式下由 applyViewState 禁用。
    m_exportPdfAction = new QAction(tr("导出 PDF…"), this);
    m_exportPdfAction->setShortcut(QKeySequence::Print);
    m_exportPdfAction->setStatusTip(tr("导出渲染后的整篇正文（A4、无页眉页脚）；源码模式下不可用"));
    connect(m_exportPdfAction, &QAction::triggered, this, &WebWindow::handleExportPdf);

    // 撤销/重做走原生菜单与快捷键：WKWebView 会自己处理 Cmd+Z（responder chain
    // 里的 undo:），页面里的 keydown 不一定收得到，所以由外壳显式驱动前端历史栈。
    m_undoAction = new QAction(tr("撤销"), this);
    m_undoAction->setShortcut(QKeySequence::Undo);
    connect(m_undoAction, &QAction::triggered, this, [this] {
        if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
            std::fprintf(stderr, "QT action undo\n");
        if (m_web)
            m_web->undo();
    });

    // 显式写出 Cmd+Shift+Z：QKeySequence::Redo 在 macOS 上虽然也是这组键，
    // 但原生菜单的 key equivalent 匹配需要唯一、明确的序列（实测曾把
    // Cmd+Shift+Z 匹配到 Undo 项），这里不再依赖标准键的隐式取值。
    m_redoAction = new QAction(tr("重做"), this);
    m_redoAction->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_Z));
    connect(m_redoAction, &QAction::triggered, this, [this] {
        if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
            std::fprintf(stderr, "QT action redo\n");
        if (m_web)
            m_web->redo();
    });

    // 剪切 / 复制 / 粘贴：WKWebView 与 WebView2 都没有给宿主的可编辑命令接口
    // （macOS 走 AppKit 响应链，Windows 走页面桥，见 MacWebView::clipboardCommand
    // 与 WebViewBase::clipboardCommand）。菜单、快捷键与右键菜单共用这一个入口。
    m_cutAction = new QAction(tr("剪切"), this);
    m_cutAction->setShortcut(QKeySequence::Cut);
    connect(m_cutAction, &QAction::triggered, this, [this] {
        if (m_web)
            m_web->clipboardCommand(QStringLiteral("cut"));
    });

    m_copyAction = new QAction(tr("复制"), this);
    m_copyAction->setShortcut(QKeySequence::Copy);
    connect(m_copyAction, &QAction::triggered, this, [this] {
        if (m_web)
            m_web->clipboardCommand(QStringLiteral("copy"));
    });

    m_pasteAction = new QAction(tr("粘贴"), this);
    m_pasteAction->setShortcut(QKeySequence::Paste);
    connect(m_pasteAction, &QAction::triggered, this, [this] {
        if (m_web)
            m_web->clipboardCommand(QStringLiteral("paste"));
    });

    m_tocAction = new QAction(tr("目录"), this);
    m_tocAction->setCheckable(true);
    // 原 Cmd+Shift+T 让给「表格」；目录改用 Cmd+Shift+L（L = list/outline），
    // 不与系统或本文其它快捷键重叠。
    m_tocAction->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_L));
    connect(m_tocAction, &QAction::triggered, this, &WebWindow::toggleToc);

    m_sourceAction = new QAction(tr("源码模式"), this);
    m_sourceAction->setCheckable(true);
    // Cmd+E 是既有约定（前端注释与验收口径均按 Cmd+E）；保留 Cmd+/ 作为备用，
    // 菜单显示第一个（Cmd+E）。
    m_sourceAction->setShortcuts({QKeySequence(Qt::CTRL | Qt::Key_E),
                                  QKeySequence(Qt::CTRL | Qt::Key_Slash)});
    connect(m_sourceAction, &QAction::triggered, this, &WebWindow::toggleSource);

    // Cmd+= 在 macOS 上可能以 Key_Equal（无 Shift）或 Key_Plus（有 Shift）到达，
    // 两种都注册，避免依赖键盘布局的细微差异。
    m_zoomInAction = new QAction(tr("放大"), this);
    m_zoomInAction->setShortcuts({QKeySequence(Qt::CTRL | Qt::Key_Equal),
                                  QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_Equal),
                                  QKeySequence(Qt::CTRL | Qt::Key_Plus)});
    connect(m_zoomInAction, &QAction::triggered, this, &WebWindow::zoomIn);

    m_zoomOutAction = new QAction(tr("缩小"), this);
    m_zoomOutAction->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_Minus));
    connect(m_zoomOutAction, &QAction::triggered, this, &WebWindow::zoomOut);

    m_zoomResetAction = new QAction(tr("实际大小"), this);
    m_zoomResetAction->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_0));
    connect(m_zoomResetAction, &QAction::triggered, this, &WebWindow::zoomReset);

    // 深色模式：Cmd+Shift+D 与现有 23 项无重叠。手动切换会退出「跟随系统」，
    // 由下面的「跟随系统外观」重新交回系统。
    m_darkAction = new QAction(tr("深色模式"), this);
    m_darkAction->setCheckable(true);
    m_darkAction->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_D));
    connect(m_darkAction, &QAction::triggered, this, [this](bool on) {
        m_followSystem = false;
        m_followSystemAction->setChecked(false);
        m_dark = on;
        applyTheme();
    });

    m_followSystemAction = new QAction(tr("跟随系统外观"), this);
    m_followSystemAction->setCheckable(true);
    m_followSystemAction->setChecked(true);
    connect(m_followSystemAction, &QAction::triggered, this, [this](bool on) {
        if (!on) {
            // 单独的「不跟随」没有意义：要么保持跟随，要么用「深色模式」手动指定
            m_followSystemAction->setChecked(true);
            return;
        }
        m_followSystem = true;
        m_dark = systemIsDark();
        applyTheme();
    });
}

// 格式项必须挂在原生菜单上：macOS 的 key equivalent 会在 WKWebView 之前消费
// Cmd+B 这类按键，页面 keydown 不一定收得到（与撤销/重做同一条结论）。
void WebWindow::addFormatAction(QMenu *menu, const QString &text, const QString &action,
                                const QKeySequence &shortcut)
{
    auto *act = new QAction(text, this);
    if (!shortcut.isEmpty())
        act->setShortcut(shortcut);
    connect(act, &QAction::triggered, this, [this, action] {
        if (m_web)
            m_web->applyFormat(action);
    });
    menu->addAction(act);
}

void WebWindow::createUi()
{
    // 文件菜单此前只有工具栏入口，新建/打开/保存/另存为补成完整菜单，
    // 与「编辑 / 视图」保持同样的 QAction 复用方式（菜单与工具栏同步勾选/禁用）。
    QMenu *fileMenu = menuBar()->addMenu(tr("文件"));
    fileMenu->addAction(m_newAction);
    fileMenu->addAction(m_openAction);
    fileMenu->addSeparator();
    fileMenu->addAction(m_saveAction);
    fileMenu->addAction(m_saveAsAction);
    fileMenu->addAction(m_exportAction);
    fileMenu->addAction(m_exportPdfAction);

    QMenu *editMenu = menuBar()->addMenu(tr("编辑"));
    editMenu->addAction(m_undoAction);
    editMenu->addAction(m_redoAction);
    editMenu->addSeparator();
    editMenu->addAction(m_cutAction);
    editMenu->addAction(m_copyAction);
    editMenu->addAction(m_pasteAction);

    // 格式菜单：快捷键与「转为」同一套动作实现。Cmd+1/2/3 是切换语义，
    // 同级别再按一次回正文；表格/分隔线是插入，不改动已有内容。
    QMenu *formatMenu = menuBar()->addMenu(tr("格式"));
    addFormatAction(formatMenu, tr("粗体"), QStringLiteral("bold"),
                    QKeySequence(Qt::CTRL | Qt::Key_B));
    addFormatAction(formatMenu, tr("斜体"), QStringLiteral("italic"),
                    QKeySequence(Qt::CTRL | Qt::Key_I));
    addFormatAction(formatMenu, tr("行内代码"), QStringLiteral("inlineCode"),
                    QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_K));
    addFormatAction(formatMenu, tr("链接"), QStringLiteral("link"),
                    QKeySequence(Qt::CTRL | Qt::Key_K));
    formatMenu->addSeparator();
    addFormatAction(formatMenu, tr("标题 1"), QStringLiteral("h1"),
                    QKeySequence(Qt::CTRL | Qt::Key_1));
    addFormatAction(formatMenu, tr("标题 2"), QStringLiteral("h2"),
                    QKeySequence(Qt::CTRL | Qt::Key_2));
    addFormatAction(formatMenu, tr("标题 3"), QStringLiteral("h3"),
                    QKeySequence(Qt::CTRL | Qt::Key_3));
    addFormatAction(formatMenu, tr("正文"), QStringLiteral("paragraph"), QKeySequence());
    formatMenu->addSeparator();
    addFormatAction(formatMenu, tr("无序列表"), QStringLiteral("ul"),
                    QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_8));
    addFormatAction(formatMenu, tr("有序列表"), QStringLiteral("ol"),
                    QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_7));
    addFormatAction(formatMenu, tr("引用"), QStringLiteral("quote"),
                    QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_B));
    formatMenu->addSeparator();
    addFormatAction(formatMenu, tr("代码块"), QStringLiteral("codeBlock"),
                    QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_C));
    addFormatAction(formatMenu, tr("表格"), QStringLiteral("table"),
                    QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_T));
    addFormatAction(formatMenu, tr("分隔线"), QStringLiteral("hr"), QKeySequence());

    QMenu *viewMenu = menuBar()->addMenu(tr("视图"));
    viewMenu->addAction(m_tocAction);
    viewMenu->addAction(m_sourceAction);
    viewMenu->addSeparator();
    viewMenu->addAction(m_darkAction);
    viewMenu->addAction(m_followSystemAction);
    viewMenu->addSeparator();
    viewMenu->addAction(m_zoomInAction);
    viewMenu->addAction(m_zoomOutAction);
    viewMenu->addAction(m_zoomResetAction);

    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        const auto acts = findChildren<QAction *>();
        for (QAction *a : acts) {
            if (!a->shortcut().isEmpty())
                std::fprintf(stderr, "QT shortcut %s = %s\n",
                             a->text().toUtf8().constData(),
                             a->shortcut().toString().toUtf8().constData());
        }
    }

    auto *toolBar = addToolBar(tr("工具栏"));
    toolBar->setMovable(false);
    toolBar->setToolButtonStyle(Qt::ToolButtonTextOnly);
    toolBar->addAction(m_newAction);
    toolBar->addAction(m_openAction);
    toolBar->addAction(m_saveAction);
    toolBar->addAction(m_saveAsAction);
    toolBar->addSeparator();
    toolBar->addAction(m_tocAction);
    toolBar->addAction(m_sourceAction);

    m_web = createWebEditor(this);
    if (m_web) {
        connect(m_web, &WebEditor::dirtyChanged, this, &WebWindow::markModified);
        connect(m_web, &WebEditor::statsChanged, this, [this](int cjkChars, int words) {
            if (m_statsLabel)
                m_statsLabel->setText(tr("中文 %1 字 · 英文 %2 词").arg(cjkChars).arg(words));
            if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
                std::fprintf(stderr, "QT stats cjk=%d words=%d label=%s\n",
                             cjkChars, words,
                             m_statsLabel ? m_statsLabel->text().toUtf8().constData() : "");
        });
        connect(m_web, &WebEditor::saveRequested, this, &WebWindow::handleSaveRequested);
        connect(m_web, &WebEditor::openRequested, this, &WebWindow::openFileDialog);
        connect(m_web, &WebEditor::dropReceived, this, &WebWindow::handleDroppedText);
        connect(m_web, &WebEditor::fileDropRequested, this, [this](const QString &path) {
            // 原生拖放拿得到真实路径：与菜单打开走同一套未保存确认
            if (!prepareForReplace(AfterSave::OpenPath, path))
                return;
            openFile(path);
        });
        connect(m_web, &WebEditor::openLinkRequested, this, &WebWindow::handleOpenLink);
        connect(m_web, &WebEditor::exportHtmlReady, this, &WebWindow::handleExportReady);
        connect(m_web, &WebEditor::pdfExportFinished, this, &WebWindow::handlePdfFinished);
        connect(m_web, &WebEditor::pdfExportFailed, this, &WebWindow::handlePdfFailed);
        connect(m_web, &WebEditor::statusMessage, this, &WebWindow::showStatus);
        connect(m_web, &WebEditor::errorOccurred, this, [this](const QString &message) {
            showStatus(tr("前端错误：%1").arg(message));
        });
        connect(m_web, &WebEditor::viewStateChanged, this, &WebWindow::applyViewState);
        setCentralWidget(m_web);
    } else {
        m_placeholder = new QLabel(tr("当前平台没有可用的 WebView 后端（仅支持 macOS 与 Windows）。"), this);
        m_placeholder->setAlignment(Qt::AlignCenter);
        setCentralWidget(m_placeholder);
    }

    // 字数统计常驻右侧；左侧 showMessage 的临时提示不会覆盖它
    m_statsLabel = new QLabel(tr("中文 0 字 · 英文 0 词"), this);
    statusBar()->addPermanentWidget(m_statsLabel);
    statusBar()->showMessage(tr("就绪 · 可以把 .md 文件拖进窗口打开"));
    updateWindowTitle();

    // 跟随系统：系统外观变化时重新下发（Qt 6 的 QStyleHints 会给出 Dark/Light）
    connect(QGuiApplication::styleHints(), &QStyleHints::colorSchemeChanged, this,
            [this](Qt::ColorScheme) {
                if (m_followSystem)
                    applyTheme();
            });
    m_dark = systemIsDark();
    applyTheme();

    // 诊断：把最终生效的菜单快捷键打出来，用于核对是否与系统/其它项冲突
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        const auto menus = menuBar()->actions();
        for (QAction *menuAction : menus) {
            if (!menuAction->menu())
                continue;
            const auto items = menuAction->menu()->actions();
            for (QAction *item : items) {
                if (item->shortcut().isEmpty())
                    continue;
                std::fprintf(stderr, "QT menu %s / %s = %s\n",
                             menuAction->text().toUtf8().constData(),
                             item->text().toUtf8().constData(),
                             item->shortcut().toString().toUtf8().constData());
            }
        }
    }
}

void WebWindow::loadBuiltinSample()
{
    QFile file(QStringLiteral(":/samples/welcome.md"));
    if (!file.open(QIODevice::ReadOnly)) {
        m_lastText = tr("# 欢迎\n\n没有找到内置示例文档。\n");
    } else {
        m_lastText = QString::fromUtf8(file.readAll());
    }
    m_filePath.clear();
    if (m_web)
        m_web->setMarkdown(m_lastText, QUrl());
    markModified(false);
    updateWindowTitle();
}

void WebWindow::updateWindowTitle()
{
    setWindowTitle(tr("%1[*] - Mote").arg(displayName()));
    setWindowModified(m_dirty);
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "QT title=%s dirty=%d path=%s\n",
                     windowTitle().toUtf8().constData(), int(m_dirty),
                     m_filePath.toUtf8().constData());
}

void WebWindow::markModified(bool modified)
{
    m_dirty = modified;
    setWindowModified(modified);
}

void WebWindow::showStatus(const QString &text)
{
    statusBar()->showMessage(text, 6000);
}

QString WebWindow::displayName() const
{
    if (m_filePath.isEmpty())
        return tr("未命名");
    return QFileInfo(m_filePath).fileName();
}

QString WebWindow::baseDirFor(const QString &filePath) const
{
    return QFileInfo(filePath).absolutePath() + QLatin1Char('/');
}

bool WebWindow::openFile(const QString &filePath)
{
    const QFileInfo info(filePath);
    if (!info.exists() || !info.isFile()) {
        QMessageBox::warning(this, tr("无法打开"), tr("文件不存在：\n%1").arg(filePath));
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

    m_filePath = info.absoluteFilePath();
    m_lastDir = info.absolutePath();
    m_lastText = text;
    if (m_web)
        m_web->setMarkdown(text, QUrl::fromLocalFile(baseDirFor(m_filePath)));
    markModified(false);
    updateWindowTitle();
    showStatus(tr("已打开：%1").arg(m_filePath));
    return true;
}

void WebWindow::handleDroppedText(const QString &name, const QString &text)
{
    // WebKit 出于安全不暴露拖入文件的真实路径，这里只能作为「未命名」文档载入
    Q_UNUSED(name)
    m_filePath.clear();
    m_lastText = text;
    if (m_web)
        m_web->setMarkdown(text, QUrl());
    markModified(true);
    updateWindowTitle();
    showStatus(tr("已载入拖入的文档（未关联磁盘路径，保存时会询问位置）"));
}

void WebWindow::newFile()
{
    // 未保存时先问：保存 / 不保存 / 取消；取消则整个新建中止
    if (!prepareForReplace(AfterSave::NewDocument))
        return;
    startNewDocument();
}

void WebWindow::startNewDocument()
{
    m_filePath.clear();
    m_lastText.clear();
    m_saveAsRequested = false;
    if (m_web)
        m_web->newDocument();
    markModified(false);
    updateWindowTitle();
    showStatus(tr("已新建空白文档（未命名，保存时会询问位置）"));
}

void WebWindow::toggleToc()
{
    if (m_web)
        m_web->toggleToc();
}

void WebWindow::toggleSource()
{
    if (m_web)
        m_web->toggleSource();
}

void WebWindow::zoomIn()
{
    if (m_web)
        m_web->zoomBy(1);
}

void WebWindow::zoomOut()
{
    if (m_web)
        m_web->zoomBy(-1);
}

void WebWindow::zoomReset()
{
    if (m_web)
        m_web->resetZoom();
}

bool WebWindow::systemIsDark()
{
    return QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Dark;
}

void WebWindow::applyTheme()
{
    if (m_followSystem)
        m_dark = systemIsDark();
    else if (m_darkAction)
        m_dark = m_darkAction->isChecked();
    if (m_darkAction)
        m_darkAction->setChecked(m_dark);
    if (m_web)
        m_web->setTheme(m_dark ? QStringLiteral("dark") : QStringLiteral("light"));
    // 状态栏是原生 Qt 控件，不随网页 CSS 变化：深色时单独上色，避免底部留一条白带。
    // 工具栏/菜单栏仍交给系统外观，不在这里改（见 README 的降级说明）。
    if (QStatusBar *bar = statusBar()) {
        bar->setStyleSheet(m_dark
            ? QStringLiteral("QStatusBar{background:#1b2027;color:#c3cdd7;}"
                             "QStatusBar::item{border:0;}"
                             "QStatusBar QLabel{color:#c3cdd7;background:transparent;}")
            : QString());
    }
}

// 前端是视图状态的唯一来源：菜单勾选与状态栏都按前端回报同步，
// 避免快捷键、菜单点击、页面内操作三条路径各自维护一份状态。
void WebWindow::applyViewState(bool tocOn, bool sourceOn, qreal zoom)
{
    m_tocAction->setChecked(tocOn);
    m_sourceAction->setChecked(sourceOn);
    m_sourceOn = sourceOn;
    // 源码态不是渲染结果，打印出来只会是空白或原始文本，直接禁用导出 PDF，
    // 与 m_exportPdfAction 的禁用口径一致（快捷键不会再触发）。
    m_exportPdfAction->setEnabled(!sourceOn);
    // 源码模式是 textarea 自己的原生剪贴板：macOS 把剪切/复制/粘贴直接转发给
    // WebKit 响应链，两种模式都成立；Windows 的页面桥只覆盖渲染态，源码模式要
    // 交回 WebView2 自带的加速键，所以只在 Windows 上禁用这三项。
#ifdef Q_OS_WIN
    m_cutAction->setEnabled(!sourceOn);
    m_copyAction->setEnabled(!sourceOn);
    m_pasteAction->setEnabled(!sourceOn);
#endif
    if (!qFuzzyCompare(zoom, m_lastZoom)) {
        m_lastZoom = zoom;
        showStatus(tr("缩放：%1%").arg(qRound(zoom * 100)));
    }
}

void WebWindow::openFileDialog()
{
    if (!prepareForReplace(AfterSave::OpenDialog))
        return;

    const QString path = QFileDialog::getOpenFileName(
        this, tr("打开 Markdown 文件"), m_lastDir.isEmpty() ? QDir::homePath() : m_lastDir,
        tr("Markdown 文件 (*.md *.markdown *.mdown *.mkd);;文本文件 (*.txt);;所有文件 (*)"));
    if (path.isEmpty())
        return;
    openFile(path);
}

void WebWindow::handleSave()
{
    if (!m_web)
        return;
    m_saveAsRequested = false;
    m_web->requestSnapshot();
}

void WebWindow::handleSaveAs()
{
    if (!m_web)
        return;
    m_saveAsRequested = true;
    m_web->requestSnapshot();
}

void WebWindow::handleExportHtml()
{
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "QT action export\n");
    if (!m_web)
        return;
    m_web->requestExportHtml(displayName());
}

void WebWindow::handleExportPdf()
{
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "QT action exportPdf\n");
    if (!m_web)
        return;
    if (m_sourceOn) {
        showStatus(tr("源码模式下不能导出 PDF，先退出源码模式"));
        return;
    }

    // 未保存文档先落盘：PDF 里图片的相对路径按 .md 所在目录解析，没有路径就没有
    // 基准；用户取消保存对话框时在这里中止，不会进入导出，也不留半成品文件。
    if (m_filePath.isEmpty()) {
        m_saveAsRequested = true;
        m_afterSave = AfterSave::ExportPdf;
        m_web->requestSnapshot();
        return;
    }
    if (m_dirty && !prepareForReplace(AfterSave::ExportPdf))
        return;

    promptExportPdf();
}

void WebWindow::promptExportPdf()
{
    if (!m_web)
        return;

    const QString suggested =
        QDir(QFileInfo(m_filePath).path())
            .filePath(QFileInfo(m_filePath).completeBaseName() + QStringLiteral(".pdf"));

    QString path = qEnvironmentVariable("MOTE_PDF_AS");   // 自动化验证用
    if (path.isEmpty()) {
        // 诊断：只记录建议路径并当作“用户取消”
        if (qEnvironmentVariableIsSet("MOTE_PDF_PROMPT")) {
            std::fprintf(stderr, "QT pdf suggested=%s\n", suggested.toUtf8().constData());
            return;
        }
        path = QFileDialog::getSaveFileName(this, tr("导出 PDF"), suggested,
                                            tr("PDF 文件 (*.pdf);;所有文件 (*)"));
    }
    if (path.isEmpty())
        return;
    if (QFileInfo(path).suffix().isEmpty())
        path += QLatin1String(".pdf");

    showStatus(tr("正在导出 PDF…"));
    m_web->requestExportPdf(QFileInfo(path).absoluteFilePath());
}

void WebWindow::handlePdfFinished(const QString &filePath)
{
    const QFileInfo pdf(filePath);
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        std::fprintf(stderr, "QT pdf path=%s size=%lld\n",
                     filePath.toUtf8().constData(),
                     static_cast<long long>(pdf.size()));
    }
    showStatus(tr("已导出到 %1").arg(QDir::toNativeSeparators(filePath)));
}

void WebWindow::handlePdfFailed(const QString &message)
{
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "QT pdf failed: %s\n", message.toUtf8().constData());
    showStatus(message);
    QMessageBox::warning(this, tr("导出失败"), message);
}

void WebWindow::handleExportReady(const QString &html)
{
    if (!m_web || html.isEmpty()) {
        showStatus(tr("导出失败：页面没有返回内容"));
        return;
    }

    QString suggested = m_filePath;
    if (suggested.isEmpty()) {
        const QString dir = m_lastDir.isEmpty() ? QDir::homePath() : m_lastDir;
        suggested = QDir(dir).filePath(tr("未命名.html"));
    } else {
        suggested = QDir(QFileInfo(suggested).path())
                        .filePath(QFileInfo(suggested).completeBaseName() + QStringLiteral(".html"));
    }

    QString path = qEnvironmentVariable("MOTE_EXPORT_AS");   // 自动化验证用
    if (path.isEmpty()) {
        if (qEnvironmentVariableIsSet("MOTE_EXPORT_PROMPT")) {
            std::fprintf(stderr, "QT export suggested=%s\n", suggested.toUtf8().constData());
            return;
        }
        path = QFileDialog::getSaveFileName(this, tr("导出 HTML"), suggested,
                                            tr("HTML 文件 (*.html);;所有文件 (*)"));
    }
    if (path.isEmpty())
        return;
    if (QFileInfo(path).suffix().isEmpty())
        path += QLatin1String(".html");

    int missing = 0;
    const QByteArray bytes = inlineLocalImages(html, baseDirFor(m_filePath), &missing).toUtf8();

    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size() || !file.commit()) {
        QMessageBox::warning(this, tr("导出失败"),
                             tr("无法写入文件：\n%1\n%2").arg(path, file.errorString()));
        return;
    }
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        std::fprintf(stderr, "QT export path=%s size=%lld missing=%d\n",
                     path.toUtf8().constData(), static_cast<long long>(bytes.size()), missing);
    }
    showStatus(missing
        ? tr("已导出 %1（%2 KB），%3 张图片读取失败").arg(QFileInfo(path).fileName())
              .arg(bytes.size() / 1024).arg(missing)
        : tr("已导出 %1（%2 KB）").arg(QFileInfo(path).fileName()).arg(bytes.size() / 1024));
}

void WebWindow::handleOpenLink(const QString &rawHref)
{
    const QString href = rawHref.trimmed();
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "QT openLink href=%s base=%s\n", href.toUtf8().constData(),
                     baseDirFor(m_filePath).toUtf8().constData());
    if (href.isEmpty())
        return;

    if (href.startsWith(QLatin1Char('#'))) {
        // 目录/正文目前没有生成标题锚点，这里如实提示而不是静默失败
        showStatus(tr("锚点链接 %1 暂不支持（还没有标题锚点）").arg(href));
        return;
    }

    const QUrl url(href);
    const QString scheme = url.scheme().toLower();
    if (scheme == QLatin1String("http") || scheme == QLatin1String("https")
        || scheme == QLatin1String("mailto")) {
        if (!QDesktopServices::openUrl(url))
            showStatus(tr("无法打开链接：%1").arg(href));
        return;
    }

    QString target;
    if (scheme == QLatin1String("file"))
        target = url.toLocalFile();
    else if (scheme.isEmpty())
        target = QDir(baseDirFor(m_filePath))
                     .filePath(QUrl::fromPercentEncoding(href.toUtf8()));
    else {
        showStatus(tr("不支持打开的链接类型：%1").arg(href));
        return;
    }

    if (target.isEmpty() || !QFileInfo::exists(target)) {
        QMessageBox::warning(this, tr("链接目标不存在"),
                             tr("找不到链接指向的文件：\n%1").arg(href));
        showStatus(tr("链接目标不存在：%1").arg(href));
        return;
    }

    if (!looksLikeMarkdown(target)) {
        QDesktopServices::openUrl(QUrl::fromLocalFile(target));
        return;
    }
    // 应用内打开：与拖放/菜单打开共用同一套未保存确认
    if (prepareForReplace(AfterSave::OpenPath, target))
        openFile(target);
}

void WebWindow::handleSaveRequested(const QString &text)
{
    const bool wantsSaveAs = m_saveAsRequested;
    m_saveAsRequested = false;

    bool saved = false;
    if (m_filePath.isEmpty() || wantsSaveAs)
        saved = saveFileAsWith(text);
    else
        saved = writeText(m_filePath, text);

    if (!saved) {
        m_afterSave = AfterSave::None;
        m_afterSavePath.clear();
        return;
    }

    m_lastText = text;
    markModified(false);
    if (m_web)
        m_web->notifySaved(text);
    // 另存为可能换了目录：图片落盘位置跟随新的 .md 路径
    if (m_web)
        m_web->setBaseDir(QUrl::fromLocalFile(baseDirFor(m_filePath)));
    updateWindowTitle();
    showStatus(tr("已保存：%1").arg(m_filePath));

    runAfterSave();
}

bool WebWindow::writeText(const QString &filePath, const QString &text)
{
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
    return true;
}

bool WebWindow::saveFileAsWith(const QString &text)
{
    QString suggested = m_filePath;
    if (suggested.isEmpty()) {
        // 未命名文档：优先落到本会话上次另存为的目录，默认文件名「未命名.md」
        const QString dir = m_lastDir.isEmpty() ? QDir::homePath() : m_lastDir;
        suggested = QDir(dir).filePath(tr("未命名.md"));
    }

    QString path = qEnvironmentVariable("MOTE_SAVE_AS");
    if (path.isEmpty()) {
        // 诊断：只记录建议路径并当作“用户取消”，用于核对记住目录/默认文件名
        if (qEnvironmentVariableIsSet("MOTE_SAVE_PROMPT")) {
            std::fprintf(stderr, "QT saveas suggested=%s\n", suggested.toUtf8().constData());
            return false;
        }
        path = QFileDialog::getSaveFileName(
            this, tr("另存为"), suggested, tr("Markdown 文件 (*.md);;所有文件 (*)"));
    }
    if (path.isEmpty())
        return false;
    if (QFileInfo(path).suffix().isEmpty())
        path += QLatin1String(".md");
    if (!writeText(path, text))
        return false;

    m_filePath = QFileInfo(path).absoluteFilePath();
    m_lastDir = QFileInfo(m_filePath).absolutePath();
    return true;
}

bool WebWindow::prepareForReplace(AfterSave after, const QString &nextPath)
{
    if (!m_dirty)
        return true;

    // 诊断用（MOTE_ANSWER=cancel|discard|save）：跳过弹窗直接给出答案，
    // 便于自动化分别验证三个分支；正常启动不设置该变量。
    const QString forced = qEnvironmentVariable("MOTE_ANSWER");
    QMessageBox::StandardButton answer = QMessageBox::NoButton;
    if (forced == QLatin1String("cancel")) {
        answer = QMessageBox::Cancel;
    } else if (forced == QLatin1String("discard")) {
        answer = QMessageBox::Discard;
    } else if (forced == QLatin1String("save")) {
        answer = QMessageBox::Save;
    } else {
        answer = QMessageBox::warning(
            this, tr("未保存的修改"),
            tr("“%1”有尚未保存的修改，是否保存？").arg(displayName()),
            QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel,
            QMessageBox::Save);
    }

    if (answer == QMessageBox::Cancel)
        return false;
    if (answer == QMessageBox::Discard)
        return true;

    m_afterSave = after;
    m_afterSavePath = nextPath;
    if (m_web)
        m_web->requestSnapshot();
    return false;
}

void WebWindow::runAfterSave()
{
    const AfterSave after = m_afterSave;
    const QString path = m_afterSavePath;
    m_afterSave = AfterSave::None;
    m_afterSavePath.clear();

    switch (after) {
    case AfterSave::OpenDialog:
        QTimer::singleShot(0, this, &WebWindow::openFileDialog);
        break;
    case AfterSave::OpenPath:
        QTimer::singleShot(0, this, [this, path] { openFile(path); });
        break;
    case AfterSave::NewDocument:
        QTimer::singleShot(0, this, &WebWindow::startNewDocument);
        break;
    case AfterSave::Close:
        close();
        break;
    case AfterSave::ExportPdf:
        QTimer::singleShot(0, this, &WebWindow::promptExportPdf);
        break;
    case AfterSave::None:
        break;
    }
}

void WebWindow::dragEnterEvent(QDragEnterEvent *event)
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

void WebWindow::dropEvent(QDropEvent *event)
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
        if (!prepareForReplace(AfterSave::OpenPath, path)) {
            event->ignore();
            return;
        }
        event->acceptProposedAction();
        openFile(path);
        return;
    }
}

// 诊断开关（MOTE_KEYLOG=1）：记录 Qt 层看到的按键与快捷键事件。默认不安装，
// 因此正常启动没有任何输出。用于确认按键是被原生菜单、Qt 快捷键还是页面接住。
bool WebWindow::eventFilter(QObject *watched, QEvent *event)
{
    if (event->type() == QEvent::Shortcut) {
        auto *shortcut = static_cast<QShortcutEvent *>(event);
        std::fprintf(stderr, "QT shortcut event key=%s ambiguous=%d\n",
                     shortcut->key().toString().toUtf8().constData(),
                     int(shortcut->isAmbiguous()));
    } else if (event->type() == QEvent::KeyPress) {
        auto *key = static_cast<QKeyEvent *>(event);
        std::fprintf(stderr, "QT keypress key=0x%x mods=0x%x text=%s\n",
                     key->key(), int(key->modifiers()),
                     key->text().toUtf8().constData());
    }
    return QMainWindow::eventFilter(watched, event);
}

void WebWindow::closeEvent(QCloseEvent *event)
{
    if (!m_dirty) {
        event->accept();
        return;
    }

    const auto answer = QMessageBox::warning(
        this, tr("未保存的修改"),
        tr("“%1”有尚未保存的修改，是否保存？").arg(displayName()),
        QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel,
        QMessageBox::Save);

    if (answer == QMessageBox::Cancel) {
        event->ignore();
        return;
    }
    if (answer == QMessageBox::Discard) {
        event->accept();
        return;
    }

    m_afterSave = AfterSave::Close;
    if (m_web)
        m_web->requestSnapshot();
    event->ignore();
}
