#include "codehighlighter.h"

#include <QColor>
#include <QHash>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QStringView>
#include <QTextBlock>
#include <QTextBlockFormat>
#include <QTextCharFormat>
#include <QTextCursor>
#include <QTextDocument>
#include <QTextFormat>
#include <QVector>

namespace MarkdownViewer {

namespace {

enum class Kind {
    Plain = 0,
    Keyword,
    Type,
    Function,
    String,
    Comment,
    Number,
};

enum class Family {
    None,
    Cpp,
    Python,
    JavaScript,
    Json,
    Html,
    Shell,
    Sql,
    CMake,
    Markdown,
};

// 浅色主题下的取色：与工具栏、代码块底色的明度接近，避免刺眼
const QColor &colorFor(Kind kind)
{
    static const QColor keyword(0xcf, 0x22, 0x2e);  // 红
    static const QColor type(0x95, 0x38, 0x00);     // 棕
    static const QColor function(0x82, 0x50, 0xdf); // 紫
    static const QColor string(0x0a, 0x30, 0x69);   // 深蓝
    static const QColor comment(0x6e, 0x77, 0x81);  // 灰
    static const QColor number(0x05, 0x50, 0xae);   // 蓝
    static const QColor plain;

    switch (kind) {
    case Kind::Keyword:  return keyword;
    case Kind::Type:     return type;
    case Kind::Function: return function;
    case Kind::String:   return string;
    case Kind::Comment:  return comment;
    case Kind::Number:   return number;
    case Kind::Plain:    break;
    }
    return plain;
}

// 跨行结构（块注释、三引号字符串）在行与行之间保留的状态
struct Carry {
    QString end;                  // 非空表示下一行仍在该结构内部
    Kind kind = Kind::Comment;
};

struct Span {
    int start = 0;
    int length = 0;
    Kind kind = Kind::Plain;
};

QSet<QString> makeSet(const char *words)
{
    QSet<QString> set;
    const QStringList list = QString::fromLatin1(words).split(QLatin1Char(' '), Qt::SkipEmptyParts);
    for (const QString &word : list)
        set.insert(word);
    return set;
}

bool at(const QString &text, int pos, const QString &marker)
{
    return QStringView(text).mid(pos).startsWith(marker);
}

bool isIdentStart(QChar c)
{
    return c.isLetter() || c == QLatin1Char('_');
}

bool isIdentChar(QChar c)
{
    return c.isLetterOrNumber() || c == QLatin1Char('_');
}

// 数字：十进制/十六进制/二进制，含小数、指数与常见后缀
int scanNumber(const QString &text, int pos)
{
    const int size = text.size();
    int j = pos;

    if (j + 1 < size && text.at(j) == QLatin1Char('0')
        && (text.at(j + 1) == QLatin1Char('x') || text.at(j + 1) == QLatin1Char('X'))) {
        j += 2;
        while (j < size && (text.at(j).isDigit()
                            || QStringLiteral("abcdefABCDEF").contains(text.at(j))))
            ++j;
        return j - pos;
    }
    if (j + 1 < size && text.at(j) == QLatin1Char('0')
        && (text.at(j + 1) == QLatin1Char('b') || text.at(j + 1) == QLatin1Char('B'))) {
        j += 2;
        while (j < size && (text.at(j) == QLatin1Char('0') || text.at(j) == QLatin1Char('1')))
            ++j;
        return j - pos;
    }

    bool hasDigits = false;
    while (j < size && text.at(j).isDigit()) {
        ++j;
        hasDigits = true;
    }
    if (j < size && text.at(j) == QLatin1Char('.') && j + 1 < size && text.at(j + 1).isDigit()) {
        ++j;
        while (j < size && text.at(j).isDigit())
            ++j;
    }
    if (j < size && (text.at(j) == QLatin1Char('e') || text.at(j) == QLatin1Char('E'))) {
        int k = j + 1;
        if (k < size && (text.at(k) == QLatin1Char('+') || text.at(k) == QLatin1Char('-')))
            ++k;
        if (k < size && text.at(k).isDigit()) {
            j = k;
            while (j < size && text.at(j).isDigit())
                ++j;
        }
    }
    while (j < size && QStringLiteral("fFuUlL").contains(text.at(j)))
        ++j;
    return hasDigits ? j - pos : 0;
}

Family familyForTag(const QString &tag)
{
    QString t = tag.trimmed().toLower();
    if (t.startsWith(QLatin1Char('{'))) { // ```{.cpp} 这类写法
        const int end = t.indexOf(QLatin1Char('}'));
        if (end > 1)
            t = t.mid(1, end - 1).trimmed();
    }
    if (t.startsWith(QLatin1Char('.')))
        t = t.mid(1);
    if (t.isEmpty())
        return Family::None;

    static const QHash<QString, Family> aliases = {
        {QStringLiteral("c"), Family::Cpp},
        {QStringLiteral("h"), Family::Cpp},
        {QStringLiteral("cc"), Family::Cpp},
        {QStringLiteral("cpp"), Family::Cpp},
        {QStringLiteral("c++"), Family::Cpp},
        {QStringLiteral("cxx"), Family::Cpp},
        {QStringLiteral("hpp"), Family::Cpp},
        {QStringLiteral("hh"), Family::Cpp},
        {QStringLiteral("objc"), Family::Cpp},
        {QStringLiteral("objective-c"), Family::Cpp},
        {QStringLiteral("java"), Family::Cpp},
        {QStringLiteral("csharp"), Family::Cpp},
        {QStringLiteral("c#"), Family::Cpp},
        {QStringLiteral("cs"), Family::Cpp},
        {QStringLiteral("go"), Family::Cpp},
        {QStringLiteral("golang"), Family::Cpp},
        {QStringLiteral("rust"), Family::Cpp},
        {QStringLiteral("rs"), Family::Cpp},
        {QStringLiteral("kotlin"), Family::Cpp},
        {QStringLiteral("kt"), Family::Cpp},
        {QStringLiteral("swift"), Family::Cpp},
        {QStringLiteral("py"), Family::Python},
        {QStringLiteral("python"), Family::Python},
        {QStringLiteral("python3"), Family::Python},
        {QStringLiteral("py3"), Family::Python},
        {QStringLiteral("js"), Family::JavaScript},
        {QStringLiteral("javascript"), Family::JavaScript},
        {QStringLiteral("jsx"), Family::JavaScript},
        {QStringLiteral("mjs"), Family::JavaScript},
        {QStringLiteral("cjs"), Family::JavaScript},
        {QStringLiteral("node"), Family::JavaScript},
        {QStringLiteral("ts"), Family::JavaScript},
        {QStringLiteral("typescript"), Family::JavaScript},
        {QStringLiteral("tsx"), Family::JavaScript},
        {QStringLiteral("json"), Family::Json},
        {QStringLiteral("json5"), Family::Json},
        {QStringLiteral("jsonc"), Family::Json},
        {QStringLiteral("html"), Family::Html},
        {QStringLiteral("htm"), Family::Html},
        {QStringLiteral("xml"), Family::Html},
        {QStringLiteral("xhtml"), Family::Html},
        {QStringLiteral("svg"), Family::Html},
        {QStringLiteral("xaml"), Family::Html},
        {QStringLiteral("plist"), Family::Html},
        {QStringLiteral("vue"), Family::Html},
        {QStringLiteral("sh"), Family::Shell},
        {QStringLiteral("bash"), Family::Shell},
        {QStringLiteral("shell"), Family::Shell},
        {QStringLiteral("zsh"), Family::Shell},
        {QStringLiteral("console"), Family::Shell},
        {QStringLiteral("shell-session"), Family::Shell},
        {QStringLiteral("shellsession"), Family::Shell},
        {QStringLiteral("sql"), Family::Sql},
        {QStringLiteral("mysql"), Family::Sql},
        {QStringLiteral("postgresql"), Family::Sql},
        {QStringLiteral("postgres"), Family::Sql},
        {QStringLiteral("pgsql"), Family::Sql},
        {QStringLiteral("sqlite"), Family::Sql},
        {QStringLiteral("plsql"), Family::Sql},
        {QStringLiteral("cmake"), Family::CMake},
        {QStringLiteral("cmakelists.txt"), Family::CMake},
        {QStringLiteral("md"), Family::Markdown},
        {QStringLiteral("markdown"), Family::Markdown},
        {QStringLiteral("mdown"), Family::Markdown},
    };

    return aliases.value(t, Family::None);
}

const QSet<QString> &keywordSet(Family family)
{
    static const QSet<QString> cLike = makeSet(
        // C / C++
        "alignas alignof and and_eq asm break case catch class compl concept const consteval "
        "constexpr constinit const_cast continue co_await co_return co_yield decltype default delete "
        "do dynamic_cast else enum explicit export extern false for friend goto if inline mutable "
        "namespace new noexcept not not_eq nullptr operator or or_eq private protected public register "
        "reinterpret_cast requires return static static_assert static_cast struct switch template this "
        "thread_local throw true try typedef typeid typename union using virtual volatile while xor xor_eq "
        "override final "
        // Java / C# / Go / Rust 等同类语法的常见关键字
        "abstract async await boolean byte extends implements import instanceof interface package "
        "synchronized throws transient native sealed record var val fun object when data open internal "
        "fn impl let mut pub trait crate mod match loop in where dyn unsafe use type ref self "
        "namespace readonly partial is params get set yield from as with");
    static const QSet<QString> python = makeSet(
        "False None True and as assert async await break class continue def del elif else except finally "
        "for from global if import in is lambda nonlocal not or pass raise return try while with yield "
        "match case");
    static const QSet<QString> javascript = makeSet(
        "async await break case catch class const continue debugger default delete do else enum export "
        "extends finally for from function get if implements import in instanceof interface let new null "
        "of private protected public return set static super switch this throw true false try typeof "
        "undefined var void while with yield as namespace declare readonly abstract keyof infer satisfies");
    static const QSet<QString> json = makeSet("true false null");
    static const QSet<QString> shell = makeSet(
        "if then else elif fi for while until do done in case esac select function time return local "
        "export unset readonly declare typeset source alias eval exec exit shift trap set true false");
    static const QSet<QString> sql = makeSet(
        "select from where insert into values update set delete create table index view drop alter add "
        "column join inner left right outer full cross on as group by order having limit offset union all "
        "distinct and or not null is like between exists case when then else end begin commit rollback "
        "transaction primary key foreign references default constraint unique check procedure function "
        "trigger database use show describe explain if elsif while declare cursor with recursive asc desc");
    static const QSet<QString> cmake = makeSet(
        "if elseif else endif foreach endforeach function endfunction macro endmacro while endwhile "
        "return break continue");

    switch (family) {
    case Family::Cpp:        return cLike;
    case Family::Python:     return python;
    case Family::JavaScript: return javascript;
    case Family::Json:       return json;
    case Family::Shell:      return shell;
    case Family::Sql:        return sql;
    case Family::CMake:      return cmake;
    default:                 break;
    }
    static const QSet<QString> empty;
    return empty;
}

const QSet<QString> &typeSet(Family family)
{
    static const QSet<QString> cLike = makeSet(
        "void bool char wchar_t char8_t char16_t char32_t short int long float double signed unsigned "
        "auto size_t ssize_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t "
        "string wstring vector map unordered_map set unordered_set optional variant pair tuple "
        "unique_ptr shared_ptr weak_ptr function "
        "QString QStringList QByteArray QVector QList QMap QHash QTextDocument QTextBrowser QWidget "
        "QAction QFile QFileInfo QFont QColor QUrl");
    static const QSet<QString> python = makeSet(
        "int float complex str bytes bytearray bool list dict set frozenset tuple range object type self "
        "cls Exception ValueError TypeError KeyError IndexError RuntimeError super property classmethod "
        "staticmethod enumerate zip map filter len sum min max sorted reversed open print isinstance "
        "issubclass");
    static const QSet<QString> javascript = makeSet(
        "string number boolean object any unknown never void symbol bigint String Number Boolean Array "
        "Object Promise Map Set WeakMap WeakSet JSON Date RegExp Error Symbol Function HTMLElement Element");
    static const QSet<QString> sql = makeSet(
        "int integer bigint smallint tinyint decimal numeric float double real char varchar nchar text "
        "date time datetime timestamp boolean blob json uuid serial");
    static const QSet<QString> shell = makeSet("PATH HOME PWD USER SHELL");

    switch (family) {
    case Family::Cpp:        return cLike;
    case Family::Python:     return python;
    case Family::JavaScript: return javascript;
    case Family::Sql:        return sql;
    case Family::Shell:      return shell;
    default:                 break;
    }
    static const QSet<QString> empty;
    return empty;
}

struct LangSpec {
    QStringList lineComments;
    QString blockCommentStart;
    QString blockCommentEnd;
    QStringList stringDelims;
    QStringList multiLineStrings;
    bool caseInsensitive = false;
    bool preprocessor = false;
    bool dollarVariables = false;
    bool jsonKeys = false;
    bool shellAssignment = false;
    bool shellCommand = false;
};

LangSpec specFor(Family family)
{
    LangSpec spec;
    switch (family) {
    case Family::Cpp:
        spec.lineComments = {QStringLiteral("//")};
        spec.blockCommentStart = QStringLiteral("/*");
        spec.blockCommentEnd = QStringLiteral("*/");
        spec.stringDelims = {QStringLiteral("\""), QStringLiteral("'")};
        spec.preprocessor = true;
        break;
    case Family::Python:
        spec.lineComments = {QStringLiteral("#")};
        spec.stringDelims = {QStringLiteral("\""), QStringLiteral("'")};
        spec.multiLineStrings = {QStringLiteral("\"\"\""), QStringLiteral("'''")};
        break;
    case Family::JavaScript:
        spec.lineComments = {QStringLiteral("//")};
        spec.blockCommentStart = QStringLiteral("/*");
        spec.blockCommentEnd = QStringLiteral("*/");
        spec.stringDelims = {QStringLiteral("\""), QStringLiteral("'")};
        spec.multiLineStrings = {QStringLiteral("`")};
        break;
    case Family::Json:
        spec.stringDelims = {QStringLiteral("\"")};
        spec.jsonKeys = true;
        break;
    case Family::Shell:
        spec.lineComments = {QStringLiteral("#")};
        spec.stringDelims = {QStringLiteral("\""), QStringLiteral("'"), QStringLiteral("`")};
        spec.dollarVariables = true;
        spec.shellAssignment = true;
        spec.shellCommand = true;
        break;
    case Family::Sql:
        spec.lineComments = {QStringLiteral("--")};
        spec.blockCommentStart = QStringLiteral("/*");
        spec.blockCommentEnd = QStringLiteral("*/");
        spec.stringDelims = {QStringLiteral("'"), QStringLiteral("\"")};
        spec.caseInsensitive = true;
        break;
    case Family::CMake:
        spec.lineComments = {QStringLiteral("#")};
        spec.stringDelims = {QStringLiteral("\"")};
        spec.dollarVariables = true;
        spec.caseInsensitive = true;
        break;
    default:
        break;
    }
    return spec;
}

void scanGeneric(const QString &text, Family family, const LangSpec &spec, Carry &carry,
                 QVector<Span> &spans)
{
    const QSet<QString> &keywords = keywordSet(family);
    const QSet<QString> &types = typeSet(family);
    const int size = text.size();
    int i = 0;

    // 上一行没有结束的块注释 / 多行字符串
    if (!carry.end.isEmpty()) {
        const int end = text.indexOf(carry.end);
        if (end < 0) {
            spans.append({0, size, carry.kind});
            return;
        }
        const int stop = end + carry.end.size();
        spans.append({0, stop, carry.kind});
        carry.end.clear();
        i = stop;
    }

    int firstNonSpace = 0;
    while (firstNonSpace < size && text.at(firstNonSpace).isSpace())
        ++firstNonSpace;

    while (i < size) {
        const QChar c = text.at(i);

        // 行注释
        bool matched = false;
        for (const QString &marker : spec.lineComments) {
            if (at(text, i, marker)) {
                spans.append({i, size - i, Kind::Comment});
                return;
            }
        }

        // 块注释（可跨行）
        if (!spec.blockCommentStart.isEmpty() && at(text, i, spec.blockCommentStart)) {
            const int from = i + spec.blockCommentStart.size();
            const int end = text.indexOf(spec.blockCommentEnd, from);
            if (end < 0) {
                spans.append({i, size - i, Kind::Comment});
                carry.end = spec.blockCommentEnd;
                carry.kind = Kind::Comment;
                return;
            }
            const int stop = end + spec.blockCommentEnd.size();
            spans.append({i, stop - i, Kind::Comment});
            i = stop;
            continue;
        }

        // 可跨行的字符串（Python 三引号、JS 模板串）
        for (const QString &marker : spec.multiLineStrings) {
            if (!at(text, i, marker))
                continue;
            const int end = text.indexOf(marker, i + marker.size());
            if (end < 0) {
                spans.append({i, size - i, Kind::String});
                carry.end = marker;
                carry.kind = Kind::String;
                return;
            }
            const int stop = end + marker.size();
            spans.append({i, stop - i, Kind::String});
            i = stop;
            matched = true;
            break;
        }
        if (matched)
            continue;

        // 单行字符串
        for (const QString &marker : spec.stringDelims) {
            if (!at(text, i, marker))
                continue;
            const QChar quote = marker.at(0);
            int j = i + marker.size();
            bool escaped = false;
            while (j < size) {
                const QChar ch = text.at(j);
                if (escaped)
                    escaped = false;
                else if (ch == QLatin1Char('\\'))
                    escaped = true;
                else if (ch == quote) {
                    ++j;
                    break;
                }
                ++j;
            }
            const int stop = qMin(j, size);
            Kind kind = Kind::String;
            if (spec.jsonKeys) {
                int k = stop;
                while (k < size && text.at(k).isSpace())
                    ++k;
                if (k < size && text.at(k) == QLatin1Char(':'))
                    kind = Kind::Type; // JSON 的键
            }
            spans.append({i, stop - i, kind});
            i = stop;
            matched = true;
            break;
        }
        if (matched)
            continue;

        // C/C++ 预处理指令
        if (spec.preprocessor && c == QLatin1Char('#') && i == firstNonSpace) {
            int j = i + 1;
            while (j < size && text.at(j).isSpace())
                ++j;
            while (j < size && text.at(j).isLetter())
                ++j;
            spans.append({i, j - i, Kind::Keyword});
            i = j;
            continue;
        }

        // ${变量}（CMake、Shell）
        if (spec.dollarVariables && c == QLatin1Char('$') && at(text, i, QStringLiteral("${"))) {
            const int end = text.indexOf(QLatin1Char('}'), i + 2);
            if (end > 0) {
                spans.append({i, end + 1 - i, Kind::Type});
                i = end + 1;
                continue;
            }
        }

        // 数字
        if (c.isDigit() && (i == 0 || !isIdentChar(text.at(i - 1)))) {
            const int length = scanNumber(text, i);
            if (length > 0) {
                spans.append({i, length, Kind::Number});
                i += length;
                continue;
            }
        }

        // 标识符：关键字 / 类型 / 函数名
        if (isIdentStart(c)) {
            int j = i;
            while (j < size && isIdentChar(text.at(j)))
                ++j;
            const QString ident = text.mid(i, j - i);
            const QString key = spec.caseInsensitive ? ident.toLower() : ident;

            int k = j;
            while (k < size && text.at(k) == QLatin1Char(' '))
                ++k;
            const bool followedByParen = k < size && text.at(k) == QLatin1Char('(');
            const bool followedByEqual = k < size && text.at(k) == QLatin1Char('=');

            Kind kind = Kind::Plain;
            if (keywords.contains(key))
                kind = Kind::Keyword;
            else if (types.contains(key))
                kind = Kind::Type;
            else if (spec.shellAssignment && followedByEqual)
                kind = Kind::Type;
            else if (followedByParen)
                kind = Kind::Function;
            else if (spec.shellCommand && i == firstNonSpace)
                kind = Kind::Function; // Shell 行首命令

            if (kind != Kind::Plain)
                spans.append({i, j - i, kind});
            i = j;
            continue;
        }

        ++i;
    }
}

void scanHtml(const QString &text, Carry &carry, QVector<Span> &spans)
{
    const int size = text.size();
    int i = 0;

    if (!carry.end.isEmpty()) { // 跨行 HTML 注释
        const int end = text.indexOf(carry.end);
        if (end < 0) {
            spans.append({0, size, Kind::Comment});
            return;
        }
        const int stop = end + carry.end.size();
        spans.append({0, stop, Kind::Comment});
        carry.end.clear();
        i = stop;
    }

    while (i < size) {
        if (at(text, i, QStringLiteral("<!--"))) {
            const int end = text.indexOf(QStringLiteral("-->"), i + 4);
            if (end < 0) {
                spans.append({i, size - i, Kind::Comment});
                carry.end = QStringLiteral("-->");
                carry.kind = Kind::Comment;
                return;
            }
            const int stop = end + 3;
            spans.append({i, stop - i, Kind::Comment});
            i = stop;
            continue;
        }

        if (text.at(i) == QLatin1Char('<')) {
            int j = i + 1;
            if (j < size && (text.at(j) == QLatin1Char('/') || text.at(j) == QLatin1Char('?')))
                ++j;
            if (j < size && text.at(j) == QLatin1Char('!')) { // <!DOCTYPE ...>
                const int end = text.indexOf(QLatin1Char('>'), j);
                const int stop = end < 0 ? size : end + 1;
                spans.append({i, stop - i, Kind::Keyword});
                i = stop;
                continue;
            }
            const int nameStart = j;
            while (j < size && (text.at(j).isLetterOrNumber() || text.at(j) == QLatin1Char('-')
                                || text.at(j) == QLatin1Char(':') || text.at(j) == QLatin1Char('_')))
                ++j;
            if (j > nameStart) {
                spans.append({i, j - i, Kind::Keyword});
                i = j;
                continue;
            }
        }

        const QChar c = text.at(i);
        if (c == QLatin1Char('"') || c == QLatin1Char('\'')) {
            int j = i + 1;
            while (j < size && text.at(j) != c)
                ++j;
            const int stop = j < size ? j + 1 : size;
            spans.append({i, stop - i, Kind::String});
            i = stop;
            continue;
        }

        if (isIdentStart(c) && i > 0 && text.at(i - 1).isSpace()) { // 属性名
            int j = i;
            while (j < size && isIdentChar(text.at(j)))
                ++j;
            int k = j;
            while (k < size && text.at(k).isSpace())
                ++k;
            if (k < size && text.at(k) == QLatin1Char('='))
                spans.append({i, j - i, Kind::Type});
            i = j;
            continue;
        }

        ++i;
    }
}

void scanMarkdown(const QString &text, QVector<Span> &spans)
{
    const int size = text.size();
    int firstNonSpace = 0;
    while (firstNonSpace < size && text.at(firstNonSpace) == QLatin1Char(' '))
        ++firstNonSpace;

    // 标题整行
    if (firstNonSpace < size && text.at(firstNonSpace) == QLatin1Char('#')) {
        int level = firstNonSpace;
        while (level < size && text.at(level) == QLatin1Char('#'))
            ++level;
        if (level - firstNonSpace <= 6 && (level == size || text.at(level) == QLatin1Char(' '))) {
            spans.append({firstNonSpace, size - firstNonSpace, Kind::Keyword});
            return;
        }
    }

    // 列表标记与引用标记
    if (firstNonSpace < size) {
        const QChar c = text.at(firstNonSpace);
        if (c == QLatin1Char('>'))
            spans.append({firstNonSpace, 1, Kind::Comment});
        else if ((c == QLatin1Char('-') || c == QLatin1Char('*') || c == QLatin1Char('+'))
                 && firstNonSpace + 1 < size && text.at(firstNonSpace + 1) == QLatin1Char(' '))
            spans.append({firstNonSpace, 1, Kind::Keyword});
        else if (c.isDigit()) {
            int j = firstNonSpace;
            while (j < size && text.at(j).isDigit())
                ++j;
            if (j < size && (text.at(j) == QLatin1Char('.') || text.at(j) == QLatin1Char(')')))
                spans.append({firstNonSpace, j + 1 - firstNonSpace, Kind::Keyword});
        }
    }

    int i = 0;
    while (i < size) {
        const QChar c = text.at(i);

        if (c == QLatin1Char('`')) { // 行内代码
            int tickCount = 0;
            while (i + tickCount < size && text.at(i + tickCount) == QLatin1Char('`'))
                ++tickCount;
            const QString fence(tickCount, QLatin1Char('`'));
            const int end = text.indexOf(fence, i + tickCount);
            if (end < 0) {
                ++i;
                continue;
            }
            const int stop = end + tickCount;
            spans.append({i, stop - i, Kind::String});
            i = stop;
            continue;
        }

        if (c == QLatin1Char('[')) { // [文字](链接)
            const int close = text.indexOf(QStringLiteral("]("), i + 1);
            if (close > 0) {
                const int urlEnd = text.indexOf(QLatin1Char(')'), close + 2);
                if (urlEnd > 0) {
                    spans.append({i, close - i + 1, Kind::Function});
                    spans.append({close + 2, urlEnd - close - 2, Kind::Type});
                    i = urlEnd + 1;
                    continue;
                }
            }
        }

        ++i;
    }
}

void applySpans(QTextDocument *doc, const QTextBlock &block, const QVector<Span> &spans)
{
    const int blockStart = block.position();
    const int blockEnd = blockStart + block.text().size();
    for (const Span &span : spans) {
        if (span.kind == Kind::Plain || span.length <= 0)
            continue;
        const int from = blockStart + span.start;
        const int to = qMin(from + span.length, blockEnd);
        if (from >= to || from < blockStart)
            continue;

        QTextCursor cursor(doc);
        cursor.setPosition(from);
        cursor.setPosition(to, QTextCursor::KeepAnchor);

        QTextCharFormat format;
        format.setForeground(colorFor(span.kind));
        cursor.mergeCharFormat(format);
    }
}

} // namespace

void applySyntaxHighlighting(QTextDocument *doc)
{
    if (!doc)
        return;

    Carry carry;
    Family current = Family::None;
    QVector<Span> spans;

    for (QTextBlock block = doc->begin(); block.isValid(); block = block.next()) {
        const QTextBlockFormat format = block.blockFormat();
        if (!format.nonBreakableLines()) {
            carry = Carry();
            current = Family::None;
            continue;
        }

        const Family family =
            familyForTag(format.property(QTextFormat::BlockCodeLanguage).toString());
        if (family != current) { // 不同语言之间不共享跨行状态
            carry = Carry();
            current = family;
        }
        if (family == Family::None)
            continue;

        const QString text = block.text();
        if (text.isEmpty())
            continue;

        spans.clear();
        if (family == Family::Html)
            scanHtml(text, carry, spans);
        else if (family == Family::Markdown)
            scanMarkdown(text, spans);
        else
            scanGeneric(text, family, specFor(family), carry, spans);

        applySpans(doc, block, spans);
    }
}

} // namespace MarkdownViewer
