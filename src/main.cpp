#include <QApplication>
#include <QFile>
#include <QFont>
#include <QFontDatabase>
#include <QIcon>

#include "mainwindow.h"
#include "webwindow.h"

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("Mote"));
    // 版本号由 Mote.pro 的 VERSION 经 -DMOTE_VERSION 传入，不在这里写第二份
    QCoreApplication::setApplicationVersion(QStringLiteral(MOTE_VERSION));
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

    const QStringList args = QCoreApplication::arguments();

    // 新架构（原生外壳 + 系统 WebView）为默认；设置 MOTE_LEGACY_QT=1 可回退到
    // 旧的纯 Qt 文本引擎实现，便于对照与新架构出问题时临时绕过。
    if (qEnvironmentVariableIsSet("MOTE_LEGACY_QT")) {
        MarkdownViewer::MainWindow window;
        window.show();
        if (args.size() > 1)
            window.openFile(args.at(1));
        return app.exec();
    }

    WebWindow window;
    window.show();
    if (args.size() > 1)
        window.openFile(args.at(1));

    return app.exec();
}
