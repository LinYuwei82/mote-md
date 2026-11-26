// core/ 的无窗口单测：JSON 协议、消息分发、图片落盘、脏标记状态机、
// v2 更新清单解析与 Ed25519 验签（与 tools/release/manifest_v2.py 交叉验证）。
// 不链接任何 UI 框架，ctest 直接跑。

#include "core/base64.h"
#include "core/block_layout.h"
#include "core/command_table.h"
#include "core/editor_controller.h"
#include "core/image_store.h"
#include "core/inject_chunks.h"
#include "core/js_bridge.h"
#include "core/json.h"
#include "core/paths.h"
#include "core/text_encoding.h"
#include "mote/update.h"
#include "mote/verify_signature.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <fstream>
#include <iterator>
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
    bool clipboardImage(std::vector<std::uint8_t> *bytes, std::string *mime) override
    {
        if (imageBytes.empty())
            return false;
        *bytes = imageBytes;
        *mime = imageMime;
        return true;
    }
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
    std::vector<std::uint8_t> imageBytes;
    std::string imageMime = "image/png";
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
    CHECK(mote::parseJson("\"\\u4e2d\\ud83d\\ude00\"", unicode));
    CHECK_EQ(unicode.asString(), std::string("中😀"));

    JsonValue broken;
    CHECK(!mote::parseJson("{", broken));
    CHECK(!mote::parseJson(R"({"a":1} x)", broken));
    CHECK(!mote::parseJson("tru", broken));
    CHECK(!mote::parseJson("", broken));

    CHECK_EQ(mote::quoteJson("a\"b\nc\\d"), std::string(R"("a\"b\nc\\d")"));
}

static void testUpdate()
{
    using mote::UpdateDecision;
    using mote::UpdateManifest;
    using mote::UpdatePlatform;

    // macOS 平台段：完整清单，未知字段、未知 artifacts key 与另一平台一并忽略
    UpdateManifest manifest;
    std::string error;
    CHECK(mote::parseUpdateManifest(
        R"json({"manifest_version":2,"product":"mote","channel":"stable",
                "updated_at":"2026-11-18T04:48:54Z","unknown_top":{"x":1},
                "platforms":{
                  "macos":{"version":"1.0.1","build":0,"min_os":"14.0","unknown":true,
                           "notes_url":"https://dl.xiaotu.online/mote/release-notes-1.0.1.html",
                           "artifacts":{"dmg":{"url":"https://dl.xiaotu.online/mote/mote-1.0.1-macos-arm64.dmg",
                                               "size":1794986,"sha256":"abc"},
                                        "future":{"url":"https://dl.xiaotu.online/mote/ignored"}}},
                  "windows":{"version":"1.0.2","build":202611180530,"min_os":"10.0",
                             "artifacts":{"setup":{"url":"https://dl.xiaotu.online/mote/mote-1.0.2-win64-setup.exe",
                                                   "size":2655925,"sha256":"def"}}}}})json",
        UpdatePlatform::Macos, manifest, &error));
    CHECK_EQ(manifest.updated_at, std::string("2026-11-18T04:48:54Z"));
    CHECK_EQ(manifest.version, std::string("1.0.1"));
    CHECK_EQ(manifest.build, 0LL);
    CHECK_EQ(manifest.min_os, std::string("14.0"));
    CHECK_EQ(manifest.notes_url,
             std::string("https://dl.xiaotu.online/mote/release-notes-1.0.1.html"));
    CHECK_EQ(manifest.dmg.url,
             std::string("https://dl.xiaotu.online/mote/mote-1.0.1-macos-arm64.dmg"));
    CHECK_EQ(manifest.dmg.size, 1794986LL);
    CHECK_EQ(manifest.dmg.sha256, std::string("abc"));
    CHECK(manifest.setup.url.empty());
    CHECK(manifest.portable.url.empty());

    // Windows 平台段：setup 与 portable 同时给出，各取所需
    CHECK(mote::parseUpdateManifest(
        R"json({"updated_at":"2026-11-18T04:48:54Z","platforms":{"windows":{
            "version":"1.0.2","build":202611180530,"min_os":"10.0",
            "artifacts":{
              "portable":{"url":"https://dl.xiaotu.online/mote/mote-1.0.2-win64-portable.zip",
                          "size":702247,"sha256":"portable-sha"},
              "setup":{"url":"https://dl.xiaotu.online/mote/mote-1.0.2-win64-setup.exe",
                       "size":2655925,"sha256":"setup-sha"}}}}})json",
        UpdatePlatform::Windows, manifest, &error));
    CHECK_EQ(manifest.updated_at, std::string("2026-11-18T04:48:54Z"));
    CHECK_EQ(manifest.build, 202611180530LL);
    CHECK_EQ(manifest.portable.url,
             std::string("https://dl.xiaotu.online/mote/mote-1.0.2-win64-portable.zip"));
    CHECK_EQ(manifest.portable.size, 702247LL);
    CHECK_EQ(manifest.setup.sha256, std::string("setup-sha"));
    CHECK(manifest.dmg.url.empty());

    // 清单里没有自己的平台段：明确报错
    CHECK(!mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"1.0.2","build":1,
                 "artifacts":{"setup":{"url":"https://x/setup.exe","size":1}}}}})json",
        UpdatePlatform::Macos, manifest, &error));
    CHECK_EQ(error, std::string("更新清单缺少 macos 平台"));

    // 必填字段与类型校验
    CHECK(!mote::parseUpdateManifest("not json", UpdatePlatform::Macos, manifest, &error));
    CHECK_EQ(error, std::string("更新清单不是合法的 JSON 对象"));
    CHECK(!mote::parseUpdateManifest(R"({"updated_at":"2026-11-18T04:48:54Z"})",
                                     UpdatePlatform::Macos, manifest, &error));
    CHECK_EQ(error, std::string("更新清单缺少 platforms"));
    CHECK(!mote::parseUpdateManifest(R"({"platforms":{"macos":{}}})", UpdatePlatform::Macos,
                                     manifest, &error));
    CHECK_EQ(error, std::string("更新清单缺少 version"));
    CHECK(!mote::parseUpdateManifest(R"({"platforms":{"macos":{"version":"1.0.0"}}})",
                                     UpdatePlatform::Macos, manifest, &error));
    CHECK_EQ(error, std::string("更新清单缺少 artifacts"));
    CHECK(!mote::parseUpdateManifest(
        R"({"platforms":{"macos":{"version":"1.0.0","artifacts":{}}}})",
        UpdatePlatform::Macos, manifest, &error));
    CHECK_EQ(error, std::string("更新清单缺少 dmg 产物"));
    CHECK(!mote::parseUpdateManifest(
        R"({"platforms":{"windows":{"version":"1.0.0","artifacts":{"dmg":{"url":"https://x"}}}}})",
        UpdatePlatform::Windows, manifest, &error));
    CHECK_EQ(error, std::string("更新清单至少需要 setup 或 portable 产物"));
    CHECK(!mote::parseUpdateManifest(
        R"({"platforms":{"macos":{"version":"1","artifacts":{"dmg":{"url":"https://x","size":-1}}}}})",
        UpdatePlatform::Macos, manifest, &error));
    CHECK_EQ(error, std::string("更新清单的 size 不能为负数"));
    CHECK(!mote::parseUpdateManifest(
        R"({"platforms":{"windows":{"version":"1","build":-5,"artifacts":{"setup":{"url":"https://x","size":1}}}}})",
        UpdatePlatform::Windows, manifest, &error));
    CHECK_EQ(error, std::string("更新清单的 build 不能为负数"));

    // 版本比较：数字段比较、缺段补 0、忽略前缀 v 与后缀
    CHECK_EQ(mote::compareVersions("0.3.5", "0.3.5"), 0);
    CHECK_EQ(mote::compareVersions("0.3.10", "0.3.9"), 1);
    CHECK_EQ(mote::compareVersions("1.0", "1.0.0"), 0);
    CHECK_EQ(mote::compareVersions("v0.4", "0.3.9"), 1);
    CHECK_EQ(mote::compareVersions("0.3.5-beta", "0.3.5"), 0);
    CHECK_EQ(mote::compareVersions("0.3", "0.3.1"), -1);

    // 判定：macOS 同版本也参与 build 比较（三仓统一口径）
    UpdateManifest macAvailable;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"macos":{"version":"1.0.1","min_os":"14.0",
                 "artifacts":{"dmg":{"url":"https://x/a.dmg"}}}}})json",
        UpdatePlatform::Macos, macAvailable, nullptr));
    CHECK(mote::decideUpdate(macAvailable, UpdatePlatform::Macos, "1.0.0", "14.0", 0)
          == UpdateDecision::Available);
    CHECK(mote::decideUpdate(macAvailable, UpdatePlatform::Macos, "1.0.1", "14.0", 0)
          == UpdateDecision::UpToDate);
    CHECK(mote::decideUpdate(macAvailable, UpdatePlatform::Macos, "1.0.2", "14.0", 0)
          == UpdateDecision::UpToDate);
    CHECK(mote::decideUpdate(macAvailable, UpdatePlatform::Macos, "1.0.1", "14.0", 999)
          == UpdateDecision::UpToDate);
    CHECK(mote::decideUpdate(macAvailable, UpdatePlatform::Macos, "1.0.0", "13.6", 0)
          == UpdateDecision::UnsupportedSystem);
    // 同版本重发：远端 build 更大才提示（与另两仓共用向量表）
    UpdateManifest macBuild;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"macos":{"version":"1.0.1","build":2026112002,"min_os":"14.0",
                 "artifacts":{"dmg":{"url":"https://x/a.dmg"}}}}})json",
        UpdatePlatform::Macos, macBuild, nullptr));
    CHECK(mote::decideUpdate(macBuild, UpdatePlatform::Macos, "1.0.1", "14.0", 2026112001)
          == UpdateDecision::Available);
    CHECK(mote::decideUpdate(macBuild, UpdatePlatform::Macos, "1.0.1", "14.0", 2026112002)
          == UpdateDecision::UpToDate);
    CHECK(mote::decideUpdate(macBuild, UpdatePlatform::Macos, "1.0.1", "14.0", 0)
          == UpdateDecision::UpToDate);
