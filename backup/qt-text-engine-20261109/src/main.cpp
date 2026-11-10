#include <QApplication>
#include <QFile>
#include <QFont>
#include <QFontDatabase>
#include <QIcon>

#include "mainwindow.h"

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("Mote"));
    QCoreApplication::setApplicationVersion(QStringLiteral("1.0.0"));
    QCoreApplication::setOrganizationName(QStringLiteral("Mote"));
    QApplication::setApplicationDisplayName(QStringLiteral("Mote"));

    // 正文基准 16.5pt（原 13pt）。
    // macOS 的系统默认字体没有中文字面，只设字重时中文仍回落到 PingFang Regular，
    // 笔画粗细毫无变化；因此显式指定 PingFang SC，再取 ExtraLight(200) 档。
    // 实测墨量：Regular 100% / Light(300) 81% / ExtraLight(200) 59%，这一档比常规约细四成。
    QFont appFont = app.font();
    if (QFontDatabase::families().contains(QStringLiteral("PingFang SC")))
        appFont.setFamily(QStringLiteral("PingFang SC"));
    appFont.setPointSizeF(16.5);
    appFont.setWeight(QFont::ExtraLight);
    app.setFont(appFont);

    // 代码块字体随包内置 JetBrains Mono（SIL OFL）。加载失败时主窗口会回退到
    // Menlo / SF Mono / 系统等宽字体，不会影响正文与界面字体。
    // 代码块正文用 Light(300)：等宽字体的 Regular 在 15pt 上下墨量偏重，比正文
    // PingFang SC ExtraLight 明显更粗；Light 是随包的真实字面，不靠合成变细。
    QFontDatabase::addApplicationFont(QStringLiteral(":/fonts/JetBrainsMono-Light.ttf"));
    QFontDatabase::addApplicationFont(QStringLiteral(":/fonts/JetBrainsMono-Regular.ttf"));
    QFontDatabase::addApplicationFont(QStringLiteral(":/fonts/JetBrainsMono-Bold.ttf"));

    QIcon appIcon;
    appIcon.addFile(QStringLiteral(":/icons/app.ico"));
    appIcon.addFile(QStringLiteral(":/icons/app_256.png"));
    QApplication::setWindowIcon(appIcon);

    QFile qss(QStringLiteral(":/styles/app.qss"));
    if (qss.open(QIODevice::ReadOnly)) {
        app.setStyleSheet(QString::fromUtf8(qss.readAll()));
    }

    MarkdownViewer::MainWindow window;
    window.show();

    const QStringList args = QCoreApplication::arguments();
    if (args.size() > 1) {
        window.openFile(args.at(1));
    }

    return app.exec();
}
