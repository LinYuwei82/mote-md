#ifndef WEBWINDOW_H
#define WEBWINDOW_H

#include <QMainWindow>
#include <QKeySequence>
#include <QString>

QT_BEGIN_NAMESPACE
class QAction;
class QLabel;
class QMenu;
QT_END_NAMESPACE

class WebEditor;

// 新架构的 Qt 外壳：窗口、菜单、文件对话框、拖拽、保存与未保存提示。
// Markdown 的解析与渲染全部交给被托管的 WebView 前端。
class WebWindow : public QMainWindow
{
    Q_OBJECT

public:
    explicit WebWindow(QWidget *parent = nullptr);

    bool openFile(const QString &filePath);

protected:
    void dragEnterEvent(QDragEnterEvent *event) override;
    void dropEvent(QDropEvent *event) override;
    void closeEvent(QCloseEvent *event) override;
    bool eventFilter(QObject *watched, QEvent *event) override;

private:
    enum class AfterSave { None, OpenDialog, OpenPath, NewDocument, Close, ExportPdf };

    void createActions();
    void createUi();
    void addFormatAction(QMenu *menu, const QString &text, const QString &action,
                         const QKeySequence &shortcut);
    void loadBuiltinSample();
    void updateWindowTitle();
    void markModified(bool modified);
    void showStatus(const QString &text);
    QString displayName() const;
    QString baseDirFor(const QString &filePath) const;

    void openFileDialog();
    void newFile();
    void startNewDocument();
    void toggleToc();
    void toggleSource();
    void zoomIn();
    void zoomOut();
    void zoomReset();
    static bool systemIsDark();
    void applyTheme();
    void applyViewState(bool tocOn, bool sourceOn, qreal zoom);
    void handleSave();
    void handleSaveAs();
    void handleExportHtml();
    void handleExportReady(const QString &html);
    void handleExportPdf();
    void promptExportPdf();
    void handlePdfFinished(const QString &filePath);
    void handlePdfFailed(const QString &message);
    void handleOpenLink(const QString &href);
    void handleSaveRequested(const QString &text);
    void handleDroppedText(const QString &name, const QString &text);
    bool writeText(const QString &filePath, const QString &text);
    bool saveFileAsWith(const QString &text);
    bool prepareForReplace(AfterSave after, const QString &nextPath = QString());
    void runAfterSave();

    WebEditor *m_web = nullptr;
    QLabel *m_placeholder = nullptr;

    QAction *m_newAction = nullptr;
    QAction *m_openAction = nullptr;
    QAction *m_saveAction = nullptr;
    QAction *m_saveAsAction = nullptr;
    QAction *m_exportAction = nullptr;
    QAction *m_exportPdfAction = nullptr;
    QAction *m_undoAction = nullptr;
    QAction *m_redoAction = nullptr;
    QAction *m_cutAction = nullptr;
    QAction *m_copyAction = nullptr;
    QAction *m_pasteAction = nullptr;
    QAction *m_tocAction = nullptr;
    QAction *m_sourceAction = nullptr;
    QAction *m_zoomInAction = nullptr;
    QAction *m_zoomOutAction = nullptr;
    QAction *m_zoomResetAction = nullptr;
    QAction *m_darkAction = nullptr;
    QAction *m_followSystemAction = nullptr;
    QLabel *m_statsLabel = nullptr;

    QString m_filePath;
    QString m_lastDir;      // 会话内记住上次另存为的目录
    QString m_lastText;
    bool m_dirty = false;
    bool m_saveAsRequested = false;
    bool m_sourceOn = false;
    bool m_followSystem = true;
    bool m_dark = false;
    qreal m_lastZoom = 1.0;
    AfterSave m_afterSave = AfterSave::None;
    QString m_afterSavePath;
};

#endif // WEBWINDOW_H
