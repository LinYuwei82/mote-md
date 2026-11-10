#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QString>
#include <QUrl>

QT_BEGIN_NAMESPACE
class QAction;
class QPlainTextEdit;
class QSplitter;
class QStackedWidget;
class QTextBrowser;
class QTextDocument;
class QTreeWidget;
class QTreeWidgetItem;
class QWidget;
QT_END_NAMESPACE

namespace MarkdownViewer {

class PreviewView;

class MainWindow : public QMainWindow
{
    Q_OBJECT

public:
    explicit MainWindow(QWidget *parent = nullptr);

    bool openFile(const QString &filePath);

protected:
    void dragEnterEvent(QDragEnterEvent *event) override;
    void dropEvent(QDropEvent *event) override;
    void closeEvent(QCloseEvent *event) override;

private:
    void createActions();
    void createUi();
    void loadBuiltinSample();
    void renderPreview(bool resetScroll = false);
    void rebuildToc();
    void applyZoom(qreal newZoom);
    void setEditing(bool editing);
    bool isEditing() const { return m_editing; }
    void updateWindowTitle();
    void markModified(bool modified);
    bool maybeSave();
    bool saveFile();
    bool saveFileAs();
    bool saveTo(const QString &filePath);
    QString currentText() const;
    QString displayName() const;
    void showStatus(const QString &text);

private slots:
    void openFileDialog();
    void handleSave();
    void handleSaveAs();
    void handleToggleEdit(bool checked);
    void handleZoomIn();
    void handleZoomOut();
    void handleZoomReset();
    void handleAnchorClicked(const QUrl &url);
    void handleTocItemClicked(QTreeWidgetItem *item, int column);
    void handleEditorChanged();

private:
    PreviewView *m_preview = nullptr;
    QPlainTextEdit *m_editor = nullptr;
    QTreeWidget *m_toc = nullptr;
    QWidget *m_tocPanel = nullptr;
    QStackedWidget *m_stack = nullptr;
    QSplitter *m_splitter = nullptr;

    QAction *m_openAction = nullptr;
    QAction *m_saveAction = nullptr;
    QAction *m_saveAsAction = nullptr;
    QAction *m_editAction = nullptr;
    QAction *m_tocAction = nullptr;
    QAction *m_zoomInAction = nullptr;
    QAction *m_zoomOutAction = nullptr;
    QAction *m_zoomResetAction = nullptr;

    QString m_markdown;
    QString m_filePath;
    QUrl m_baseUrl;
    qreal m_zoom = 1.0;
    bool m_dirty = false;
    bool m_editing = false;
    bool m_syncingEditor = false;
};

} // namespace MarkdownViewer

#endif // MAINWINDOW_H
