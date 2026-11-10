#include "webview_win.h"

#include "webpage.h"
#include "webview_win_drop.h"

#include <QAction>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QKeyCombination>
#include <QKeySequence>
#include <QLabel>
#include <QPointer>
#include <QResizeEvent>
#include <QShowEvent>
#include <QStandardPaths>
#include <QStringList>
#include <QTimer>
#include <QUrl>
#include <QWidget>

#include <atomic>
#include <cstdio>
#include <string>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <WebView2.h>

namespace {

// ---- 动态加载的导出函数 ----
using CreateEnvironmentFn = HRESULT(STDMETHODCALLTYPE *)(
    PCWSTR browserExecutableFolder, PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions *environmentOptions,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *environmentCreatedHandler);
using GetVersionFn = HRESULT(STDMETHODCALLTYPE *)(PCWSTR browserExecutableFolder, LPWSTR *versionInfo);

// 页面里注入的桥接脚本：前端只认 window.webkit.messageHandlers.mote，
// WebView2 提供的是 window.chrome.webview，这里在文档创建时把两者接起来。
// 同时接管宿主 PostWebMessageAsJson 的大文档注入通道。
const wchar_t kBridgeScript[] = LR"JS(
(function () {
  if (window.__moteWinBridge) return;
  window.__moteWinBridge = true;
  function post(message) {
    try { window.chrome.webview.postMessage(message); } catch (e) {}
  }
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.mote = { postMessage: post };
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', function (event) {
      var data = event.data;
      if (data && data.__mote === 'setMarkdown' && window.mote)
        window.mote.setMarkdown(data.text);
    });
  }
})();
)JS";

// 虚拟主机映射开关（默认关闭）：MOTE_WEBVIEW_VIRTUAL_HOST=1 时改用
// https://mote.local/ 映射文档目录，避免 file:// 的来源限制。
bool useVirtualHost()
{
    const QString value = qEnvironmentVariable("MOTE_WEBVIEW_VIRTUAL_HOST").trimmed().toLower();
    return value == QLatin1String("1") || value == QLatin1String("true")
        || value == QLatin1String("on") || value == QLatin1String("yes");
}

QString virtualHost()
{
    return QStringLiteral("mote.local");
}

// 临时页面文件名：必须与文档同目录（相对图片等资源才能解析）
QString filePathOf(const QString &dir)
{
    return QDir(dir).filePath(
        QStringLiteral(".mote-preview-%1.html").arg(QCoreApplication::applicationPid()));
}

// ---- 拖放实际命中的子窗口 ----
// WebView2 把页面渲染在 msedgewebview2 进程的子 HWND 里：Chrome_WidgetWin_1
// 包住 Chrome_RenderWidgetHostHWND，鼠标命中的是后者。OLE 拖放按 WindowFromPoint
// 派发，注册在宿主窗口上的 IDropTarget 永远收不到，所以要把目标挂到子窗口上。
struct DropWindowSearch
{
    HWND render = nullptr; // Chrome_RenderWidgetHostHWND（优先）
    HWND widget = nullptr; // Chrome_WidgetWin_1（退而求其次）
};

BOOL CALLBACK dropWindowProc(HWND hwnd, LPARAM param)
{
    auto *search = reinterpret_cast<DropWindowSearch *>(param);
    wchar_t name[64] = {};
    if (GetClassNameW(hwnd, name, 64) <= 0)
        return TRUE;

    if (wcscmp(name, L"Chrome_RenderWidgetHostHWND") == 0) {
        if (!search->render || (!IsWindowVisible(search->render) && IsWindowVisible(hwnd)))
            search->render = hwnd;
    } else if (wcscmp(name, L"Chrome_WidgetWin_1") == 0) {
        if (!search->widget || (!IsWindowVisible(search->widget) && IsWindowVisible(hwnd)))
            search->widget = hwnd;
    }
    return TRUE; // 继续枚举：两层子窗口都要看到
}

// 返回实际承接鼠标/拖放的子窗口；没找到返回空，调用方退回宿主窗口。
HWND findDropWindow(HWND host)
{
    if (!host || !IsWindow(host))
        return nullptr;
    DropWindowSearch search;
    EnumChildWindows(host, dropWindowProc, reinterpret_cast<LPARAM>(&search));
    return search.render ? search.render : search.widget;
}

// ---- 最小 COM 引用计数基类 ----
class RefCounted
{
public:
    ULONG AddRef() { return ++m_ref; }
    ULONG Release()
    {
        const ULONG refs = --m_ref;
        if (refs == 0)
            delete this;
        return refs;
    }

protected:
    virtual ~RefCounted() = default;

private:
    std::atomic<ULONG> m_ref{1};
};

// 环境创建完成：转交 Qt 侧继续创建控制器
class EnvironmentHandler final
    : public RefCounted
    , public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
{
public:
    explicit EnvironmentHandler(WebView2Editor *owner) : m_owner(owner) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown
            || riid == IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler) {
            *ppv = static_cast<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr,
                                     ICoreWebView2Environment *environment) override
    {
        if (m_owner) {
            m_owner->onEnvironmentReady(static_cast<long>(hr), environment);
        } else if (environment) {
            // 宿主已销毁：完成回调携带的所有权必须在这里归还，不能只是 return
            environment->Release();
        }
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
};

// 控制器创建完成
class ControllerHandler final
    : public RefCounted
    , public ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
{
public:
    explicit ControllerHandler(WebView2Editor *owner) : m_owner(owner) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown
            || riid == IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) {
            *ppv = static_cast<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller *controller) override
    {
        if (m_owner) {
            m_owner->onControllerReady(static_cast<long>(hr), controller);
        } else if (controller) {
            // 宿主已销毁（窗口比初始化先关掉）：控制器已经绑在即将销毁的 HWND 上，
            // 必须 Close 后归还所有权，否则 WebView2 会一直挂着它
            controller->Close();
            controller->Release();
        }
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
};