#ifdef MOTE_UPDATE_VECTORS
    {
      std::ifstream in(MOTE_UPDATE_VECTORS);
      CHECK(in.good());
      std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
      mote::JsonValue vectors;
      CHECK(mote::parseJson(text, vectors));
      const auto &cases = vectors.asObject().at("cases").asArray();
      for (const auto &item : cases) {
        const auto &obj = item.asObject();
        const long long remoteBuild =
            static_cast<long long>(obj.at("remote_build").asNumber());
        const long long localBuild =
            static_cast<long long>(obj.at("local_build").asNumber());
        const std::string body =
            R"json({"platforms":{"macos":{"version":")json" +
            obj.at("remote_version").asString() + R"json(","build":)json" +
            std::to_string(remoteBuild) +
            R"json(,"min_os":"0.0","artifacts":{"dmg":{"url":"https://x/a.dmg"}}}}})json";
        UpdateManifest fromVectors;
        CHECK(mote::parseUpdateManifest(body, UpdatePlatform::Macos, fromVectors, nullptr));
        const bool expected = obj.at("newer").asBool();
        const bool actual =
            mote::decideUpdate(fromVectors, UpdatePlatform::Macos,
                               obj.at("local_version").asString(), "10.0", localBuild) ==
            UpdateDecision::Available;
        CHECK(actual == expected);
      }
    }
