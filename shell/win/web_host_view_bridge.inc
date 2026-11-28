using GetVersionFn = HRESULT(STDMETHODCALLTYPE *)(PCWSTR, LPWSTR *);
using CreateEnvironmentFn = HRESULT(STDMETHODCALLTYPE *)(
    PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);

// 页面只认 window.webkit.messageHandlers.mote，这里把 WebView2 的 postMessage 接过去。
// 必须在导航前用 AddScriptToExecuteOnDocumentCreated 注入，页面初始化就能发消息。
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
  // 大文档注入通道：宿主 PostWebMessageAsJson 不占 ExecuteScript 的体积额度
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', function (event) {
      var data = event.data;
      if (data && data.__mote === 'setMarkdown' && window.mote)
        window.mote.setMarkdown(data.text);
    });
  }
})();
)JS";

using win_encoding::utf8_to_wide;
using win_encoding::wide_to_utf8;

// 单条脚本与单条消息的体积预算：WebView2 在 2MB 量级封顶，
// 各留一半余量给 JSON 转义与 UTF-8 膨胀（中文每字符 3 字节）。
constexpr std::size_t kScriptBudget = 512 * 1024;
constexpr std::size_t kMessageBudget = 1536 * 1024;