// 页面 -> 原生：把 WebMessageAsJson 原样交给共享的消息分发
class WebMessageHandler final
    : public RefCounted
    , public ICoreWebView2WebMessageReceivedEventHandler
{
public:
    explicit WebMessageHandler(WebView2Editor *owner) : m_owner(owner) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2WebMessageReceivedEventHandler) {
            *ppv = static_cast<ICoreWebView2WebMessageReceivedEventHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 *sender,
                                     ICoreWebView2WebMessageReceivedEventArgs *args) override
    {
        Q_UNUSED(sender)
        LPWSTR raw = nullptr;
        if (SUCCEEDED(args->get_WebMessageAsJson(&raw)) && raw) {
            const QString json = QString::fromWCharArray(raw);
            CoTaskMemFree(raw);
            if (m_owner)
                m_owner->onWebMessage(json);
        }
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
};

// 快捷键：WebView2 自己的加速键（Ctrl+Z/B/I/U…）会先于页面处理，
// 这里拦下来转给 Qt 的 QAction，与菜单点击走同一条实现。
class AcceleratorKeyHandler final
    : public RefCounted
    , public ICoreWebView2AcceleratorKeyPressedEventHandler
{
public:
    explicit AcceleratorKeyHandler(WebView2Editor *owner) : m_owner(owner) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2AcceleratorKeyPressedEventHandler) {
            *ppv = static_cast<ICoreWebView2AcceleratorKeyPressedEventHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(
        ICoreWebView2Controller *sender,
        ICoreWebView2AcceleratorKeyPressedEventArgs *args) override
    {
        Q_UNUSED(sender)
        COREWEBVIEW2_KEY_EVENT_KIND kind;
        if (FAILED(args->get_KeyEventKind(&kind)))
            return S_OK;
        if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
            && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) {
            return S_OK;
        }
        UINT virtualKey = 0;
        if (FAILED(args->get_VirtualKey(&virtualKey)) || !m_owner)
            return S_OK;
        if (!m_owner->onAccelerator(static_cast<int>(virtualKey)))
            return S_OK;
        // 先声明按键已被处理；动作本身已由 onAccelerator 排队到下一轮事件循环
        args->put_Handled(TRUE);
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
};

// 导航拦截：只放行编辑器自己的页面，其余取消（对标 macOS 的 MoteNavigationDelegate）
class NavigationStartingHandler final
    : public RefCounted
    , public ICoreWebView2NavigationStartingEventHandler
{
public:
    explicit NavigationStartingHandler(WebView2Editor *owner) : m_owner(owner) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2NavigationStartingEventHandler) {
            *ppv = static_cast<ICoreWebView2NavigationStartingEventHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 *sender,
                                     ICoreWebView2NavigationStartingEventArgs *args) override
    {
        Q_UNUSED(sender)
        LPWSTR raw = nullptr;
        if (FAILED(args->get_Uri(&raw)))
            return S_OK; // 拿不到 URI 就不拦，宁可放行也不要把编辑器自己的页面挡掉
        const QString uri = raw ? QString::fromWCharArray(raw) : QString();
        if (raw)
            CoTaskMemFree(raw);
        if (m_owner && !m_owner->onNavigationStarting(uri))
            args->put_Cancel(TRUE);
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
};

// 页面要求开新窗口（target=_blank / window.open）：取消默认的独立窗口，URL 交回外壳
class NewWindowRequestedHandler final
    : public RefCounted
    , public ICoreWebView2NewWindowRequestedEventHandler
{
public:
    explicit NewWindowRequestedHandler(WebView2Editor *owner) : m_owner(owner) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2NewWindowRequestedEventHandler) {
            *ppv = static_cast<ICoreWebView2NewWindowRequestedEventHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 *sender,
                                     ICoreWebView2NewWindowRequestedEventArgs *args) override
    {
        Q_UNUSED(sender)
        // 一律取消 WebView2 的默认弹窗行为
        args->put_Handled(TRUE);

        LPWSTR raw = nullptr;
        if (FAILED(args->get_Uri(&raw)))
            return S_OK;
        const QString url = raw ? QString::fromWCharArray(raw) : QString();
        if (raw)
            CoTaskMemFree(raw);
        const QPointer<WebView2Editor> owner = m_owner;
        if (url.isEmpty() || !owner)
            return S_OK;

        // 打开链接可能弹未保存确认对话框；延后到下一轮事件循环，避免在 WebView2
        // 的事件回调里开嵌套事件循环（与拖放那边同一口径）
        QTimer::singleShot(0, owner.data(), [owner, url]() {
            if (owner)
                owner->onExternalUrl(url);
        });
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
};

// 导航完成：页面重建后 WebView2 的子 HWND 可能被换掉（换文档、进程重建），
// 旧句柄上的注册会悬空、拖放静默失效，这里重新找当前子窗口并换绑。
class NavigationCompletedHandler final
    : public RefCounted
    , public ICoreWebView2NavigationCompletedEventHandler
{
public:
    explicit NavigationCompletedHandler(WebView2Editor *owner) : m_owner(owner) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2NavigationCompletedEventHandler) {
            *ppv = static_cast<ICoreWebView2NavigationCompletedEventHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(
        ICoreWebView2 *sender,
        ICoreWebView2NavigationCompletedEventArgs *args) override
    {
        Q_UNUSED(sender)
        Q_UNUSED(args)
        if (m_owner)
            m_owner->refreshDropTarget();
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
};

// 注入回执：把 ExecuteScript 的返回值（JSON）交回宿主，用于确认正文真的进了页面。
// ExecuteScript 的 HRESULT 只反映「脚本是否被提交」，页面里抛异常照样是 S_OK。
class ScriptResultHandler final
    : public RefCounted
    , public ICoreWebView2ExecuteScriptCompletedHandler
{
public:
    ScriptResultHandler(WebView2Editor *owner, bool chunked)
        : m_owner(owner)
        , m_chunked(chunked) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICoreWebView2ExecuteScriptCompletedHandler) {
            *ppv = static_cast<ICoreWebView2ExecuteScriptCompletedHandler *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, LPCWSTR resultObjectAsJson) override
    {
        const QString result =
            resultObjectAsJson ? QString::fromWCharArray(resultObjectAsJson) : QString();
        if (m_owner)
            m_owner->onInjectResult(static_cast<long>(errorCode), result, m_chunked);
        return S_OK;
    }

private:
    QPointer<WebView2Editor> m_owner;
    bool m_chunked = false;
};