#endif
    // 没有 min_os 时不对系统版本设限
    UpdateManifest macAnyOs;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"macos":{"version":"1.0.1","artifacts":{"dmg":{"url":"https://x/a.dmg"}}}}})json",
        UpdatePlatform::Macos, macAnyOs, nullptr));
    CHECK(mote::decideUpdate(macAnyOs, UpdatePlatform::Macos, "1.0.0", "10.15", 0)
          == UpdateDecision::Available);

    // 判定：Windows 先比 version，同版本再比 build（build <= 本机 → 无更新）
    UpdateManifest winAvailable;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"1.0.2","build":202611180530,
                 "artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, winAvailable, nullptr));
    CHECK(mote::decideUpdate(winAvailable, UpdatePlatform::Windows, "1.0.1", "10.0", 202611180000)
          == UpdateDecision::Available);
    CHECK(mote::decideUpdate(winAvailable, UpdatePlatform::Windows, "1.0.2", "10.0", 202611180529)
          == UpdateDecision::Available);
    CHECK(mote::decideUpdate(winAvailable, UpdatePlatform::Windows, "1.0.2", "10.0", 202611180530)
          == UpdateDecision::UpToDate);
    CHECK(mote::decideUpdate(winAvailable, UpdatePlatform::Windows, "1.0.2", "10.0", 202611190000)
          == UpdateDecision::UpToDate);
    // 本机构建号未知（MOTE_BUILD=0）：跳过 build 比较，仅按 version
    CHECK(mote::decideUpdate(winAvailable, UpdatePlatform::Windows, "1.0.2", "10.0", 0)
          == UpdateDecision::UpToDate);
    CHECK(mote::decideUpdate(winAvailable, UpdatePlatform::Windows, "1.0.1", "10.0", 0)
          == UpdateDecision::Available);

    // 平台产物缺失时判定无效
    CHECK(mote::decideUpdate(UpdateManifest{}, UpdatePlatform::Macos, "1.0.1", "14.0", 0)
          == UpdateDecision::Invalid);
    CHECK(mote::decideUpdate(UpdateManifest{}, UpdatePlatform::Windows, "1.0.1", "10.0", 0)
          == UpdateDecision::Invalid);

    // 灰度分桶：SHA-256(install_id + ":" + build) 取前 4 字节大端 % 100。
    // 向量与 xiaotu / devcard 同输入同结果（唯一口径，见 docs 6.1）。
    CHECK_EQ(mote::rolloutBucket("mote-test-install", 202611180530), 7);
    CHECK_EQ(mote::rolloutBucket("mote-other-install", 202611180530), 36);
    CHECK(mote::rolloutAllows(100, 99));
    CHECK(mote::rolloutAllows(8, 7));
    CHECK(!mote::rolloutAllows(7, 7));
    CHECK(!mote::rolloutAllows(100, -1)); // 无 install_id 的桶不放行
    CHECK(mote::rolloutAllows(150, 99));  // 越界按 100 截断
    CHECK(!mote::rolloutAllows(-1, 0));

    // 灰度清单：解析 rollout_percent / mandatory
    UpdateManifest rolloutManifest;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"1.0.2","build":202611180530,
                 "rollout_percent":8,"artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, rolloutManifest, nullptr));
    CHECK_EQ(rolloutManifest.rollout_percent, 8);
    CHECK(!rolloutManifest.mandatory);

    // 命中灰度（bucket 7 < 8）→ 可更新；未命中 → RolloutHold
    CHECK(mote::decideUpdate(rolloutManifest, UpdatePlatform::Windows, "1.0.1", "10.0",
                             202611180000, "mote-test-install")
          == UpdateDecision::Available);
    CHECK(mote::decideUpdate(rolloutManifest, UpdatePlatform::Windows, "1.0.1", "10.0",
                             202611180000, "mote-other-install")
          == UpdateDecision::RolloutHold);
    // 未提供 install_id：跳过灰度，保持旧行为
    CHECK(mote::decideUpdate(rolloutManifest, UpdatePlatform::Windows, "1.0.1", "10.0",
                             202611180000)
          == UpdateDecision::Available);

    // rollout_percent=100 全量放行
    UpdateManifest fullRollout;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"1.0.2","build":202611180530,
                 "rollout_percent":100,"artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, fullRollout, nullptr));
    CHECK(mote::decideUpdate(fullRollout, UpdatePlatform::Windows, "1.0.1", "10.0", 0,
                             "mote-other-install")
          == UpdateDecision::Available);

    // mandatory 绕过灰度
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"1.0.2","build":202611180530,
                 "rollout_percent":1,"mandatory":true,
                 "artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, fullRollout, nullptr));
    CHECK(fullRollout.mandatory);
    CHECK(mote::decideUpdate(fullRollout, UpdatePlatform::Windows, "1.0.1", "10.0", 0,
                             "mote-other-install")
          == UpdateDecision::Available);

    // 越界 rollout_percent 按边界截断，不让坏字段使整份清单失效
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"1.0.2","rollout_percent":150,
                 "artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, fullRollout, nullptr));
    CHECK_EQ(fullRollout.rollout_percent, 100);
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"1.0.2","rollout_percent":-5,
                 "artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, fullRollout, nullptr));
    CHECK_EQ(fullRollout.rollout_percent, 0);

    // 强制更新：解析 mandatory / 期限 / 原因，并映射固定中文文案
    UpdateManifest mandatoryManifest;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"2.0.0","mandatory":true,
                 "mandatory_reason":"SECURITY","mandatory_deadline":"2026-12-01T00:00:00Z",
                 "artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, mandatoryManifest, nullptr));
    CHECK(mandatoryManifest.mandatory);
    CHECK_EQ(mandatoryManifest.mandatory_reason, std::string("SECURITY"));
    CHECK_EQ(mandatoryManifest.mandatory_deadline, std::string("2026-12-01T00:00:00Z"));
    CHECK_EQ(mote::mandatoryReasonLabel("SECURITY"), std::string("安全漏洞修复"));
    CHECK_EQ(mote::mandatoryReasonLabel("PROTOCOL"), std::string("协议不兼容"));
    CHECK_EQ(mote::mandatoryReasonLabel("REGULATORY"), std::string("法规或税控要求"));
    CHECK_EQ(mote::mandatoryReasonLabel("MIN_SUPPORTED"), std::string("低于服务端最低支持版本"));
    CHECK(mote::mandatoryReasonLabel("").empty());
    CHECK(mote::mandatoryReasonLabel("UNKNOWN").empty());

    // 期限解析与「到期才强制」：未到期可稍后，到期/无期限立即强制
    std::time_t epoch = -1;
    CHECK(mote::parseIso8601Utc("1970-01-01T00:00:00Z", &epoch));
    CHECK(epoch == 0);
    CHECK(mote::parseIso8601Utc("2026-12-01T00:00:00Z", &epoch));
    CHECK(epoch == 1796083200);
    CHECK(mote::parseIso8601Utc("2024-02-29T12:30:45Z", &epoch)); // 闰日
    CHECK(epoch == 1709209845);
    CHECK(!mote::parseIso8601Utc("2026-12-01", &epoch));
    CHECK(!mote::parseIso8601Utc("2026-12-01T00:00:00+08:00", &epoch));
    CHECK(!mote::parseIso8601Utc("2026-13-01T00:00:00Z", &epoch));
    CHECK(mote::mandatoryActive(mandatoryManifest, 1796083199) == false); // 截止前 1 秒
    CHECK(mote::mandatoryActive(mandatoryManifest, 1796083200) == true);  // 到点即强制
    CHECK(mote::mandatoryActive(mandatoryManifest, 1796083201) == true);

    UpdateManifest noDeadline;
    noDeadline.mandatory = true;
    CHECK(mote::mandatoryActive(noDeadline, 0) == true); // 没期限：立即强制，保持旧行为
    noDeadline.mandatory_deadline = "not-a-date";
    CHECK(mote::mandatoryActive(noDeadline, 0) == true); // 期限非法：按已到期处理
    noDeadline.mandatory = false;
    noDeadline.mandatory_deadline.clear();
    CHECK(mote::mandatoryActive(noDeadline, 2000000000) == false);

    // 强制更新绕过灰度：rollout_percent=1 且未命中桶也下发
    UpdateManifest mandatoryRollout;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"2.0.0","build":202611180530,
                 "rollout_percent":1,"mandatory":true,
                 "artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, mandatoryRollout, nullptr));
    CHECK(mote::decideUpdate(mandatoryRollout, UpdatePlatform::Windows, "1.0.2", "10.0", 0,
                             "mote-other-install")
          == UpdateDecision::Available);

    // 非强制更新不携带期限/原因：解析时清空，避免 UI 误显示
    UpdateManifest staleMandatory;
    CHECK(mote::parseUpdateManifest(
        R"json({"platforms":{"windows":{"version":"2.0.0","mandatory":false,
                 "mandatory_reason":"SECURITY","mandatory_deadline":"2026-12-01T00:00:00Z",
                 "artifacts":{"portable":{"url":"https://x/a.zip"}}}}})json",
        UpdatePlatform::Windows, staleMandatory, nullptr));
    CHECK(!staleMandatory.mandatory);
    CHECK(staleMandatory.mandatory_reason.empty());
    CHECK(staleMandatory.mandatory_deadline.empty());
}

