#include "drop_target.h"

#include "env.h"

#include <objbase.h>
#include <shellapi.h>

#include <atomic>
#include <cstdio>
#include <cwchar>
#include <cstdlib>
#include <utility>

namespace mote::win {

namespace {

std::string wide_to_utf8(const std::wstring &text)
{
    if (text.empty())
        return std::string();
    const int length = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                           static_cast<int>(text.size()), nullptr, 0,
                                           nullptr, nullptr);
    std::string narrow(static_cast<size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        narrow.data(), length, nullptr, nullptr);
    return narrow;
}

std::vector<std::string> paths_from_data(IDataObject *data)
{
    std::vector<std::string> paths;
    if (!data)
        return paths;

    FORMATETC format = { CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL };
    STGMEDIUM medium = {};
    if (FAILED(data->GetData(&format, &medium)) || !medium.hGlobal)
        return paths;

    auto drop = static_cast<HDROP>(GlobalLock(medium.hGlobal));
    if (drop) {
        const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
        for (UINT index = 0; index < count; ++index) {
            const UINT length = DragQueryFileW(drop, index, nullptr, 0);
            if (length == 0)
                continue;
            std::wstring buffer(length + 1, L'\0');
            if (DragQueryFileW(drop, index, buffer.data(), length + 1) > 0)
                paths.push_back(wide_to_utf8(buffer.c_str()));
        }
        GlobalUnlock(medium.hGlobal);
    }
    ReleaseStgMedium(&medium);
    return paths;
}

std::string hr_string(HRESULT hr)
{
    char text[16] = {};
    std::snprintf(text, sizeof(text), "0x%08lx", static_cast<unsigned long>(hr));
    return std::string(text);
}

struct DropWindowSearch {
    HWND render = nullptr;
    HWND widget = nullptr;
};

BOOL CALLBACK drop_window_proc(HWND hwnd, LPARAM param)
{
    auto *search = reinterpret_cast<DropWindowSearch *>(param);
    wchar_t name[64] = {};
    if (GetClassNameW(hwnd, name, 64) <= 0)
        return TRUE;

    if (std::wcscmp(name, L"Chrome_RenderWidgetHostHWND") == 0) {
        if (!search->render || (!IsWindowVisible(search->render) && IsWindowVisible(hwnd)))
            search->render = hwnd;
    } else if (std::wcscmp(name, L"Chrome_WidgetWin_1") == 0) {
        if (!search->widget || (!IsWindowVisible(search->widget) && IsWindowVisible(hwnd)))
            search->widget = hwnd;
    }
    return TRUE;
}

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
    std::atomic<ULONG> m_ref{ 1 };
};

class DropTarget final
    : public RefCounted
    , public IDropTarget
{
public:
    DropTarget(HWND window, DropCallbacks callbacks)
        : window_(window)
        , callbacks_(std::move(callbacks))
    {
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override
    {
        if (!out)
            return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IDropTarget) {
            *out = static_cast<IDropTarget *>(this);
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return RefCounted::AddRef(); }
    ULONG STDMETHODCALLTYPE Release() override { return RefCounted::Release(); }

    HRESULT STDMETHODCALLTYPE DragEnter(IDataObject *data, DWORD, POINTL,
                                        DWORD *effect) override
    {
        acceptable_ = accepts(data);
        apply_effect(effect);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragOver(DWORD, POINTL, DWORD *effect) override
    {
        apply_effect(effect);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragLeave() override
    {
        acceptable_ = false;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Drop(IDataObject *data, DWORD, POINTL, DWORD *effect) override
    {
        const bool acceptable = accepts(data);
        apply_effect(effect);
        acceptable_ = false;
        if (!acceptable)
            return S_OK;

        std::vector<std::string> paths = paths_from_data(data);
        if (paths.empty())
            return S_OK;

        // 交回主窗口的消息循环处理：这里弹对话框会卡住 OLE 拖放。
        // 注册目标是 WebView2 子窗口，WM_APP 必须发给根窗口才能被主窗口收到。
        HWND notify = GetAncestor(window_, GA_ROOT);
        if (!notify)
            notify = window_;
        auto *payload = new std::vector<std::string>(std::move(paths));
        if (!PostMessageW(notify, kDropMessage, 0, reinterpret_cast<LPARAM>(payload)))
            delete payload;
        return S_OK;
    }

private:
    bool accepts(IDataObject *data) const
    {
        if (!callbacks_.can_accept)
            return false;
        const std::vector<std::string> paths = paths_from_data(data);
        return !paths.empty() && callbacks_.can_accept(paths);
    }

    void apply_effect(DWORD *effect) const
    {
        if (effect)
            *effect = acceptable_ ? DROPEFFECT_COPY : DROPEFFECT_NONE;
    }

    HWND window_ = nullptr;
    DropCallbacks callbacks_;
    bool acceptable_ = false;
};

} // namespace

HWND find_drop_window(HWND host)
{
    if (!host || !IsWindow(host))
        return nullptr;
    DropWindowSearch search;
    EnumChildWindows(host, drop_window_proc, reinterpret_cast<LPARAM>(&search));
    return search.render ? search.render : search.widget;
}

void *register_drop_target(HWND hwnd, DropCallbacks callbacks, std::string *error)
{
    if (!hwnd) {
        if (error)
            *error = "宿主窗口句柄为空";
        return nullptr;
    }

    // OLE 拖放要求本线程调用过 OleInitialize；仅 CoInitializeEx 不够，
    // 否则 RegisterDragDrop 会返回 E_OUTOFMEMORY。已初始化时返回 S_FALSE，无副作用。
    APTTYPE type = APTTYPE_CURRENT;
    APTTYPEQUALIFIER qualifier = APTTYPEQUALIFIER_NONE;
    const HRESULT apartment = CoGetApartmentType(&type, &qualifier);
    if (apartment == S_OK && type != APTTYPE_STA && type != APTTYPE_MAINSTA) {
        if (error)
            *error = "当前线程不是 STA 套间（类型 " + std::to_string(static_cast<int>(type))
                + "）";
        return nullptr;
    }
    const HRESULT initialized = OleInitialize(nullptr);
    if (FAILED(initialized)) {
        if (error)
            *error = "OleInitialize 失败 " + hr_string(initialized);
        return nullptr;
    }

    auto *target = new DropTarget(hwnd, std::move(callbacks));
    HRESULT registered = RegisterDragDrop(hwnd, target);
    if (registered == DRAGDROP_E_ALREADYREGISTERED) {
        // Chromium 会先给渲染子窗口注册自己的 IDropTarget，把文件拖放吃掉
        // （表现为拖进来毫无反应）。AllowExternalDrop=false 只能拦住它新建
        // 目标，拦不住已经存在的；这里显式换成本进程的目标。
        RevokeDragDrop(hwnd);
        registered = RegisterDragDrop(hwnd, target);
    }
    if (FAILED(registered)) {
        if (!env_value("MOTE_KEYLOG").empty())
            std::fprintf(stderr, "WIN RegisterDragDrop failed %s\n",
                         hr_string(registered).c_str());
        if (error)
            *error = "RegisterDragDrop 失败 " + hr_string(registered);
        target->Release();
        return nullptr;
    }
    // 返回调整后的 IDropTarget*：多重继承下 void* 再 static_cast 不会做 this 偏移
    return static_cast<IDropTarget *>(target);
}

void revoke_drop_target(HWND hwnd, void *target)
{
    if (hwnd)
        RevokeDragDrop(hwnd);
    if (target)
        static_cast<IDropTarget *>(target)->Release();
}

} // namespace mote::win