Qt::Key keyFromVirtualKey(UINT vk)
{
    if (vk >= 'A' && vk <= 'Z')
        return static_cast<Qt::Key>(vk);
    if (vk >= '0' && vk <= '9')
        return static_cast<Qt::Key>(vk);
    switch (vk) {
    case VK_OEM_1: return Qt::Key_Semicolon;
    case VK_OEM_PLUS: return Qt::Key_Equal;
    case VK_OEM_MINUS: return Qt::Key_Minus;
    case VK_OEM_COMMA: return Qt::Key_Comma;
    case VK_OEM_PERIOD: return Qt::Key_Period;
    case VK_OEM_2: return Qt::Key_Slash;
    case VK_OEM_3: return Qt::Key_QuoteLeft;
    case VK_OEM_4: return Qt::Key_BracketLeft;
    case VK_OEM_5: return Qt::Key_Backslash;
    case VK_OEM_6: return Qt::Key_BracketRight;
    case VK_OEM_7: return Qt::Key_Apostrophe;
    case VK_SPACE: return Qt::Key_Space;
    case VK_RETURN: return Qt::Key_Return;
    case VK_ADD: return Qt::Key_Plus;
    case VK_SUBTRACT: return Qt::Key_Minus;
    default: return Qt::Key_unknown;
    }
}

template <typename Fn>
Fn loadProc(HMODULE module, const char *name)
{
    return reinterpret_cast<Fn>(reinterpret_cast<void *>(GetProcAddress(module, name)));
}

EventRegistrationToken tokenOf(qint64 value)
{
    EventRegistrationToken token;
    token.value = value;
    return token;
}

QString hrText(long hr)
{
    return QStringLiteral("0x%1").arg(static_cast<quint32>(hr), 8, 16, QLatin1Char('0'));
}

// 单条脚本 / 单条消息的体积预算。WebView2 的 ExecuteScript 与 PostWebMessageAsJson
// 都在 2MB 量级封顶，这里各留一半余量给 JSON 转义与 UTF-8 膨胀。
constexpr qsizetype kScriptBudget = 512 * 1024;
constexpr qsizetype kMessageBudget = 1536 * 1024;

// 按「转义之后的 UTF-8 字节数」切分文本：中文每字符 3 字节、引号/反斜杠还会翻倍，
// 所以不能按 QString 的 UTF-16 码元数切；同时不切断 UTF-16 代理对（emoji）。
QStringList splitByPayloadBudget(const QString &text, qsizetype budget)
{
    QStringList chunks;
    const qsizetype total = text.size();
    qsizetype start = 0;
    while (start < total) {
        qsizetype end = qMin(total, start + budget);
        if (end < total && text.at(end - 1).isHighSurrogate())
            --end;
        while (end > start + 1
               && moteJsonLiteral(text.mid(start, end - start)).toUtf8().size() > budget) {
            end = start + qMax<qsizetype>(1, (end - start) * 3 / 4);
        }
        chunks.append(text.mid(start, end - start));
        start = end;
    }
    return chunks;
}

} // namespace

WebView2Editor::WebView2Editor(QWidget *parent)
    : WebViewBase(parent)
{
    setAttribute(Qt::WA_NativeWindow);
    setFocusPolicy(Qt::StrongFocus);
}

WebView2Editor::~WebView2Editor()
{
    if (!m_pageFile.isEmpty())
        QFile::remove(m_pageFile);

    // 窗口销毁前撤销注册；OLE 目标自身带引用计数，Release 后由 COM 回收。
    // 注册可能挂在 WebView2 子窗口上，必须用当初注册的那个 HWND 成对撤销。
    if (m_dropTarget) {
        moteDropRevoke(m_dropHwnd, m_dropTarget);
        m_dropTarget = nullptr;
        m_dropHwnd = nullptr;
    }

    if (m_webView) {
        auto *web = static_cast<ICoreWebView2 *>(m_webView);
        if (m_messageToken)
            web->remove_WebMessageReceived(tokenOf(m_messageToken));
        if (m_navToken)
            web->remove_NavigationStarting(tokenOf(m_navToken));
        if (m_newWindowToken)
            web->remove_NewWindowRequested(tokenOf(m_newWindowToken));
        if (m_navDoneToken)
            web->remove_NavigationCompleted(tokenOf(m_navDoneToken));
    }
    if (m_controller) {
        auto *controller = static_cast<ICoreWebView2Controller *>(m_controller);
        if (m_accelToken)
            controller->remove_AcceleratorKeyPressed(tokenOf(m_accelToken));
        controller->Close();
        controller->Release();
        m_controller = nullptr;
    }
    if (m_webView) {
        static_cast<ICoreWebView2 *>(m_webView)->Release();
        m_webView = nullptr;
    }
    if (m_environment) {
        static_cast<ICoreWebView2Environment *>(m_environment)->Release();
        m_environment = nullptr;
    }
    if (m_loader) {
        FreeLibrary(static_cast<HMODULE>(m_loader));
        m_loader = nullptr;
    }
}