// ---- Ed25519 验签：与 tools/release/manifest_v2.py 交叉验证 ----
// 测试密钥 = RFC 8032 自检种子（manifest_v2.py 的 _SELFTEST_SEED），
// 签名与 canonical bytes 由 manifest_v2.py 生成，客户端实现必须逐字节复现。

static const unsigned char kTestPublicKey[32] = {
    0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3,
    0xc9, 0x64, 0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
    0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
};

// 手工构造的清单：覆盖键排序、整数、浮点（2.5/0.1）、布尔、null、中文原样
// UTF-8（ensure_ascii=False）、引号/反斜杠/制表符转义、未知顶层字段。
static const char kCraftedManifest[] = R"ctx({
  "channel": "beta",
  "key_id": "2026-11",
  "manifest_version": 2,
  "platforms": {
    "macos": {
      "artifacts": {
        "dmg": {
          "sha256": "6f6f9fbd61145aca92be509d6595ce376d88746790b714ca1a22d9a9b889e11a",
          "size": 1794986,
          "url": "https://dl.xiaotu.online/mote/mote-1.0.1-macos-arm64.dmg"
        }
      },
      "build": 0,
      "min_os": "14.0",
      "version": "1.0.1"
    },
    "windows": {
      "artifacts": {
        "portable": {
          "sha256": "8fdcb41338deb9385308537a9ec4434a11b13bf250bf81f43c0817c804cf0dcc",
          "size": 702247,
          "url": "https://dl.xiaotu.online/mote/mote-1.0.2-win64-portable.zip"
        },
        "setup": {
          "sha256": "9b9c18c6a21f5d4b44bb804aa6a8f683f95035f6018cb35ee27918fe48b2ac16",
          "size": 2655925,
          "url": "https://dl.xiaotu.online/mote/mote-1.0.2-win64-setup.exe"
        }
      },
      "build": 202611180530,
      "min_os": "10.0",
      "version": "1.0.2"
    }
  },
  "product": "mote",
  "release_note": "中文\"引号\"与\\反斜杠\t制表符",
  "signature": "OlDWDKcjWiqqXMAsL+5ORzRx9PyfCX1MCh77p3Q/fstX3+g0qEXcgJnWdeMgln+oKd0qGNLkMHQZnnQIzhK3BA==",
  "unknown_top": {
    "aa": -3,
    "mm": [
      true,
      false,
      null,
      2.5,
      0.1
    ],
    "zz": 1
  },
  "updated_at": "2026-11-18T04:48:54Z"
})ctx";

// 上面 kCraftedManifest 去掉 signature 后的 canonical bytes（Python 产出）
static const char kExpectedCanonical[] = R"ctx({"channel":"beta","key_id":"2026-11","manifest_version":2,"platforms":{"macos":{"artifacts":{"dmg":{"sha256":"6f6f9fbd61145aca92be509d6595ce376d88746790b714ca1a22d9a9b889e11a","size":1794986,"url":"https://dl.xiaotu.online/mote/mote-1.0.1-macos-arm64.dmg"}},"build":0,"min_os":"14.0","version":"1.0.1"},"windows":{"artifacts":{"portable":{"sha256":"8fdcb41338deb9385308537a9ec4434a11b13bf250bf81f43c0817c804cf0dcc","size":702247,"url":"https://dl.xiaotu.online/mote/mote-1.0.2-win64-portable.zip"},"setup":{"sha256":"9b9c18c6a21f5d4b44bb804aa6a8f683f95035f6018cb35ee27918fe48b2ac16","size":2655925,"url":"https://dl.xiaotu.online/mote/mote-1.0.2-win64-setup.exe"}},"build":202611180530,"min_os":"10.0","version":"1.0.2"}},"product":"mote","release_note":"中文\"引号\"与\\反斜杠\t制表符","unknown_top":{"aa":-3,"mm":[true,false,null,2.5,0.1],"zz":1},"updated_at":"2026-11-18T04:48:54Z"})ctx";

// manifest_v2.py generate（macos + windows --prev 合并后重签）产出的完整清单
static const char kSignedManifest[] = R"manifest({
  "channel": "stable",
  "key_id": "2026-11",
  "manifest_version": 2,
  "platforms": {
    "macos": {
      "artifacts": {
        "dmg": {
          "sha256": "ac2348937a860bd2091befd75988b77233455641bfccd100db8a1e47c7be1fce",
          "size": 14,
          "url": "https://dl.xiaotu.online/mote/mote-1.0.1-macos-arm64.dmg"
        }
      },
      "build": 0,
      "min_os": "14.0",
      "rollout_percent": 100,
      "version": "1.0.1"
    },
    "windows": {
      "artifacts": {
        "portable": {
          "sha256": "a597a9f1c78ab2d05f641cfa267dd5ac8138f266608d51202a246182910e2727",
          "size": 17,
          "url": "https://dl.xiaotu.online/mote/mote-1.0.2-win64-portable.zip"
        },
        "setup": {
          "sha256": "1d0f8f8879e667e6f81fcc8d03a1b1ed4acefbb9f29690e67ac544552eba5d05",
          "size": 14,
          "url": "https://dl.xiaotu.online/mote/mote-1.0.2-win64-setup.exe"
        }
      },
      "build": 202611180530,
      "min_os": "10.0",
      "notes_url": "https://dl.xiaotu.online/mote/release-notes-1.0.2.html",
      "rollout_percent": 100,
      "version": "1.0.2"
    }
  },
  "product": "mote",
  "signature": "TLcaBLwQQzSzILfEObbMhBS/jhwGEeRaxQtgrpZdWyVAbpuKTVnnw2qCE0XUqHiFbrGkeZgEMqH4s5eNbdSzAw==",
  "updated_at": "2026-11-18T07:00:58Z"
})manifest";

