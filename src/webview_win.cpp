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
        if (m_owner && !m_owner->onNavigationStarting(uri)) {
            args->put_Cancel(TRUE);
            if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
                std::fprintf(stderr, "WIN nav blocked %s\n", uri.toUtf8().constData());
            }
        }
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

    // 窗口销毁前撤销注册；OLE 目标自身带引用计数，Release 后由 COM 回收
    if (m_dropTarget) {
        moteDropRevoke(m_hostHwnd, m_dropTarget);
        m_dropTarget = nullptr;
    }

    if (m_webView) {
        auto *web = static_cast<ICoreWebView2 *>(m_webView);
        if (m_messageToken)
            web->remove_WebMessageReceived(tokenOf(m_messageToken));
        if (m_navToken)
            web->remove_NavigationStarting(tokenOf(m_navToken));
        if (m_newWindowToken)
            web->remove_NewWindowRequested(tokenOf(m_newWindowToken));
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

    // 宿主已接管拖放时关掉 WebView2 自己的，避免两套目标互相抢；
    // 注册失败（例如线程不在 STA）则保持原状，页面内 drop 事件继续兜底。
    if (m_dropTarget)
        disableWebViewExternalDrop();

    m_controllerReady = true;
    updateBounds();
    ctrl->put_IsVisible(TRUE);

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
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_AreDevToolsEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        settings->Release();
    }

    // 文档创建前注入桥接脚本：editor.js 一加载就会 post ready，必须先生效
    web->AddScriptToExecuteOnDocumentCreated(kBridgeScript, nullptr);

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
    if (m_dropTarget || !m_hostHwnd)
        return;

    MoteDropCallbacks callbacks;
    callbacks.canAccept = [this](const QStringList &paths) {
        return acceptsNativeFileDrop(paths);
    };
    // Drop 回调在下一轮事件循环执行；用 QPointer 防止控件已销毁
    callbacks.perform = [owner = QPointer<WebView2Editor>(this)](const QStringList &paths) {
        if (owner)
            owner->handleNativeFileDrop(paths);
    };

    m_dropTarget = moteDropRegister(m_hostHwnd, callbacks);
    if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
        std::fprintf(stderr, "WIN drop target %s\n",
                     m_dropTarget ? "registered" : "unavailable (page fallback)");
    }
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
    // ExecuteScript 的脚本体有约 2MB 上限；大文档改走 PostWebMessageAsJson 通道，
    // 由注入的桥接脚本转给 window.mote.setMarkdown。
    if (m_webView && text.size() > 512 * 1024) {
        const QString json = QStringLiteral("{\"__mote\":\"setMarkdown\",\"text\":%1}")
                                 .arg(moteJsonLiteral(text));
        static_cast<ICoreWebView2 *>(m_webView)
            ->PostWebMessageAsJson(json.toStdWString().c_str());
        m_hasPending = false;
        return;
    }
    WebViewBase::injectMarkdown(text);
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
    auto *web = static_cast<ICoreWebView2 *>(m_webView);

    const QString dir = baseDir.toLocalFile();
    QString page = motePageHtml();
    if (dir.isEmpty()) {
        // 未命名文档：没有可解析的相对资源，直接注入
        web->NavigateToString(page.toStdWString().c_str());
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
        web->NavigateToString(page.toStdWString().c_str());
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
                web->Navigate(url.toStdWString().c_str());
                return;
            }
        }
        // 映射不可用时退回本地文件
    }

    const QString url = QUrl::fromLocalFile(filePath).toString();
    web->Navigate(url.toStdWString().c_str());
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
    // 只放行编辑器自己的页面：
    //  - NavigateToString 注入的页面与内部框架，URI 都是 about: 协议
    //  - 写到文档目录的临时页面，file:// 与虚拟主机两种模式都靠同一个文件名识别
    // 其余（外部站点、拖进来的 html 等）一律取消，避免编辑器页面被替换掉。
    // 口径与 macOS 的 MoteNavigationDelegate 一致。
    const QUrl url(uri);
    if (uri.isEmpty()
        || url.scheme().compare(QLatin1String("about"), Qt::CaseInsensitive) == 0) {
        return true;
    }
    if (m_pageFile.isEmpty())
        return false;
    const QString pageName = QFileInfo(m_pageFile).fileName();
    if (pageName.isEmpty())
        return false;
    // QUrl::fileName() 会解码百分号转义，中文/空格路径可以直接比较
    return url.fileName() == pageName;
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

    auto *label = new QLabel(this);
    label->setAlignment(Qt::AlignCenter);
    label->setTextFormat(Qt::RichText);
    label->setOpenExternalLinks(true);
    label->setText(tr("<h3>需要 WebView2 运行时</h3>"
                      "<p>%1</p>"
                      "<p>请安装 Microsoft Edge WebView2 Runtime 后重新启动 Mote：<br>"
                      "<a href=\"https://go.microsoft.com/fwlink/p/?LinkId=2124703\">"
                      "https://go.microsoft.com/fwlink/p/?LinkId=2124703</a></p>")
                       .arg(reason.toHtmlEscaped()));
    label->setGeometry(rect());
    label->show();
    m_unavailable = label;
}

WebEditor *createWebEditor(QWidget *parent)
{
    return new WebView2Editor(parent);
}