void WebView2Editor::ensureHost()
{
    if (m_initialized)
        return;
    m_initialized = true;

    m_hostHwnd = reinterpret_cast<void *>(winId());
    if (!m_hostHwnd) {
        showUnavailable(tr("无法创建窗口句柄。"));
        return;
    }

    // 拖放注册独立于 WebView2：拿得到真实路径，.md 打开/图片落盘都由共享层处理
    ensureDropTarget();

    // 优先从 exe 同级目录加载（打包附带），其次走系统搜索路径
    m_loader = LoadLibraryW(L"WebView2Loader.dll");
    if (!m_loader) {
        showUnavailable(tr("缺少 WebView2Loader.dll，请重新解压绿色版或重新安装 Mote。"));
        return;
    }
    if (!GetProcAddress(static_cast<HMODULE>(m_loader),
                        "CreateCoreWebView2EnvironmentWithOptions")) {
        showUnavailable(tr("WebView2Loader.dll 版本不匹配（缺少环境创建接口）。"));
        return;
    }

    // 先确认运行时存在：缺失时只提示，不自动回退旧引擎
    const auto getVersion = loadProc<GetVersionFn>(
        static_cast<HMODULE>(m_loader), "GetAvailableCoreWebView2BrowserVersionString");
    if (getVersion) {
        LPWSTR version = nullptr;
        const HRESULT hr = getVersion(nullptr, &version);
        const bool found = SUCCEEDED(hr) && version && *version;
        if (version)
            CoTaskMemFree(version);
        if (!found) {
            showUnavailable(tr("未检测到 WebView2 运行时。"));
            return;
        }
    }

    startEnvironment();
}

void WebView2Editor::startEnvironment()
{
    const auto createEnvironment = loadProc<CreateEnvironmentFn>(
        static_cast<HMODULE>(m_loader), "CreateCoreWebView2EnvironmentWithOptions");
    if (!createEnvironment) {
        showUnavailable(tr("WebView2Loader.dll 版本不匹配（缺少环境创建接口）。"));
        return;
    }

    QString dataDir = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    if (dataDir.isEmpty())
        dataDir = QDir::tempPath() + QStringLiteral("/Mote");
    dataDir += QStringLiteral("/WebView2");
    QDir().mkpath(dataDir);

    auto *handler = new EnvironmentHandler(this);
    const HRESULT hr = createEnvironment(
        nullptr, reinterpret_cast<PCWSTR>(dataDir.utf16()), nullptr, handler);
    handler->Release();
    if (FAILED(hr))
        showUnavailable(tr("WebView2 环境创建失败（%1）。").arg(hrText(static_cast<long>(hr))));
}

void WebView2Editor::onEnvironmentReady(long hr, void *environment)
{
    if (FAILED(static_cast<HRESULT>(hr)) || !environment) {
        showUnavailable(tr("WebView2 环境创建失败（%1）。").arg(hrText(hr)));
        // 失败时也可能带着对象：所有权已转移过来，必须归还
        if (environment)
            static_cast<ICoreWebView2Environment *>(environment)->Release();
        return;
    }
    // 完成回调把 environment 的所有权交给宿主：直接持有、不再 AddRef，
    // 析构里 Release 一次即平衡（与 m_webView 那条链路一致）
    auto *env = static_cast<ICoreWebView2Environment *>(environment);
    m_environment = env;

    auto *handler = new ControllerHandler(this);
    const HRESULT result = env->CreateCoreWebView2Controller(
        static_cast<HWND>(m_hostHwnd), handler);
    handler->Release();
    if (FAILED(result))
        showUnavailable(tr("WebView2 控制器创建失败（%1）。")
                            .arg(hrText(static_cast<long>(result))));
}

void WebView2Editor::onControllerReady(long hr, void *controller)
{
    if (FAILED(static_cast<HRESULT>(hr)) || !controller) {
        showUnavailable(tr("WebView2 控制器创建失败（%1）。").arg(hrText(hr)));
        // 同上：失败路径上的对象也要 Close + 归还所有权
        if (controller) {
            static_cast<ICoreWebView2Controller *>(controller)->Close();
            static_cast<ICoreWebView2Controller *>(controller)->Release();
        }
        return;
    }
    // 同上：controller 的所有权随完成回调转移过来，析构里 Close + Release 各一次
    auto *ctrl = static_cast<ICoreWebView2Controller *>(controller);
    m_controller = ctrl;

    ICoreWebView2 *web = nullptr;
    if (FAILED(ctrl->get_CoreWebView2(&web)) || !web) {
        showUnavailable(tr("无法获取 WebView2 页面对象。"));
        return;
    }
    m_webView = web;

    configureWebView();

    // 控制器就绪后重新找 WebView2 的子窗口，把拖放目标从宿主换绑到实际命中处；
    // 此时子窗口可能还没建，找不到就继续留在宿主上，等 NavigationCompleted 再试。
    ensureDropTarget();

    // 宿主已接管拖放时关掉 WebView2 自己的，避免两套目标互相抢；
    // 注册失败（例如线程不在 STA）则保持原状，页面内 drop 事件继续兜底。
    if (m_dropTarget)
        disableWebViewExternalDrop();

    m_controllerReady = true;
    updateBounds();
    ctrl->put_IsVisible(TRUE);

    // 诊断开关：MOTE_WEBVIEW_DEVTOOLS=1 时顺手打开 DevTools，现场可以直接看 Console
    if (qEnvironmentVariableIsSet("MOTE_WEBVIEW_DEVTOOLS"))
        web->OpenDevToolsWindow();

    if (m_hasDeferredLoad) {
        m_hasDeferredLoad = false;
        navigateFor(m_deferredDir);
    }
}