static void testVerifySignature()
{
    std::string error;

    // canonical bytes 必须与 Python json.dumps(sort_keys=True, separators=(",",":"),
    // ensure_ascii=False) 逐字节一致
    std::string canonical;
    CHECK(mote::canonicalUpdateManifestBytes(kCraftedManifest, &canonical, &error));
    CHECK_EQ(canonical, std::string(kExpectedCanonical));

    // 签名验证通过（craft 向量 + manifest_v2.py 产出的两平台清单）
    CHECK(mote::verifyUpdateManifestSignature(kCraftedManifest, kTestPublicKey, &error));
    CHECK(mote::verifyUpdateManifestSignature(kSignedManifest, kTestPublicKey, &error));

    // 篡改清单任一值都失败
    std::string tampered = kSignedManifest;
    const size_t versionPos = tampered.find("\"1.0.1\"");
    CHECK(versionPos != std::string::npos);
    if (versionPos != std::string::npos)
        tampered.replace(versionPos, 7, "\"9.9.9\"");
    CHECK(!mote::verifyUpdateManifestSignature(tampered, kTestPublicKey, &error));
    CHECK_EQ(error, std::string("更新清单签名验证失败（公钥不匹配或清单被改动）"));

    // 错误公钥
    unsigned char wrongKey[32];
    std::memcpy(wrongKey, kTestPublicKey, sizeof(wrongKey));
    wrongKey[0] ^= 1;
    CHECK(!mote::verifyUpdateManifestSignature(kSignedManifest, wrongKey, &error));

    // 缺 signature / signature 长度不对 / 非 JSON / 非 JSON 对象
    CHECK(!mote::verifyUpdateManifestSignature(R"({"a":1})", kTestPublicKey, &error));
    CHECK_EQ(error, std::string("更新清单缺少 signature"));
    CHECK(!mote::verifyUpdateManifestSignature(R"({"a":1,"signature":"AAAA"})", kTestPublicKey,
                                               &error));
    CHECK_EQ(error, std::string("更新清单的 signature 不是 64 字节 Ed25519 签名"));
    CHECK(!mote::verifyUpdateManifestSignature("junk", kTestPublicKey, &error));
    CHECK_EQ(error, std::string("更新清单不是合法的 JSON 对象"));
    CHECK(!mote::verifyUpdateManifestSignature("[1,2]", kTestPublicKey, &error));
    CHECK(!mote::canonicalUpdateManifestBytes("[1,2]", &canonical, &error));

    // 生产 trust anchor 是 32 字节（Ed25519 公钥固定长度，编译期约束）
    static_assert(sizeof(mote::kUpdateManifestPublicKey) == 32,
                  "kUpdateManifestPublicKey must be 32 bytes");
}

