#ifndef WEBVIEW_WIN_DROP_H
#define WEBVIEW_WIN_DROP_H

#include <QStringList>

#include <functional>

// Windows OLE 拖放目标（IDropTarget）的独立实现。
// 只通过回调把「能否接受」与「落盘/打开」交给宿主，不依赖 WebView2 与 Qt 窗口，
// 因此可以单独构造 IDataObject 做接口级自测。
// COM 类型不出现在头文件里，窗口/对象句柄一律用 void*。
struct MoteDropCallbacks
{
    // 判断拖入的文件里有没有可处理的（.md / 图片）
    std::function<bool(const QStringList &)> canAccept;
    // 真正处理拖入的文件；在事件循环的下一轮执行，避免阻塞 OLE 拖放循环
    std::function<void(const QStringList &)> perform;
};

// 在 hwnd 上注册拖放目标，成功返回目标对象（交给 moteDropRevoke），失败返回 nullptr。
// error 可为 nullptr；失败时写入可直接展示给用户的原因（公寓类型 / HRESULT），
// 宿主据此在界面上提示「系统级拖放没挂上」，而不是只在 stderr 留痕。
void *moteDropRegister(void *hwnd, const MoteDropCallbacks &callbacks,
                       QString *error = nullptr);
void moteDropRevoke(void *hwnd, void *target);

// 不注册到窗口，只创建目标对象（接口级测试用）
void *moteDropCreate(const MoteDropCallbacks &callbacks);
void moteDropDestroy(void *target);

#endif // WEBVIEW_WIN_DROP_H