void WebView2Editor::configureWebView()
{
    auto *web = static_cast<ICoreWebView2 *>(m_webView);

    ICoreWebView2Settings *settings = nullptr;
    if (SUCCEEDED(web->get_Settings(&settings)) && settings) {
        // 关掉浏览器默认右键菜单 / 开发者工具 / 状态条 / 原生缩放，避免和外壳的
        // 中文菜单、CSS 缩放重复；页面自己实现了右键菜单与缩放。
        // 诊断开关：MOTE_WEBVIEW_DEVTOOLS=1 时保留 DevTools，便于现场看 Console。
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_AreDevToolsEnabled(
            qEnvironmentVariableIsSet("MOTE_WEBVIEW_DEVTOOLS") ? TRUE : FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        settings->Release();
    }

    // 文档创建前注入桥接脚本：editor.js 一加载就会 post ready，必须先生效
    const HRESULT bridge = web->AddScriptToExecuteOnDocumentCreated(kBridgeScript, nullptr);
    if (FAILED(bridge)) {
        // 桥接没挂上时页面照样渲染，但 ready / 各类消息都回不来，界面会停在空白页。
        // 这是「白屏且无报错」的一条真实通道，必须报到界面上。
        const QString detail = tr("页面桥接脚本注入失败（%1）：编辑器可能停在空白页。")
                                   .arg(hrText(static_cast<long>(bridge)));
        if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
            std::fprintf(stderr, "WIN bridge script failed: %s\n", detail.toUtf8().constData());
        emit errorOccurred(detail);
    }

    EventRegistrationToken token{};
    auto *messageHandler = new WebMessageHandler(this);
    web->add_WebMessageReceived(messageHandler, &token);
    messageHandler->Release();
    m_messageToken = token.value;

    auto *navHandler = new NavigationStartingHandler(this);
    web->add_NavigationStarting(navHandler, &token);
    navHandler->Release();
    m_navToken = token.value;

    auto *newWindowHandler = new NewWindowRequestedHandler(this);
    web->add_NewWindowRequested(newWindowHandler, &token);
    newWindowHandler->Release();
    m_newWindowToken = token.value;

    auto *navDoneHandler = new NavigationCompletedHandler(this);
    web->add_NavigationCompleted(navDoneHandler, &token);
    navDoneHandler->Release();
    m_navDoneToken = token.value;

    auto *accelHandler = new AcceleratorKeyHandler(this);
    static_cast<ICoreWebView2Controller *>(m_controller)
        ->add_AcceleratorKeyPressed(accelHandler, &token);
    accelHandler->Release();
    m_accelToken = token.value;
}

void WebView2Editor::showEvent(QShowEvent *event)
{
    QWidget::showEvent(event);
    ensureHost();
    updateBounds();
    if (m_controller)
        static_cast<ICoreWebView2Controller *>(m_controller)->put_IsVisible(TRUE);
}

void WebView2Editor::resizeEvent(QResizeEvent *event)
{
    QWidget::resizeEvent(event);
    updateBounds();
    if (m_unavailable)
        m_unavailable->setGeometry(rect());
}

void WebView2Editor::updateBounds()
{
    if (!m_controller)
        return;
    RECT bounds{0, 0, qMax(0, width()), qMax(0, height())};
    static_cast<ICoreWebView2Controller *>(m_controller)->put_Bounds(bounds);
}

void WebView2Editor::ensureDropTarget()
{
    if (!m_hostHwnd)
        return;
    HWND host = static_cast<HWND>(m_hostHwnd);
    if (!IsWindow(host))
        return;

    // 优先挂到实际命中鼠标的子窗口；找不到子窗口（WebView2 未就绪/结构变化）
    // 就退回宿主窗口，保持页面内 drop 兜底与旧行为。
    HWND wanted = findDropWindow(host);
    if (!wanted)
        wanted = host;

    // 已挂稳：注册还在，且目标窗口没被重建替换
    if (m_dropTarget && m_dropHwnd == wanted && IsWindow(static_cast<HWND>(m_dropHwnd)))
        return;

    // 换绑前先成对撤销旧窗口上的注册，避免句柄悬空
    if (m_dropTarget) {
        moteDropRevoke(m_dropHwnd, m_dropTarget);
        m_dropTarget = nullptr;
        m_dropHwnd = nullptr;
    }

    MoteDropCallbacks callbacks;
    callbacks.canAccept = [this](const QStringList &paths) {
        return acceptsNativeFileDrop(paths);
    };
    // Drop 回调在下一轮事件循环执行；用 QPointer 防止控件已销毁
    callbacks.perform = [owner = QPointer<WebView2Editor>(this)](const QStringList &paths) {
        if (owner)
            owner->handleNativeFileDrop(paths);
    };

    QString dropError;
    void *target = moteDropRegister(wanted, callbacks, &dropError);
    if (!target && wanted != host) {
        // 子窗口注册失败（例如它属于别的进程且拒绝）：退回宿主窗口
        target = moteDropRegister(host, callbacks, &dropError);
        if (target)
            wanted = host;
    }

    m_dropTarget = target;
    m_dropHwnd = target ? wanted : nullptr;

    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        if (m_dropTarget) {
            wchar_t name[64] = {};
            GetClassNameW(static_cast<HWND>(m_dropHwnd), name, 64);
            std::fprintf(stderr, "WIN drop target registered on %ls (host=%p)\n",
                         name, static_cast<void *>(host));
        } else {
            std::fprintf(stderr, "WIN drop target unavailable (page fallback): %s\n",
                         dropError.toUtf8().constData());
        }
    }

    if (!m_dropTarget) {
        // win32 构建没有控制台，stderr 看不见：用状态栏明说「系统级拖放没挂上、走页面内兜底」。
        // 延后一轮，保证外壳已经连好 errorOccurred 再发。
        const QString detail = dropError.isEmpty() ? tr("原因未知") : dropError;
        QTimer::singleShot(0, this, [this, detail]() {
            emit errorOccurred(tr("系统级拖放未启用（%1）。已退回页面内拖放："
                                  "拖入图片可能拿不到真实文件路径。").arg(detail));
        });
    }
}

