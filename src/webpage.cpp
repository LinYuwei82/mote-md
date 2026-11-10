#include "webpage.h"

#include <QByteArray>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>

namespace {

// 代码字体随包分发：把 qrc 里的 JetBrains Mono Light 以 base64 @font-face 注入页面。
// 页面由本地 HTML 载入，baseURL 指向文档目录，因此不能用 :/fonts/ 这样的
// 资源路径，只能内联成 data URI。
QString fontCss()
{
    static const QString css = [] {
        QFile font(QStringLiteral(":/fonts/JetBrainsMono-Light.ttf"));
        if (!font.open(QIODevice::ReadOnly))
            return QString();
        const QByteArray base64 = font.readAll().toBase64();
        return QStringLiteral("@font-face{font-family:'JetBrains Mono';"
                              "src:url(data:font/ttf;base64,%1) format('truetype');"
                              "font-weight:300;font-style:normal;font-display:block;}")
            .arg(QString::fromLatin1(base64));
    }();
    return css;
}

} // namespace

QString motePageHtml()
{
    static const QString html = [] {
        QFile tmpl(QStringLiteral(":/web/editor.html"));
        QFile css(QStringLiteral(":/web/editor.css"));
        QFile js(QStringLiteral(":/web/editor.js"));
        if (!tmpl.open(QIODevice::ReadOnly) || !css.open(QIODevice::ReadOnly)
            || !js.open(QIODevice::ReadOnly)) {
            return QStringLiteral("<html><body>缺少前端资源</body></html>");
        }
        QString page = QString::fromUtf8(tmpl.readAll());
        page.replace(QStringLiteral("__MOTE_CSS__"), fontCss() + QString::fromUtf8(css.readAll()));
        // 行内标记（阶段一）默认开启：标记常驻 DOM、零宽折叠。保留开关仅作应急
        // 回退——MOTE_INLINE_PROTO=0 / false / off / no 时回到「整块替换」旧行为。
        const QString raw = qEnvironmentVariable("MOTE_INLINE_PROTO").trimmed().toLower();
        const bool protoOff = raw == QStringLiteral("0") || raw == QStringLiteral("false")
            || raw == QStringLiteral("off") || raw == QStringLiteral("no");
        const QString flag = protoOff
            ? QStringLiteral("window.MOTE_INLINE_PROTO=false;")
            : QStringLiteral("window.MOTE_INLINE_PROTO=true;");
        page.replace(QStringLiteral("__MOTE_JS__"), flag + QString::fromUtf8(js.readAll()));
        return page;
    }();
    return html;
}

QString moteJsonLiteral(const QString &text)
{
    const QByteArray json = QJsonDocument(QJsonArray{text}).toJson(QJsonDocument::Compact);
    return QString::fromUtf8(json.mid(1, json.size() - 2));
}
