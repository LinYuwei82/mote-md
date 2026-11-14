// core/ 的无窗口单测：JSON 协议、消息分发、图片落盘、脏标记状态机。
// 不链接任何 UI 框架，ctest 直接跑。

#include "core/base64.h"
#include "core/command_table.h"
#include "core/editor_controller.h"
#include "core/image_store.h"
#include "core/js_bridge.h"
#include "core/json.h"
#include "core/paths.h"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using mote::EditorController;
using mote::EditorHost;
using mote::JsonValue;
using mote::ViewState;

static int gChecks = 0;
static int gFailures = 0;

static void reportFailure(const char *file, int line, const std::string &what)
{
    ++gFailures;
    std::fprintf(stderr, "FAIL %s:%d  %s\n", file, line, what.c_str());
}

#define CHECK(expr)                                                              \
    do {                                                                         \
        ++gChecks;                                                               \
        if (!(expr))                                                             \
            reportFailure(__FILE__, __LINE__, "断言失败：" #expr);                \
    } while (false)

template <typename A, typename B>
static void checkEqual(const A &actual, const B &expected, const char *file, int line,
                       const char *expression)
{
    ++gChecks;
    if (!(actual == expected)) {
        std::ostringstream message;
        message << expression << "\n  实际：" << actual << "\n  期望：" << expected;
        reportFailure(file, line, message.str());
    }
}

#define CHECK_EQ(actual, expected) checkEqual((actual), (expected), __FILE__, __LINE__, #actual)

class TestHost : public EditorHost
{
public:
    void evaluateJs(const std::string &script) override { scripts.push_back(script); }
    void loadPage(const std::string &baseDir) override { loadedDirs.push_back(baseDir); }

    void setClipboard(const std::string &text, const std::string &html) override
    {
        clipboardTextValue = text;
        clipboardHtmlValue = html;
    }
    std::string clipboardText() override { return clipboard; }
    void openExternal(const std::string &url) override { externalUrl = url; }
    void saveRequested(const std::string &text) override { savedText = text; }
    void openRequested() override { ++openCount; }
    void dropReceived(const std::string &name, const std::string &text) override
    {
        droppedName = name;
        droppedText = text;
    }
    void exportHtmlReady(const std::string &html) override { exportedHtml = html; }
    void exportPdfRequested(const std::string &path) override { pdfPaths.push_back(path); }
    void exportPdfFailed(const std::string &message) override { pdfFailure = message; }
    void fileDropRequested(const std::string &path) override { openedByDrop = path; }
    void statusMessage(const std::string &message) override { status = message; }
    void errorOccurred(const std::string &message) override { error = message; }
    void ready() override { ++readyCount; }
    void dirtyChanged(bool dirty) override { dirtyValues.push_back(dirty); }
    void viewStateChanged(const ViewState &state) override { view = state; }
    void statsChanged(int cjk, int words) override
    {
        statsCjk = cjk;
        statsWords = words;
    }
    void logMessage(const std::string &message) override { logs.push_back(message); }

    bool hasScript(const std::string &needle) const
    {
        for (const std::string &script : scripts) {
            if (script.find(needle) != std::string::npos)
                return true;
        }
        return false;
    }

    std::vector<std::string> scripts;
    std::vector<std::string> loadedDirs;
    std::vector<bool> dirtyValues;
    std::vector<std::string> pdfPaths;
    std::vector<std::string> logs;
    std::string clipboard;
    std::string clipboardTextValue;
    std::string clipboardHtmlValue;
    std::string externalUrl;
    std::string savedText;
    std::string droppedName;
    std::string droppedText;
    std::string exportedHtml;
    std::string pdfFailure;
    std::string openedByDrop;
    std::string status;
    std::string error;
    ViewState view;
    int statsCjk = -1;
    int statsWords = -1;
    int readyCount = 0;
    int openCount = 0;
};

static std::string makeTempDir()
{
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const fs::path dir = fs::temp_directory_path() / ("mote-core-tests-" + std::to_string(stamp));
    std::error_code error;
    fs::create_directories(dir, error);
    return dir.string();
}

static void testJson()
{
    JsonValue value;
    CHECK(mote::parseJson(
        R"({"type":"save","text":"a\nb","n":3,"ok":true,"arr":[1,2],"o":{"k":"中"}})", value));
    CHECK(value.isObject());
    CHECK_EQ(value.stringAt("type"), std::string("save"));
    CHECK_EQ(value.stringAt("text"), std::string("a\nb"));
    CHECK_EQ(value.numberAt("n"), 3.0);
    CHECK(value.boolAt("ok"));
    const JsonValue *array = value.find("arr");
    CHECK(array && array->isArray() && array->asArray().size() == 2);
    const JsonValue *object = value.find("o");
    CHECK(object && object->stringAt("k") == "中");
    CHECK_EQ(value.stringAt("missing", "fallback"), std::string("fallback"));

    // \u 转义与代理对
    JsonValue unicode;
    CHECK(mote::parseJson(R"("\u4e2d\ud83d\ude00")", unicode));
    CHECK_EQ(unicode.asString(), std::string("中😀"));

    JsonValue broken;
    CHECK(!mote::parseJson("{", broken));
    CHECK(!mote::parseJson(R"({"a":1} x)", broken));
    CHECK(!mote::parseJson("tru", broken));
    CHECK(!mote::parseJson("", broken));

    CHECK_EQ(mote::quoteJson("a\"b\nc\\d"), std::string(R"("a\"b\nc\\d")"));
}

static void testBase64()
{
    const std::vector<std::uint8_t> hello = mote::base64Decode("aGVsbG8=");
    CHECK_EQ(std::string(hello.begin(), hello.end()), std::string("hello"));

    // 页面可能带换行；与 Qt 的 fromBase64 一样容错
    const std::vector<std::uint8_t> wrapped = mote::base64Decode("aGVs\nbG8=");
    CHECK_EQ(std::string(wrapped.begin(), wrapped.end()), std::string("hello"));
    CHECK(mote::base64Decode("").empty());
}

static void testPaths()
{
    CHECK(mote::isMarkdownPath("/tmp/a.MD"));
    CHECK(mote::isMarkdownPath("a.txt"));
    CHECK(mote::isMarkdownPath("a.markdown"));
    CHECK(!mote::isMarkdownPath("a.pdf"));
    CHECK(mote::isImagePath("a.JPEG"));
    CHECK(mote::isImagePath("a.heic"));
    CHECK(!mote::isImagePath("a.svg"));

    CHECK_EQ(mote::fileNameOf("/x/y/a.md"), std::string("a.md"));
    CHECK_EQ(mote::extensionOf("a.tar.gz"), std::string("gz"));
    CHECK_EQ(mote::stemOf("a.tar.gz"), std::string("a.tar"));
    CHECK_EQ(mote::extensionOf(".gitignore"), std::string());
    CHECK_EQ(mote::fileNameOf("C:\\docs\\a.md"), std::string("a.md"));

    CHECK_EQ(mote::fileUrlForDirectory("/tmp/a b/"), std::string("file:///tmp/a%20b/"));
    CHECK_EQ(mote::fileUrlForDirectory("/tmp/doc"), std::string("file:///tmp/doc/"));
    CHECK_EQ(mote::fileUrlForDirectory("C:\\docs"), std::string("file:///C:/docs/"));
}

static void testImageStore()
{
    const std::string dir = makeTempDir();

    const mote::StoredImage first =
        mote::storeImage(dir, {1, 2, 3}, "image/png", "photo.jpeg", false);
    CHECK(first.ok);
    CHECK_EQ(first.relativePath, std::string("assets/photo.jpg"));
    CHECK(fs::exists(fs::path(dir) / first.relativePath));

    // 重名不覆盖：第二张退化成 -2
    const mote::StoredImage second =
        mote::storeImage(dir, {4}, "image/png", "photo.jpeg", false);
    CHECK(second.ok);
    CHECK_EQ(second.relativePath, std::string("assets/photo-2.jpg"));

    // 粘贴命名走固定时间戳（真实运行取当前时间）
    const mote::StoredImage paste =
        mote::storeImage(dir, {5}, "", "", true, "20260101-120000");
    CHECK(paste.ok);
    CHECK_EQ(paste.relativePath, std::string("assets/paste-20260101-120000.png"));

    // 写进去的字节与源一致
    std::ifstream in(fs::path(dir) / first.relativePath, std::ios::binary);
    const std::vector<std::uint8_t> readBack((std::istreambuf_iterator<char>(in)),
                                            std::istreambuf_iterator<char>());
    CHECK(readBack == std::vector<std::uint8_t>({1, 2, 3}));

    // 未命名文档：明确报错，不写任何位置
    const mote::StoredImage noDir = mote::storeImage("", {1}, "image/png", "x.png", false);
    CHECK(!noDir.ok);
    CHECK(noDir.error.find("请先保存") != std::string::npos);

    CHECK_EQ(mote::sanitizedBase("a b?.png"), std::string("a-b-"));
    CHECK_EQ(mote::sanitizedBase("..."), std::string("image"));
    CHECK_EQ(mote::imageExtension("image/jpeg", ""), std::string("jpg"));
    CHECK_EQ(mote::imageExtension("", "a.PNG"), std::string("png"));

    std::error_code error;
    fs::remove_all(dir, error);
}

static void testPendingMarkdown()
{
    TestHost host;
    EditorController controller(host);

    controller.setMarkdown("# hi", "/tmp/mote-doc");
    CHECK_EQ(host.loadedDirs.size(), static_cast<size_t>(1));
    CHECK_EQ(host.loadedDirs.at(0), std::string("/tmp/mote-doc"));
    CHECK_EQ(controller.pageGeneration(), static_cast<std::uint64_t>(1));
    CHECK(host.scripts.empty()); // ready 之前不注入正文

    controller.handleMessage(R"({"type":"ready"})");
    CHECK(controller.pageReady());
    CHECK_EQ(host.readyCount, 1);
    CHECK_EQ(host.scripts.size(), static_cast<size_t>(3));
    CHECK(host.scripts.at(0).find("createElement('base')") != std::string::npos);
    CHECK(host.scripts.at(1).find(R"(setMarkdown("# hi"))") != std::string::npos);
    CHECK(host.scripts.at(2).find(R"(setTheme("light"))") != std::string::npos);

    // 同一目录下再 push：立即注入，不重载页面
    host.scripts.clear();
    controller.setMarkdown("# hi 2", "/tmp/mote-doc");
    CHECK_EQ(host.loadedDirs.size(), static_cast<size_t>(1));
    CHECK_EQ(host.scripts.size(), static_cast<size_t>(1));
    CHECK(host.scripts.at(0).find(R"(setMarkdown("# hi 2"))") != std::string::npos);

    // 未命名文档：清 <base>，再让页面清空，不重载
    host.scripts.clear();
    controller.newDocument();
    CHECK(controller.baseDir().empty());
    CHECK_EQ(host.loadedDirs.size(), static_cast<size_t>(1));
    CHECK_EQ(host.scripts.size(), static_cast<size_t>(2));
    CHECK(host.scripts.at(0).find("removeChild") != std::string::npos);
    CHECK(host.scripts.at(1).find("newDocument()") != std::string::npos);
}

static void testChangeBaseDirReloads()
{
    TestHost host;
    EditorController controller(host);
    controller.setMarkdown("old", "/tmp/a");
    controller.handleMessage(R"({"type":"ready"})");
    controller.notifySaved("saved body");

    host.scripts.clear();
    controller.setBaseDir("/tmp/b");
    CHECK_EQ(controller.pageGeneration(), static_cast<std::uint64_t>(2));
    CHECK_EQ(host.loadedDirs.size(), static_cast<size_t>(2));
    CHECK_EQ(host.loadedDirs.at(1), std::string("/tmp/b"));

    // 换目录后页面重载：正文用最近一次保存的内容恢复
    controller.handleMessage(R"({"type":"ready"})");
    CHECK(host.hasScript(R"(setMarkdown("saved body"))"));
}

static void testMessageDispatch()
{
    TestHost host;
    EditorController controller(host);

    controller.handleMessage(R"({"type":"dirty","value":true})");
    CHECK(controller.dirty());
    CHECK_EQ(host.dirtyValues.size(), static_cast<size_t>(1));
    CHECK(host.dirtyValues.at(0));

    controller.handleMessage(R"({"type":"stats","cjk":12,"words":30})");
    CHECK_EQ(host.statsCjk, 12);
    CHECK_EQ(host.statsWords, 30);

    controller.handleMessage(R"({"type":"save","text":"body"})");
    CHECK_EQ(host.savedText, std::string("body"));

    controller.handleMessage(R"({"type":"clipboardWrite","text":"t","html":"<b>t</b>"})");
    CHECK_EQ(host.clipboardTextValue, std::string("t"));
    CHECK_EQ(host.clipboardHtmlValue, std::string("<b>t</b>"));

    controller.handleMessage(R"({"type":"openLink","href":"https://example.com"})");
    CHECK_EQ(host.externalUrl, std::string("https://example.com"));

    controller.handleMessage(R"({"type":"open"})");
    CHECK_EQ(host.openCount, 1);

    controller.handleMessage(R"({"type":"drop","name":"a.md","text":"# a"})");
    CHECK_EQ(host.droppedName, std::string("a.md"));
    CHECK_EQ(host.droppedText, std::string("# a"));

    controller.handleMessage(R"({"type":"status","message":"提示"})");
    CHECK_EQ(host.status, std::string("提示"));

    controller.handleMessage(R"({"type":"error","message":"出错"})");
    CHECK_EQ(host.error, std::string("出错"));

    controller.handleMessage(R"({"type":"log","message":"jslog"})");
    CHECK_EQ(host.logs.size(), static_cast<size_t>(1));

    controller.handleMessage(R"({"type":"view","toc":true,"source":false,"zoom":1.5})");
    CHECK(host.view.toc);
    CHECK(!host.view.source);
    CHECK_EQ(host.view.zoom, 1.5);

    controller.handleMessage(R"({"type":"export","html":"<html>x</html>"})");
    CHECK_EQ(host.exportedHtml, std::string("<html>x</html>"));

    // 坏消息不应产生任何回调
    const size_t scriptsBefore = host.scripts.size();
    controller.handleMessage("not json");
    controller.handleMessage(R"({"type":"unknown"})");
    CHECK_EQ(host.scripts.size(), scriptsBefore);
}

static void testDirtyTracking()
{
    TestHost host;
    EditorController controller(host);

    controller.handleMessage(R"({"type":"dirty","value":true})");
    CHECK(controller.dirty());

    controller.notifySaved("abc");
    CHECK(!controller.dirty());
    CHECK_EQ(controller.lastSavedText(), std::string("abc"));
    CHECK_EQ(host.dirtyValues.back(), false);
    CHECK(host.hasScript(R"(markSaved("abc"))"));

    // 撤销回保存点：页面回报 false，状态保持一致
    controller.handleMessage(R"({"type":"dirty","value":false})");
    CHECK(!controller.dirty());
}

static void testClipboardCommands()
{
    TestHost host;
    EditorController controller(host);

    host.clipboard = "hello";
    controller.clipboardCommand("paste");
    CHECK(host.hasScript(R"(clipboardPaste("hello"))"));

    host.clipboard.clear();
    controller.clipboardCommand("paste");
    CHECK_EQ(host.status, std::string("剪贴板里没有可粘贴的文本"));

    controller.clipboardCommand("cut");
    CHECK(host.scripts.back().find("clipboardCopy(true)") != std::string::npos);
    controller.clipboardCommand("copy");
    CHECK(host.scripts.back().find("clipboardCopy(false)") != std::string::npos);
}

static void testImageMessages()
{
    const std::string dir = makeTempDir();
    TestHost host;
    EditorController controller(host);
    controller.setMarkdown("", dir);
    controller.handleMessage(R"({"type":"ready"})");
    host.scripts.clear();

    // AQID = 0x01 0x02 0x03
    controller.handleMessage(
        R"({"type":"image","data":"AQID","mime":"image/png","source":"paste"})");
    CHECK(host.hasScript("insertImage(\"assets/paste-"));
    CHECK(host.status.find("已保存图片：assets/paste-") != std::string::npos);

    controller.handleMessage(R"({"type":"image","data":"","mime":"image/png"})");
    CHECK_EQ(host.status, std::string("图片未插入：剪贴板内容为空"));

    // 原生拖入图片：读文件 → 落盘 → 插入
    const fs::path imagePath = fs::path(dir) / "dropped.png";
    {
        std::ofstream out(imagePath, std::ios::binary);
        out.write("\x89PNG", 4);
    }
    CHECK(controller.acceptsNativeFileDrop({imagePath.string()}));
    CHECK(controller.handleNativeFileDrop({imagePath.string()}));
    CHECK(fs::exists(fs::path(dir) / "assets" / "dropped.png"));
    CHECK(host.hasScript("insertImage(\"assets/dropped.png\")"));

    // 原生拖入 .md：交给外壳打开
    CHECK(controller.handleNativeFileDrop({"/tmp/notes.md"}));
    CHECK(host.openedByDrop.find("notes.md") != std::string::npos);
    CHECK(!controller.acceptsNativeFileDrop({"/tmp/a.pdf"}));

    std::error_code error;
    fs::remove_all(dir, error);
}

static void testPdfPending()
{
    TestHost host;
    EditorController controller(host);

    controller.requestExportPdf("");
    CHECK_EQ(host.pdfFailure, std::string("导出失败：没有指定保存位置"));

    // 页面未就绪：先记下，ready 后再导出
    controller.setMarkdown("x", "/tmp/a");
    controller.requestExportPdf("/tmp/out.pdf");
    CHECK(host.pdfPaths.empty());
    CHECK_EQ(controller.pendingPdfPath(), std::string("/tmp/out.pdf"));

    controller.handleMessage(R"({"type":"ready"})");
    CHECK_EQ(host.pdfPaths.size(), static_cast<size_t>(1));
    CHECK_EQ(host.pdfPaths.at(0), std::string("/tmp/out.pdf"));
    CHECK(controller.pendingPdfPath().empty());

    controller.requestExportPdf("/tmp/out2.pdf");
    CHECK_EQ(host.pdfPaths.size(), static_cast<size_t>(2));
}

static void testCommandTable()
{
    using mote::CommandId;
    using mote::CommandSpec;
    using mote::MenuSpec;

    const std::vector<MenuSpec> &menus = mote::menus();
    CHECK_EQ(menus.size(), static_cast<size_t>(4));
    CHECK_EQ(menus.at(0).title, std::string("文件"));
    CHECK_EQ(menus.at(1).title, std::string("编辑"));
    CHECK_EQ(menus.at(2).title, std::string("格式"));
    CHECK_EQ(menus.at(3).title, std::string("视图"));

    // 每个菜单项都能解析出规格，且同一命令只出现一次
    std::vector<CommandId> seen;
    std::set<std::string> shortcuts;
    for (const MenuSpec &menu : menus) {
        for (const CommandId id : menu.items) {
            if (id == CommandId::Separator)
                continue;
            const CommandSpec *spec = mote::findCommand(id);
            CHECK(spec != nullptr);
            if (!spec)
                continue;
            bool duplicated = false;
            for (const CommandId previous : seen) {
                if (previous == id)
                    duplicated = true;
            }
            CHECK(!duplicated);
            seen.push_back(id);

            CHECK(!spec->title.empty());
            for (const std::string &shortcut : spec->shortcuts) {
                // 快捷键全局唯一：新增命令时最容易在这里发现冲突
                CHECK(shortcuts.insert(shortcut).second);
            }
            if (spec->disabledInSource)
                CHECK(id == CommandId::ExportPdf);
        }
    }
    CHECK_EQ(seen.size(), static_cast<size_t>(33));

    // 格式项与前端 formatAction 的名称必须逐字一致
    const CommandSpec *inlineCode = mote::findCommand(CommandId::FormatInlineCode);
    CHECK(inlineCode && inlineCode->formatAction == "inlineCode");
    const CommandSpec *paragraph = mote::findCommand(CommandId::FormatParagraph);
    CHECK(paragraph && paragraph->formatAction == "paragraph" && paragraph->shortcuts.empty());
    const CommandSpec *hr = mote::findCommand(CommandId::FormatHr);
    CHECK(hr && hr->formatAction == "hr" && hr->shortcuts.empty());

    // 可勾选项与多快捷键
    const CommandSpec *toc = mote::findCommand(CommandId::ToggleToc);
    CHECK(toc && toc->checkable && toc->shortcuts.at(0) == "cmd+shift+l");
    const CommandSpec *source = mote::findCommand(CommandId::ToggleSource);
    CHECK(source && source->shortcuts.size() == 2 && source->shortcuts.at(1) == "cmd+/");
    const CommandSpec *zoomIn = mote::findCommand(CommandId::ZoomIn);
    CHECK(zoomIn && zoomIn->shortcuts.size() == 3);

    // 视图菜单顺序（目录 → 源码 → 分隔 → 深色 → 跟随 → 分隔 → 缩放三连）
    const std::vector<CommandId> &view = menus.at(3).items;
    CHECK_EQ(view.size(), static_cast<size_t>(9));
    CHECK(view.at(0) == CommandId::ToggleToc);
    CHECK(view.at(2) == CommandId::Separator);
    CHECK(view.at(8) == CommandId::ZoomReset);
}

int main()
{
    testJson();
    testBase64();
    testPaths();
    testImageStore();
    testPendingMarkdown();
    testChangeBaseDirReloads();
    testMessageDispatch();
    testDirtyTracking();
    testClipboardCommands();
    testImageMessages();
    testPdfPending();
    testCommandTable();

    if (gFailures == 0) {
        std::printf("core 单测通过：%d 项断言\n", gChecks);
        return 0;
    }
    std::fprintf(stderr, "core 单测失败：%d/%d\n", gFailures, gChecks);
    return 1;
}