void WebView2Editor::refreshDropTarget()
{
    // 导航完成时子窗口可能刚重建：立即试一次，稍后再确认一次（拿最终句柄）。
    QTimer::singleShot(0, this, [this]() { ensureDropTarget(); });
    QTimer::singleShot(500, this, [this]() { ensureDropTarget(); });
}

void WebView2Editor::disableWebViewExternalDrop()
{
    auto *controller = static_cast<ICoreWebView2Controller *>(m_controller);
    if (!controller)
        return;

    // AllowExternalDrop 在 ICoreWebView2Controller4 上（运行时较旧时 QI 失败，
    // 此时保持默认，仍可退回页面内 drop 事件）
    ICoreWebView2Controller4 *controller4 = nullptr;
    if (SUCCEEDED(controller->QueryInterface(
            IID_ICoreWebView2Controller4, reinterpret_cast<void **>(&controller4)))
        && controller4) {
        controller4->put_AllowExternalDrop(FALSE);
        controller4->Release();
    }
}

void WebView2Editor::evaluateJs(const QString &js)
{
    if (!m_webView)
        return;
    static_cast<ICoreWebView2 *>(m_webView)
        ->ExecuteScript(js.toStdWString().c_str(), nullptr);
}

void WebView2Editor::injectMarkdown(const QString &text)
{
    auto *web = m_webView ? static_cast<ICoreWebView2 *>(m_webView) : nullptr;
    if (!web)
        return; // 页面还没起来：保持 pending，等 ready 后由共享层再走这里

    // 体积一律按「JSON 转义之后的 UTF-8 字节数」判断：WebView2 限额是字节，
    // 不是 QString 的 UTF-16 码元数；中文每字符 3 字节，引号/换行还要再翻倍。
    const QString literal = moteJsonLiteral(text);
    const QByteArray escaped = literal.toUtf8();
    QString failure;

    // 通道一：单条 ExecuteScript，脚本体积最省。脚本自己返回 'ok'，宿主据此确认
    // 正文真的进了页面——ExecuteScript 的 S_OK 只代表脚本被提交，JS 抛异常照样 S_OK。
    if (escaped.size() <= kScriptBudget) {
        const QString js = QStringLiteral(
            "(function(){if(!window.mote)return 'no-mote';"
            "try{window.mote.setMarkdown(%1);return 'ok';}"
            "catch(e){return 'ERR '+(e&&e.message?e.message:e);}})();").arg(literal);
        auto *resultHandler = new ScriptResultHandler(this, false);
        const HRESULT injected = web->ExecuteScript(js.toStdWString().c_str(), resultHandler);
        resultHandler->Release();
        if (SUCCEEDED(injected))
            return; // 生效与否由 onInjectResult 判定，确认成功才清 pending
        failure = tr("脚本提交失败 %1").arg(hrText(static_cast<long>(injected)));
    }

    // 通道二：大文档走 PostWebMessageAsJson，不占脚本额度。
    // 桥接脚本（kBridgeScript）在文档创建时已接管 {"__mote":"setMarkdown", ...}
    const QString json = QStringLiteral("{\"__mote\":\"setMarkdown\",\"text\":%1}")
                             .arg(literal);
    const QByteArray payload = json.toUtf8();
    if (payload.size() <= kMessageBudget) {
        const HRESULT posted = web->PostWebMessageAsJson(json.toStdWString().c_str());
        if (SUCCEEDED(posted)) {
            m_hasPending = false; // 只有投递成功才清 pending
            return;
        }
        const QString postedFailure =
            tr("消息投递失败 %1").arg(hrText(static_cast<long>(posted)));
        failure = failure.isEmpty() ? postedFailure
                                    : failure + QStringLiteral("；") + postedFailure;
    } else {
        const QString sizeFailure =
            tr("消息体积 %1 字节超出上限").arg(static_cast<qlonglong>(payload.size()));
        failure = failure.isEmpty() ? sizeFailure
                                    : failure + QStringLiteral("；") + sizeFailure;
    }

    // 回落：分片 ExecuteScript 注入，每片单独受脚本体积预算约束。
    // 这里同样只看「是否提交成功」，真正生效与否由 onInjectResult(chunked=true) 判定。
    if (injectChunked(text))
        return;

    // 两条通道都失败：保留 pending（下次 ready 还能重试），并把失败明确报出来，
    // 不要只剩一个空白的正文区
    const QString detail = tr("无法把 %1 字符的文档注入编辑器（%2）。")
                               .arg(static_cast<qlonglong>(text.size()))
                               .arg(failure);
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "WIN inject failed: %s\n", detail.toUtf8().constData());
    emit errorOccurred(detail);
    showFailureOverlay(tr("文档载入失败"),
                       tr("<p>%1</p><p>分片注入也没有成功。可以先另存为文件后重新打开，"
                          "或把文档拆小一些再试。</p>").arg(detail.toHtmlEscaped()));
}

bool WebView2Editor::injectChunked(const QString &text)
{
    auto *web = static_cast<ICoreWebView2 *>(m_webView);
    if (!web)
        return false;

    // 先清掉上次中途失败留下的半截内容
    if (FAILED(web->ExecuteScript(L"window.__moteInject=[];", nullptr)))
        return false;

    const QString pushScript = QStringLiteral("window.__moteInject.push(%1);");
    const QStringList chunks = splitByPayloadBudget(text, kScriptBudget);
    for (const QString &chunk : chunks) {
        const QString js = pushScript.arg(moteJsonLiteral(chunk));
        if (FAILED(web->ExecuteScript(js.toStdWString().c_str(), nullptr)))
            return false;
    }

    // 各片按顺序排队执行，最后一片之后拼接并交给页面
    const QString applyScript = QStringLiteral(
        "(function(){var t=(window.__moteInject||[]).join('');window.__moteInject=[];"
        "if(!window.mote)return 'no-mote';"
        "try{window.mote.setMarkdown(t);return 'ok';}"
        "catch(e){return 'ERR '+(e&&e.message?e.message:e);}})();");
    auto *resultHandler = new ScriptResultHandler(this, true);
    const HRESULT applied = web->ExecuteScript(applyScript.toStdWString().c_str(), resultHandler);
    resultHandler->Release();
    return SUCCEEDED(applied);
}

