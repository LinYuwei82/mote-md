#include "webview_win_drop.h"

#include <QTimer>

#include <atomic>
#include <cstdio>
#include <string>
#include <utility>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <shellapi.h>

namespace {

// 从 IDataObject 读 CF_HDROP → 真实文件路径；读不到返回空。
QStringList pathsFromDataObject(IDataObject *data)
{
    QStringList paths;
    if (!data)
        return paths;

    FORMATETC format = {CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    STGMEDIUM medium = {};
    if (FAILED(data->GetData(&format, &medium)) || !medium.hGlobal)
        return paths;

    auto drop = static_cast<HDROP>(GlobalLock(medium.hGlobal));
    if (drop) {
        const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
        for (UINT i = 0; i < count; ++i) {
            const UINT length = DragQueryFileW(drop, i, nullptr, 0);
            if (length == 0)
                continue;
            std::wstring buffer(length + 1, L'\0');
            if (DragQueryFileW(drop, i, buffer.data(), length + 1) > 0)
                paths << QString::fromWCharArray(buffer.c_str());
        }
        GlobalUnlock(medium.hGlobal);
    }
    ReleaseStgMedium(&medium);
    return paths;
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

// 只处理 CF_HDROP：可识别的文件给 COPY，其余格式一律 NONE。
class DropTarget final
    : public RefCounted
    , public IDropTarget
{
public:
    explicit DropTarget(MoteDropCallbacks callbacks)
        : m_callbacks(std::move(callbacks)) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override
    {
        if (!ppv)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IDropTarget) {
            *ppv = static_cast<IDropTarget *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE DragEnter(IDataObject *data, DWORD, POINTL,
                                        DWORD *effect) override
    {
        m_acceptable = accepts(data);
        applyEffect(effect, m_acceptable);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragOver(DWORD, POINTL, DWORD *effect) override
    {
        // DragOver 不带 IDataObject，沿用 DragEnter 的判定结果
        applyEffect(effect, m_acceptable);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragLeave() override
    {
        m_acceptable = false;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Drop(IDataObject *data, DWORD, POINTL,
                                   DWORD *effect) override
    {
        const bool acceptable = accepts(data);
        m_acceptable = false;
        applyEffect(effect, acceptable);
        if (!acceptable)
            return S_OK;

        const QStringList paths = pathsFromDataObject(data);
        if (paths.isEmpty())
            return S_OK;

        // Drop 返回后才落盘/打开：写磁盘或弹未保存确认都会卡住 OLE 拖放循环
        const auto perform = m_callbacks.perform;
        if (perform)
            QTimer::singleShot(0, [perform, paths]() { perform(paths); });
        return S_OK;
    }

private:
    bool accepts(IDataObject *data) const
    {
        if (!m_callbacks.canAccept)
            return false;
        const QStringList paths = pathsFromDataObject(data);
        return !paths.isEmpty() && m_callbacks.canAccept(paths);
    }

    void applyEffect(DWORD *effect, bool acceptable) const
    {
        if (effect)
            *effect = acceptable ? DROPEFFECT_COPY : DROPEFFECT_NONE;
    }

    MoteDropCallbacks m_callbacks;
    bool m_acceptable = false;
};

QString hrString(HRESULT hr)
{
    return QStringLiteral("0x%1").arg(static_cast<quint32>(hr), 8, 16, QLatin1Char('0'));
}

} // namespace

void *moteDropRegister(void *hwnd, const MoteDropCallbacks &callbacks, QString *error)
{
    if (!hwnd) {
        if (error)
            *error = QStringLiteral("宿主窗口句柄为空");
        return nullptr;
    }

    // OLE 拖放要求 STA。Qt 主线程通常已初始化过 OLE；没初始化时这里补一次，
    // 已处于 MTA 则直接放弃，保留 WebView2 自带拖放与页面 drop 事件兜底。
    APTTYPE type = APTTYPE_CURRENT;
    APTTYPEQUALIFIER qualifier = APTTYPEQUALIFIER_NONE;
    const HRESULT apartment = CoGetApartmentType(&type, &qualifier);
    if (apartment == CO_E_NOTINITIALIZED) {
        const HRESULT initialized = OleInitialize(nullptr);
        if (FAILED(initialized)) {
            if (error)
                *error = QStringLiteral("OleInitialize 失败 %1").arg(hrString(initialized));
            return nullptr;
        }
    } else if (apartment == S_OK && type != APTTYPE_STA && type != APTTYPE_MAINSTA) {
        if (error)
            *error = QStringLiteral("当前线程不是 STA 套间（类型 %1）").arg(static_cast<int>(type));
        return nullptr;
    }

    auto *target = new DropTarget(callbacks);
    const HRESULT registered = RegisterDragDrop(static_cast<HWND>(hwnd), target);
    if (FAILED(registered)) {
        if (qEnvironmentVariableIsSet("MOTE_KEYLOG")) {
            std::fprintf(stderr, "WIN RegisterDragDrop failed 0x%08lx (apartment type %d)\n",
                         static_cast<unsigned long>(registered), static_cast<int>(type));
        }
        if (error)
            *error = QStringLiteral("RegisterDragDrop 失败 %1").arg(hrString(registered));
        target->Release();
        return nullptr;
    }
    // 引用计数 1 由调用方持有；RegisterDragDrop 自己另持一份
    return target;
}

void moteDropRevoke(void *hwnd, void *target)
{
    if (hwnd)
        RevokeDragDrop(static_cast<HWND>(hwnd));
    if (target)
        static_cast<IDropTarget *>(target)->Release();
}

void *moteDropCreate(const MoteDropCallbacks &callbacks)
{
    return static_cast<IDropTarget *>(new DropTarget(callbacks));
}

void moteDropDestroy(void *target)
{
    if (target)
        static_cast<IDropTarget *>(target)->Release();
}