static void testBase64()
{
    const std::vector<std::uint8_t> hello = mote::base64Decode("aGVsbG8=");
    CHECK_EQ(std::string(hello.begin(), hello.end()), std::string("hello"));

    // 页面可能带换行；解码时忽略空白
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

    // 打开/换文档后立即回到「未修改」
    controller.handleMessage(R"({"type":"dirty","value":true})");
    CHECK(controller.dirty());
    controller.setMarkdown("new doc", "/tmp/other");
    CHECK(!controller.dirty());
    CHECK_EQ(host.dirtyValues.back(), false);
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

static void testInjectDocumentHook()
{
    // 平台可以接管正文注入（Windows 大文档走分片）；默认实现仍是一条脚本
    class InjectCaptureHost : public TestHost
    {
    public:
        void injectDocument(const std::string &text) override { injected.push_back(text); }
        std::vector<std::string> injected;
    };

    InjectCaptureHost host;
    EditorController controller(host);
    controller.setMarkdown("大文档正文", "/tmp/hook");
    controller.handleMessage(R"({"type":"ready"})");
    CHECK_EQ(host.injected.size(), static_cast<size_t>(1));
    CHECK_EQ(host.injected.at(0), std::string("大文档正文"));
    CHECK(!host.hasScript("setMarkdown("));
}

static void testClipboardImagePaste()
{
    const std::string dir = makeTempDir();
    TestHost host;
    EditorController controller(host);
    controller.setMarkdown("", dir);
    controller.handleMessage(R"({"type":"ready"})");
    host.scripts.clear();

    host.imageBytes = {0x89, 'P', 'N', 'G', 0x1A};
    host.clipboard = "不应被使用";
    controller.clipboardCommand("paste");
    CHECK(host.hasScript("insertImage(\"assets/paste-"));
    CHECK(!host.hasScript("clipboardPaste"));
    CHECK(host.status.find("已保存图片：assets/paste-") != std::string::npos);

    bool has_png = false;
    std::error_code error;
    for (const auto &entry : fs::directory_iterator(fs::path(dir) / "assets", error)) {
        if (entry.path().extension() == ".png")
            has_png = true;
    }
    CHECK(has_png);
    fs::remove_all(dir, error);
}

static void testChunkSplitting()
{
    using mote::splitUtf8ByBudget;

    CHECK(splitUtf8ByBudget("", 16).empty());
    CHECK(splitUtf8ByBudget("abc", 0).empty());

    // 预算按 JSON 转义后的长度算：引号占 2 字节，所以 a 与引号不能同片
    const std::vector<std::string> quoted = splitUtf8ByBudget("a\"b", 2);
    CHECK_EQ(quoted.size(), static_cast<size_t>(3));
    CHECK_EQ(quoted.at(0), std::string("a"));
    CHECK_EQ(quoted.at(1), std::string("\""));
    CHECK_EQ(quoted.at(2), std::string("b"));

    // 中文每字符 3 字节，不能拆成半个字符
    const std::vector<std::string> chinese = splitUtf8ByBudget("中文", 4);
    CHECK_EQ(chinese.size(), static_cast<size_t>(2));
    CHECK_EQ(chinese.at(0), std::string("中"));
    CHECK_EQ(chinese.at(1), std::string("文"));

    // 单个 emoji 超过预算时独占一片，且不截断
    const std::vector<std::string> emoji = splitUtf8ByBudget("😀", 3);
    CHECK_EQ(emoji.size(), static_cast<size_t>(1));
    CHECK_EQ(emoji.at(0), std::string("😀"));

    // 任意预算下拼回去必须与原文一致
    const std::string mixed = "a\"b\\c\n中文😀xyz";
    for (const std::size_t budget : { 1, 2, 4, 8, 64 }) {
        std::string joined;
        for (const std::string &chunk : splitUtf8ByBudget(mixed, budget))
            joined += chunk;
        CHECK_EQ(joined, mixed);
    }
}

static void testBlockLayout()
{
    using mote::BlockLayout;
    using mote::blockStartOffset;
    using mote::joinBlocks;
    using mote::measureBlockGaps;

    const std::vector<std::string> ab = { "A", "B" };

    // 默认排版（一块之间 2 个换行 + 文末 1 个）就是改动前的固定拼法
    BlockLayout standard;
    standard.between = { 2 };
    standard.trailing = 1;
    CHECK_EQ(joinBlocks(ab, standard), std::string("A\n\nB\n"));

    // 间隔 1/2/3/4 个换行：量出来的间隔要能逐字节拼回原文
    for (const int newlines : { 1, 2, 3, 4 }) {
        const std::string text = "A" + std::string(static_cast<size_t>(newlines), '\n') + "B";
        const mote::MeasuredLayout measured = measureBlockGaps(text, ab);
        CHECK(measured.ok);
        CHECK_EQ(measured.layout.between.size(), static_cast<size_t>(1));
        CHECK_EQ(measured.layout.between.at(0), newlines);
        CHECK_EQ(joinBlocks(ab, measured.layout), text);
    }

    // 文首、文末多余空行
    {
        const std::string text = "\n\nA\n\nB\n\n\n";
        const mote::MeasuredLayout measured = measureBlockGaps(text, ab);
        CHECK(measured.ok);
        CHECK_EQ(measured.layout.leading, 2);
        CHECK_EQ(measured.layout.between.at(0), 2);
        CHECK_EQ(measured.layout.trailing, 3);
        CHECK_EQ(joinBlocks(ab, measured.layout), text);
    }

    // 全空文档：没有块，换行全部算文末，不崩溃
    {
        const mote::MeasuredLayout measured = measureBlockGaps("\n\n\n", {});
        CHECK(measured.ok);
        CHECK_EQ(measured.layout.trailing, 3);
        CHECK_EQ(joinBlocks({}, measured.layout), std::string("\n\n\n"));
        CHECK(measureBlockGaps("", {}).ok);
    }

    // 空块与代码块混合：块内换行不参与间隔统计
    {
        const std::vector<std::string> blocks = { "# 标题", "```\nline1\n\nline2\n```", "" };
        const std::string text = "# 标题\n\n\n```\nline1\n\nline2\n```\n\n";
        const mote::MeasuredLayout measured = measureBlockGaps(text, blocks);
        CHECK(measured.ok);
        CHECK_EQ(measured.layout.between.at(0), 3);
        // 末尾空块不占字节，紧邻的换行归到文末；拼接结果不变才是硬约束
        CHECK_EQ(measured.layout.between.at(1), 0);
        CHECK_EQ(measured.layout.trailing, 2);
        CHECK_EQ(joinBlocks(blocks, measured.layout), text);
    }

    // 空块按零长度处理：间隔分布可能与原文不同，但拼接结果不变
    {
        const std::vector<std::string> blocks = { "A", "", "B" };
        const std::string text = "A\n\n\n\nB";
        const mote::MeasuredLayout measured = measureBlockGaps(text, blocks);
        CHECK(measured.ok);
        CHECK_EQ(joinBlocks(blocks, measured.layout), text);
    }

    // 块偏移：替代前端「每块固定 +2」的累加，指向每块起点
    {
        BlockLayout layout;
        layout.leading = 1;
        layout.between = { 2, 3 };
        layout.trailing = 0;
        const std::vector<std::string> blocks = { "A", "BB", "C" };
        const std::string text = joinBlocks(blocks, layout);
        CHECK_EQ(text, std::string("\nA\n\nBB\n\n\nC"));
        CHECK_EQ(blockStartOffset(blocks, layout, 0), static_cast<size_t>(1));
        CHECK_EQ(blockStartOffset(blocks, layout, 1), static_cast<size_t>(4));
        CHECK_EQ(blockStartOffset(blocks, layout, 2), static_cast<size_t>(9));
        for (std::size_t i = 0; i < blocks.size(); ++i)
            CHECK_EQ(text.compare(blockStartOffset(blocks, layout, i), blocks[i].size(), blocks[i]), 0);
        CHECK_EQ(blockStartOffset(blocks, layout, 3), std::string::npos);
    }

    // between 缺项或为负数时按 0 处理，不产生多余的换行
    {
        BlockLayout layout;
        layout.between = { -3 };
        CHECK_EQ(joinBlocks(ab, layout), std::string("AB"));
    }

    // 块文本对不上（顺序错、块外有非换行字符）时明确失败，调用方回退默认间隔
    CHECK(!measureBlockGaps("B\n\nA", ab).ok);
    CHECK(!measureBlockGaps("A x B", ab).ok);
    CHECK(!measureBlockGaps("A\n\nB 尾巴", ab).ok);
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

static void testTextEncoding()
{
    // UTF-8 BOM 去掉，其余字节保持原样
    CHECK(mote::normalizeTextEncoding("\xEF\xBB\xBF你好") == "你好");
    CHECK(mote::isValidUtf8("你好"));

    // UTF-16 LE：BOM + 'A' + '你'
    const std::string le = std::string("\xFF\xFE", 2) + std::string("\x41\x00\x60\x4F", 4);
    CHECK(mote::normalizeTextEncoding(le) == "A你");
    // UTF-16 BE：BOM + 'A' + '你'
    const std::string be = std::string("\xFE\xFF", 2) + std::string("\x00\x41\x4F\x60", 4);
    CHECK(mote::normalizeTextEncoding(be) == "A你");

    // 代理对（U+1F600）正确合成为一个码点：4 字节 UTF-8
    const std::string emoji = std::string("\xFF\xFE", 2) + std::string("\x3D\xD8\0\xDE", 4);
    CHECK(mote::normalizeTextEncoding(emoji) == "\xF0\x9F\x98\x80");

    // GBK 的「中文」不是合法 UTF-8，原样返回，由调用方按系统代码页兜底
    const std::string gbk = "\xD6\xD0\xCE\xC4";
    CHECK(!mote::isValidUtf8(gbk));
    CHECK(mote::normalizeTextEncoding(gbk) == gbk);
}

// ---- UpdateEngine 编排层 ----
// 状态机唯一份：这里锁死两端共同口径（验签顺序、节流、并发防重、跳过规则、文案）。

#include "mote/update_engine.h"

#include <map>

namespace {

struct FakeFetcher : mote::ManifestFetcher {
    std::vector<std::string> urls;
    mote::ManifestFetcher::Callback pending;
    void asyncGet(const std::string &url, Callback done) override
    {
        urls.push_back(url);
        pending = std::move(done);
    }
    void respond(int status, const std::string &body, const std::string &error = std::string())
    {
        auto cb = std::move(pending);
        pending = nullptr;
        if (cb)
            cb(status, body, error);
    }
};

struct FakeStore : mote::SettingsStore {
    std::map<std::string, std::string> values;
    std::string newId = "abc123";
    std::string getString(const std::string &key) override
    {
        auto it = values.find(key);
        return it == values.end() ? std::string() : it->second;
    }
    void setString(const std::string &key, const std::string &value) override
    {
        values[key] = value;
    }
    void clearString(const std::string &key) override { values.erase(key); }
    std::string newInstallId() override { return newId; }
};

struct FakeUi : mote::UpdateUi {
    std::vector<std::pair<std::string, std::string>> alerts;
    std::vector<mote::PromptSpec> prompts;
    Choice nextChoice = Choice::Install;
    void showAlert(const std::string &title, const std::string &body) override
    {
        alerts.emplace_back(title, body);
    }
    Choice showPrompt(const mote::PromptSpec &spec) override
    {
        prompts.push_back(spec);
        return nextChoice;
    }
};

struct FakeInstaller : mote::PlatformInstaller {
    bool allow = true;
    std::string preTitle, preBody;
    int installs = 0;
    std::string lastManifestText;
    bool preflight(std::string *title, std::string *body) override
    {
        *title = preTitle;
        *body = preBody;
        return allow;
    }
    long long preferredArtifactSize(const mote::UpdateManifest &manifest) override
    {
        return manifest.dmg.size;
    }
    void install(const mote::UpdateManifest &, const std::string &text) override
    {
        ++installs;
        lastManifestText = text;
    }
};

mote::UpdateEngineConfig engineConfig()
{
    mote::UpdateEngineConfig config;
    config.platform = mote::UpdatePlatform::Macos;
    config.manifest_url = "https://example.test/manifest.json";
    config.current_version = "1.0.25";
    config.current_os = "15.0";
    config.os_label = "macOS";
    config.current_build = 0;
    config.install_note = "安装过程会退出并重新打开 Mote。";
    return config;
}

// 构造 macos 平台段清单：版本、大小、可选字段（extra 注入 macos 段内）
std::string makeManifest(const std::string &version, long long size = 3670016,
                         const std::string &extra = std::string())
{
    std::string json = R"({"updated_at":"2026-11-26T00:00:00Z","platforms":{"macos":{"version":")"
        + version + R"(")";
    if (!extra.empty())
        json += "," + extra;
    json += R"(,"notes_url":"https://example.test/notes","artifacts":{"dmg":{"url":"https://example.test/a.dmg","size":)"
        + std::to_string(size) + R"(}}}}})";
    return json;
}

mote::UpdateEngine makeEngine(FakeFetcher &fetcher, FakeStore &store, FakeUi &ui,
                              FakeInstaller &installer, bool verifyOk = true)
{
    auto config = engineConfig();
    config.verifier = [verifyOk](const std::string &, std::string *error) {
        if (!verifyOk && error)
            *error = "signature mismatch";
        return verifyOk;
    };
    return mote::UpdateEngine(std::move(config), fetcher, store, ui, installer, nullptr);
}

} // namespace