void WebView2Editor::onInjectResult(long hr, const QString &resultJson, bool chunked)
{
    // 页面脚本显式 return 'ok' 才算真的注入成功；'no-mote' / 'ERR ...' 都是没生效
    if (SUCCEEDED(static_cast<HRESULT>(hr)) && resultJson == QLatin1String("\"ok\"")) {
        m_hasPending = false;
        clearFailureOverlay();
        return;
    }

    const QString reason = FAILED(static_cast<HRESULT>(hr))
        ? tr("脚本提交失败 %1").arg(hrText(hr))
        : (resultJson.isEmpty() ? tr("页面没有返回结果") : tr("页面返回 %1").arg(resultJson));
    const QString channel = chunked ? tr("分片注入") : tr("单条注入");
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        std::fprintf(stderr, "WIN inject %s failed: %s\n",
                     chunked ? "chunked" : "single", reason.toUtf8().constData());
    }
    // pending 保留：页面再次 ready 时会重试；同时把失败报到状态栏与覆盖层，
    // 不要留给用户一块空白正文去猜
    emit errorOccurred(tr("正文注入没有生效（%1，%2）。").arg(channel, reason));
    showFailureOverlay(tr("正文载入失败"),
                       tr("<p>%1：%2</p><p>正文没有进入编辑器。可以先把文档「另存为」到"
                          "可写目录再重新打开，或重启 Mote 后重试。</p>")
                           .arg(channel, reason.toHtmlEscaped()));
}

void WebView2Editor::loadPage(const QUrl &baseDir)
{
    m_deferredDir = baseDir;
    m_hasDeferredLoad = true;
    if (!m_controllerReady || !m_webView)
        return; // 控制器就绪后补做导航
    m_hasDeferredLoad = false;
    navigateFor(baseDir);
}

void WebView2Editor::navigateFor(const QUrl &baseDir)
{
    if (!m_webView)
        return;
    // 换页前先清掉上一次的失败提示，别让旧覆盖层盖住新页面
    clearFailureOverlay();
    auto *web = static_cast<ICoreWebView2 *>(m_webView);

    const QString dir = baseDir.toLocalFile();
    QString page = motePageHtml();
    if (dir.isEmpty()) {
        // 未命名文档：没有可解析的相对资源，直接注入
        m_pageUrl.clear(); // NavigateToString 的 URL 是 about:blank，由白名单的 about: 规则放行
        const HRESULT hr = web->NavigateToString(page.toStdWString().c_str());
        if (FAILED(hr))
            reportNavigationFailure(tr("内置页面注入"), hr);
        return;
    }

    const bool virtualMode = useVirtualHost();
    const QString baseUrl = virtualMode
        ? QStringLiteral("https://%1/").arg(virtualHost())
        : QUrl::fromLocalFile(dir + QLatin1Char('/')).toString();

    // 只替换页面模板自己的 </head>（第一处），避免改到内嵌 JS 里的字面量
    const int headEnd = page.indexOf(QStringLiteral("</head>"));
    if (headEnd >= 0) {
        page.replace(headEnd, 7,
                     QStringLiteral("<base href=\"%1\"></head>").arg(baseUrl.toHtmlEscaped()));
    }

    const QString filePath = filePathOf(dir);
    if (!m_pageFile.isEmpty() && m_pageFile != filePath)
        QFile::remove(m_pageFile);

    QFile file(filePath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        // 文档目录不可写时退回 NavigateToString：页面能渲染，但相对图片解析不到
        m_pageUrl.clear();
        const HRESULT hr = web->NavigateToString(page.toStdWString().c_str());
        if (FAILED(hr))
            reportNavigationFailure(tr("退回内置页面注入"), hr);
        return;
    }
    file.write(page.toUtf8());
    file.close();
    m_pageFile = filePath;

    if (virtualMode) {
        ICoreWebView2_3 *web3 = nullptr;
        if (SUCCEEDED(web->QueryInterface(IID_ICoreWebView2_3,
                                          reinterpret_cast<void **>(&web3)))
            && web3) {
            const HRESULT mapped = web3->SetVirtualHostNameToFolderMapping(
                virtualHost().toStdWString().c_str(), dir.toStdWString().c_str(),
                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
            web3->Release();
            if (SUCCEEDED(mapped)) {
                const QString url = QStringLiteral("https://%1/%2")
                                        .arg(virtualHost(), QFileInfo(filePath).fileName());
                m_pageUrl = url;
                const HRESULT hr = web->Navigate(url.toStdWString().c_str());
                if (FAILED(hr))
                    reportNavigationFailure(tr("虚拟主机导航"), hr);
                return;
            }
        }
        // 映射不可用时退回本地文件
    }

    const QString url = QUrl::fromLocalFile(filePath).toString();
    m_pageUrl = url;
    const HRESULT hr = web->Navigate(url.toStdWString().c_str());
    if (FAILED(hr))
        reportNavigationFailure(tr("本地页面导航"), hr);
}

void WebView2Editor::onWebMessage(const QString &json)
{
    handleMessage(json);
}

bool WebView2Editor::onAccelerator(int virtualKey)
{
    Qt::KeyboardModifiers modifiers = Qt::NoModifier;
    if (GetKeyState(VK_CONTROL) & 0x8000)
        modifiers |= Qt::ControlModifier;
    if (GetKeyState(VK_SHIFT) & 0x8000)
        modifiers |= Qt::ShiftModifier;
    if (GetKeyState(VK_MENU) & 0x8000)
        modifiers |= Qt::AltModifier;

    const Qt::Key key = keyFromVirtualKey(static_cast<UINT>(virtualKey));
    if (key != Qt::Key_unknown) {
        const QKeySequence pressed(QKeyCombination(modifiers, key));
        if (QWidget *top = window()) {
            const auto actions = top->findChildren<QAction *>();
            for (QAction *action : actions) {
                if (!action->isEnabled() || action->shortcuts().isEmpty())
                    continue;
                for (const QKeySequence &sequence : action->shortcuts()) {
                    if (sequence == pressed) {
                        if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
                            std::fprintf(stderr, "WIN accelerator -> %s\n",
                                         action->text().toUtf8().constData());
                        }
                        // 回调方返回后会立刻 put_Handled(TRUE)，但动作本身排队到下一轮
                        // 事件循环：Ctrl+O/S/N 会弹模态对话框，在 WebView2 的加速键回调里
                        // 同步执行会开嵌套事件循环并重入 WebView。与拖放同一口径。
                        const QPointer<QAction> deferred(action);
                        QTimer::singleShot(0, this, [deferred]() {
                            if (deferred)
                                deferred->trigger();
                        });
                        return true;
                    }
                }
            }
        }
    }

    // Chromium 内建的 Ctrl+U 会往 contenteditable 注入 <u>，编辑器没有这个概念，直接吞掉
    if ((modifiers & Qt::ControlModifier) && !(modifiers & (Qt::AltModifier | Qt::ShiftModifier))
        && key == Qt::Key_U) {
        return true;
    }
    return false;
}

bool WebView2Editor::onNavigationStarting(const QString &uri)
{
    // 兜底开关：现场排查白屏时用来一次性排除「拦截误杀」（MOTE_WEBVIEW_ALLOW_ALL_NAV=1）
    if (qEnvironmentVariableIsSet("MOTE_WEBVIEW_ALLOW_ALL_NAV"))
        return true;

    const QUrl url(uri);

    // 还没有自己的页面（第一次导航）：一律放行。与 macOS 的 `!current` 分支同口径，
    // 避免导航发生在「记下页面 URL」之前时把自己挡掉。
    if (m_pageUrl.isEmpty() && m_pageFile.isEmpty())
        return true;

    // NavigateToString 注入的页面与内部框架，URI 都是 about: 协议
    if (uri.isEmpty()
        || url.scheme().compare(QLatin1String("about"), Qt::CaseInsensitive) == 0) {
        return true;
    }

    // 正在加载的那一页：按完整 URL 精确放行（file:// 与虚拟主机两种模式都覆盖）
    if (!m_pageUrl.isEmpty() && (uri == m_pageUrl || url == QUrl(m_pageUrl)))
        return true;

    // WebView2 可能把 URL 规范化（大小写、百分号编码、盘符写法）后再报出来，
    // 精确比较不中时退一步只比文件名。QUrl::fileName() 会解码百分号转义。
    if (!m_pageFile.isEmpty()) {
        const QString pageName = QFileInfo(m_pageFile).fileName();
        if (!pageName.isEmpty() && url.fileName() == pageName)
            return true;
    }

    // 取消导航的后果是一整块白屏，必须留下可见痕迹，不能让用户对着白页猜
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "WIN nav blocked %s\n", uri.toUtf8().constData());
    emit statusMessage(tr("已拦截页面内跳转：%1").arg(uri));
    return false;
}

void WebView2Editor::onExternalUrl(const QString &url)
{
    // 与页面里 Cmd+Click 走同一个出口，由外壳决定交给浏览器还是应用内打开；
    // 这里不直接 QDesktopServices::openUrl，避免绕开外壳对 .md / 锚点的处理
    emit openLinkRequested(url);
}

void WebView2Editor::showUnavailable(const QString &reason)
{
    if (m_unavailableShown)
        return;
    m_unavailableShown = true;

    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "WIN webview2 unavailable: %s\n", reason.toUtf8().constData());
    emit errorOccurred(reason);

    showFailureOverlay(tr("需要 WebView2 运行时"),
                       tr("<p>%1</p>"
                          "<p>请安装 Microsoft Edge WebView2 Runtime 后重新启动 Mote：<br>"
                          "<a href=\"https://go.microsoft.com/fwlink/p/?LinkId=2124703\">"
                          "https://go.microsoft.com/fwlink/p/?LinkId=2124703</a></p>")
                           .arg(reason.toHtmlEscaped()));
}

void WebView2Editor::showFailureOverlay(const QString &title, const QString &body)
{
    if (!m_unavailable) {
        auto *label = new QLabel(this);
        label->setAlignment(Qt::AlignCenter);
        label->setTextFormat(Qt::RichText);
        label->setOpenExternalLinks(true);
        // WebView2 是原生子窗口，普通 Qt 子控件画不过它，覆盖层必须也是原生窗口
        label->setAttribute(Qt::WA_NativeWindow);
        m_unavailable = label;
    }
    if (m_unavailable) {
        m_unavailable->setText(tr("<h3>%1</h3>%2").arg(title.toHtmlEscaped(), body));
        m_unavailable->setGeometry(rect());
        m_unavailable->show();
        m_unavailable->raise();
    }
}

void WebView2Editor::clearFailureOverlay()
{
    if (m_unavailable)
        m_unavailable->hide();
}

void WebView2Editor::reportNavigationFailure(const QString &step, long hr)
{
    const QString detail = tr("%1失败（%2）。").arg(step, hrText(hr));
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG"))
        std::fprintf(stderr, "WIN navigate failed: %s\n", detail.toUtf8().constData());
    emit errorOccurred(detail);
    // 导航失败在 Windows 上就是一块纯白页，必须给可见出口
    showFailureOverlay(tr("页面加载失败"),
                       tr("<p>%1</p><p>文档目录不可写或页面文件被占用时会出现这个问题；"
                          "可以改存到其他目录后重新打开。</p>").arg(detail.toHtmlEscaped()));
}

WebEditor *createWebEditor(QWidget *parent)
{
    return new WebView2Editor(parent);
}