static void testUpdateEngine()
{
    // 1) 验签失败：不解析、不弹窗、不安装（锁死 win 旧偏差：判定前必须验签）
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer, /*verifyOk=*/false);
        engine.checkNow(std::time(nullptr));
        fetcher.respond(200, "not even json");
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(1));
        CHECK_EQ(ui.alerts[0].first, std::string("检查更新失败"));
        CHECK(ui.alerts[0].second.find("验签失败") != std::string::npos);
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(0));
        CHECK_EQ(installer.installs, 0);
        // 时间戳仍写入：失败也节流
        CHECK(!store.getString(mote::update_keys::kLastCheckAt).empty());
    }

    // 2) 网络失败：交互提示原因；非交互静默
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer);
        engine.checkNow(std::time(nullptr));
        fetcher.respond(0, "", "无法连接更新服务器");
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(1));
        CHECK_EQ(ui.alerts[0].second, std::string("无法连接更新服务器"));
        store.values.clear();
        ui.alerts.clear();
        engine.tick(std::time(nullptr));
        fetcher.respond(500, "");
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(0));
    }

    // 3) 节流：tick 在间隔内不重复拉取；checkNow 无视节流；间隔外放行
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer);
        const std::time_t now = std::time(nullptr);
        engine.tick(now);
        CHECK_EQ(fetcher.urls.size(), static_cast<size_t>(1));
        fetcher.respond(200, makeManifest("1.0.25")); // UpToDate，非交互静默
        engine.tick(now + 60); // 1 分钟后再 tick：仍在 24h 节流内
        CHECK_EQ(fetcher.urls.size(), static_cast<size_t>(1));
        engine.checkNow(now + 61); // 手动无视节流
        CHECK_EQ(fetcher.urls.size(), static_cast<size_t>(2));
        fetcher.respond(200, makeManifest("1.0.25"));
        // 手动 UpToDate 必须明确告知（后台则静默）
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(1));
        CHECK_EQ(ui.alerts[0].first, std::string("已是最新版本"));
        ui.alerts.clear();
        store.setString(mote::update_keys::kLastCheckAt,
                        std::to_string(static_cast<long long>(now) - 25 * 3600));
        engine.tick(now); // 超过间隔：放行
        CHECK_EQ(fetcher.urls.size(), static_cast<size_t>(3));
        fetcher.respond(200, makeManifest("1.0.25"));
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(0));
    }

    // 4) 并发防重：在途检查期间 tick/checkNow 不再发请求；手动重复触发有提示
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer);
        const std::time_t now = std::time(nullptr);
        engine.tick(now);
        CHECK(engine.isChecking());
        engine.tick(now + 1);
        engine.checkNow(now + 2);
        CHECK_EQ(fetcher.urls.size(), static_cast<size_t>(1));
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(1)); // 手动重复：明确告知
        CHECK(ui.alerts[0].second.find("正在进行") != std::string::npos);
        fetcher.respond(200, makeManifest("1.0.25"));
        CHECK(!engine.isChecking());
        // 迟到的重复回流被忽略
        engine.onManifest(200, makeManifest("9.9.9"), "");
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(0));
    }

    // 5) 跳过规则：后台点「稍后」→ 同版本后台静默；手动仍弹；确认后清除记录
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer);
        std::time_t now = std::time(nullptr);
        ui.nextChoice = mote::UpdateUi::Choice::Later;
        engine.checkNow(now);
        fetcher.respond(200, makeManifest("9.9.9"));
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(1));
        CHECK_EQ(store.getString(mote::update_keys::kSkippedVersion), std::string("9.9.9"));
        CHECK_EQ(installer.installs, 0);

        // 后台（tick，越过节流）：同版本静默
        store.setString(mote::update_keys::kLastCheckAt,
                        std::to_string(static_cast<long long>(now) - 25 * 3600));
        engine.tick(now);
        fetcher.respond(200, makeManifest("9.9.9"));
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(1)); // 没有新弹窗

        // 手动：无视跳过记录，仍弹
        ui.nextChoice = mote::UpdateUi::Choice::Install;
        engine.checkNow(now);
        fetcher.respond(200, makeManifest("9.9.9"));
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(2));
        CHECK_EQ(installer.installs, 1);
        CHECK(installer.lastManifestText == makeManifest("9.9.9"));
        CHECK(store.getString(mote::update_keys::kSkippedVersion).empty());
    }

    // 6) 强制更新：到期后不受「稍后」限制；无「稍后」按钮
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer);
        const std::time_t now = std::time(nullptr);
        const std::string forced = makeManifest("9.9.9", 3670016,
            R"("mandatory":true,"mandatory_reason":"SECURITY","mandatory_deadline":"2020-01-01T00:00:00Z")");
        store.setString(mote::update_keys::kSkippedVersion, "9.9.9");
        store.setString(mote::update_keys::kLastCheckAt,
                        std::to_string(static_cast<long long>(now) - 25 * 3600));
        engine.tick(now); // 后台 + 有跳过记录 + 强制已到期 → 仍要提示
        fetcher.respond(200, forced);
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(1));
        CHECK(ui.prompts[0].force);
        CHECK(!ui.prompts[0].allow_later);
        CHECK(ui.prompts[0].title == "必须更新到 9.9.9");
        CHECK(ui.prompts[0].body.find("当前版本必须升级。") != std::string::npos);
        CHECK(ui.prompts[0].body.find("安全漏洞修复") != std::string::npos);
        CHECK(ui.prompts[0].body.find("已到截止时间") != std::string::npos);
    }

    // 7) PromptSpec 内容：更新时间/大小/安装说明/notes 链接
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer);
        engine.checkNow(std::time(nullptr));
        fetcher.respond(200, makeManifest("9.9.9", 3670016));
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(1));
        const mote::PromptSpec &spec = ui.prompts[0];
        CHECK(spec.title == "发现新版本 9.9.9");
        CHECK(spec.body.find("更新时间：2026-11-26T00:00:00Z") != std::string::npos);
        CHECK(spec.body.find("安装包大小：3.5 MB") != std::string::npos);
        CHECK(spec.body.find("安装过程会退出并重新打开 Mote。") != std::string::npos);
        CHECK(spec.notes_url == "https://example.test/notes");
        CHECK(spec.allow_later && !spec.force);
    }

    // 8) preflight 拦截（如 mac Translocation）：只提示，不弹更新框、不记跳过
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        installer.allow = false;
        installer.preTitle = "需要先移动到“应用程序”";
        installer.preBody = "请移动后重试";
        auto engine = makeEngine(fetcher, store, ui, installer);
        engine.checkNow(std::time(nullptr));
        fetcher.respond(200, makeManifest("9.9.9"));
        CHECK_EQ(ui.prompts.size(), static_cast<size_t>(0));
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(1));
        CHECK_EQ(ui.alerts[0].first, installer.preTitle);
        CHECK_EQ(installer.installs, 0);
        CHECK(store.getString(mote::update_keys::kSkippedVersion).empty());
    }

    // 9) UnsupportedSystem / RolloutHold 交互与非交互矩阵
    {
        FakeFetcher fetcher; FakeStore store; FakeUi ui; FakeInstaller installer;
        auto engine = makeEngine(fetcher, store, ui, installer);
        std::time_t now = std::time(nullptr);
        engine.tick(now);
        fetcher.respond(200, makeManifest("9.9.9", 1024, R"("min_os":"99.0")"));
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(0)); // 后台静默
        engine.checkNow(now);
        fetcher.respond(200, makeManifest("9.9.9", 1024, R"("min_os":"99.0")"));
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(1));
        CHECK(ui.alerts[0].second.find("macOS 99.0 或更高") != std::string::npos);

        ui.alerts.clear();
        engine.checkNow(now);
        fetcher.respond(200, makeManifest("9.9.9", 1024, R"("rollout_percent":0)"));
        CHECK_EQ(ui.alerts.size(), static_cast<size_t>(1));
        CHECK(ui.alerts[0].first == "暂无可用更新");
    }

    // 10) formatSize 统一口径
    {
        CHECK(mote::UpdateEngine::formatSize(0).empty());
        CHECK(mote::UpdateEngine::formatSize(-5).empty());
        CHECK_EQ(mote::UpdateEngine::formatSize(2048), std::string("2 KB"));
        CHECK_EQ(mote::UpdateEngine::formatSize(3670016), std::string("3.5 MB"));
    }
}

int main()
{
    testJson();
    testUpdate();
    testUpdateEngine();
    testVerifySignature();
    testBase64();
    testPaths();
    testTextEncoding();
    testImageStore();
    testPendingMarkdown();
    testChangeBaseDirReloads();
    testMessageDispatch();
    testDirtyTracking();
    testClipboardCommands();
    testInjectDocumentHook();
    testClipboardImagePaste();
    testChunkSplitting();
    testBlockLayout();
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
