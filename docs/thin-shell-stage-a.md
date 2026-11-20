# 阶段 A 设计稿：macOS 原生薄外壳（Windows 暂留 Qt）

## 1. 目标

- macOS 端去掉 Qt：`Mote.app` 从 49MB 降到约 2MB，DMG 从 24MB 降到约 1.5MB
- Windows 端保持现状（Qt + WebView2），不阻塞、不回退
- 前端 `editor.html/css/js` 完全复用，两端仍共用同一份字节
- 行为与 0.3.4 对齐：打开/保存/未保存确认、块编辑、目录、语言选择器、PDF、拖放、剪贴板、深浅色

**非目标**：Windows 去 Qt（阶段 B）、重写编辑器、改视觉设计、支持 Intel Mac。

## 2. 分支与共存

- 新分支 `native-shell`，从 `main`（`4d6fd9a`）切出；`main` 不动
- 仓库内两套构建共存：
  - `Mote.pro`：现有 Qt 构建，继续服务 Windows
  - `MoteNative.xcodeproj` 或 `native/CMakeLists.txt`：macOS 原生构建
- 前端资源只有一份，两个构建都从 `resources/` 读；版本号仍以 `Mote.pro` 的 `VERSION` 为唯一来源，原生构建读取同一行
- 旧 Qt 文本引擎（`mainwindow/previewview/codehighlighter`）只留在 Qt 构建里，原生构建不编译

## 3. 目标结构

```
core/                     无 Qt、无平台 API，两个构建共享
  editor_controller.*     文档状态、脏标记、保存流程、消息分发
  message_router.*        JSON 协议 → 动作
  image_store.*           图片落盘（assets/、重名 -2/-3）
  command_table.*         菜单命令表（id / 标题 / 快捷键 / 启用条件）
  export_*.{h,cpp}        PDF/HTML 导出调度（平台实现注入）
  paths.*                 文档目录、临时页面路径
shell/mac/               ObjC++ 外壳，只有它碰 AppKit
  main.mm                 NSApplication 启动
  app_delegate.mm         生命周期、菜单安装、单实例
  main_window.mm          NSWindow、标题/脏标记、状态栏容器
  web_host_view.mm        WKWebView 宿主 + JS 消息桥 + 临时页面加载
  menus.mm                CommandTable → NSMenu
  dialogs.mm              NSOpenPanel / NSSavePanel / NSAlert
  clipboard.mm            NSPasteboard
  drag_drop.mm            NSDraggingDestination
  pdf_export.mm           抓取 + 分页 + CGPDF 拼接（从 macwebview.mm 迁）
resources/web/            不改
```

Qt 构建下由 `src/webwindow.cpp` 继续充当外壳；`core/` 先以「两边都能编」为目标，Qt 外壳逐步改为调用 `core/`，避免同一逻辑两份。

## 4. 无 Qt 接口

### 4.1 平台服务（每端实现一次）

```cpp
struct SaveChoice { enum Value { Save, Discard, Cancel } value; };

class Platform {
public:
    virtual std::string openFileDialog() = 0;                  // 空串=取消
    virtual std::string saveFileDialog(const std::string &suggested,
                                       const std::string &ext) = 0;
    virtual SaveChoice confirmUnsaved(const std::string &name) = 0;
    virtual void alert(const std::string &title, const std::string &message) = 0;
    virtual void setWindowTitle(const std::string &name, bool dirty) = 0;
    virtual void setStatus(const std::string &text) = 0;
    virtual bool openExternal(const std::string &url) = 0;
    virtual std::string clipboardText() = 0;
    virtual void setClipboard(const std::string &text,
                              const std::string &html) = 0;
    virtual std::string appDataDir() = 0;
};
```

### 4.2 编辑器视图（每端实现一次）

```cpp
class EditorView {
public:
    virtual void setMarkdown(std::string_view text, std::string_view baseDir) = 0;
    virtual void newDocument() = 0;
    virtual void setBaseDir(std::string_view dir) = 0;
    virtual void requestSnapshot() = 0;
    virtual void notifySaved(std::string_view text) = 0;
    virtual void undo() = 0;
    virtual void redo() = 0;
    virtual void clipboardCommand(std::string_view command) = 0;
    virtual void toggleToc() = 0;
    virtual void toggleSource() = 0;
    virtual void zoomBy(int steps) = 0;
    virtual void resetZoom() = 0;
    virtual void setTheme(std::string_view mode) = 0;
    virtual void applyFormat(std::string_view action) = 0;
    virtual void requestExportHtml(std::string_view title) = 0;
    virtual void requestExportPdf(std::string_view path) = 0;
};
```

方法集与现有 [webview.h](file:///Users/lin/Projects/mote/src/webview.h) 一一对应，只把 `QString/QUrl` 换成 `std::string`、信号换成 `std::function` 回调（`ready / dirtyChanged / statsChanged / saveRequested / openRequested / exportHtmlReady / pdfExportFinished / ...`）。

### 4.3 关键不变量（迁移时必须保留）

1. **页面代次**：每次加载页面自增，`ready` 带回代次，旧代次消息丢弃
2. **就绪前缓存**：`setMarkdown` 早于 `ready` 时先存 pending，`ready` 后 flush
3. **临时页面**：内联 HTML 写到文档同目录隐藏文件，`loadFileURL` 加载；不能改成 `loadHTMLString`
4. **脏标记口径**：以「最近一次保存的文本」比较，撤销回保存点时脏标记消失
5. **复制/剪切/粘贴**：页面算内容，原生写/读系统剪贴板

## 5. macOS 外壳设计

- `main.mm`：`NSApplication` + `AppDelegate`；`applicationShouldTerminateAfterLastWindowClosed` 返回 YES
- `MainWindow`：`NSWindow` + 自定义 `contentView`；标题区显示文件名与脏标记（`window.documentEdited`）
- 菜单：`CommandTable` 生成，`Cmd` 修饰；撤销/重做**仍用 `NSEvent` local monitor 分流**，不依赖菜单响应链
- `WebHostView`：`NSView` 子类，内部 `WKWebView`；`WKScriptMessageHandler` 收 JSON → `MessageRouter`
- 文件：`NSOpenPanel`（仅 `.md`/文本）、`NSSavePanel`；未保存用 `NSAlert` 三按钮，按钮文案「保存 / 不保存 / 取消」
- 拖放：`registerForDraggedTypes:@[NSFilenamesPboardType, NSPasteboardTypeFileURL]`，复用 `moteIsMarkdownPath/ImagePath`
- 状态栏：**移入前端**（`#statusbar`），保证与 Windows 像素一致；`MainWindow` 不再画
- PDF：直接迁移 `macwebview.mm` 的 `pdfBegin/pdfPlanPages/pdfChunks` 与 CGPDF 拼接，去掉 Qt 类型

## 6. 复用清单

| 现有文件 | 处理 |
|---|---|
| `macwebview.mm`（825 行） | WKWebView 配置、消息桥、按键 monitor、PDF 抓取与拼页 → 迁到 `shell/mac/`，约 60–70% 逻辑保留 |
| `webviewbase.cpp`（520 行） | 消息分发、图片落盘、拖放判定 → 改写成 `core/`，去掉 QString/QFile/QDir/QJson |
| `webwindow.cpp`（1053 行） | 仅保留流程参考；菜单/对话框/导出选择器全部重写为 AppKit |
| `main.cpp`（79 行） | 入口与字体加载重写；字体改由 CSS `@font-face` 指向包内字体 |
| `editor.*` | 不改；新增 `platform-mac` class 与 `#statusbar` 迁移 |

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 分支、原生构建骨架、静态页面 | `otool -L` 无 Qt；启动显示页面 |
| M1 | `core/` 去 Qt，消息路由 + 图片落盘 | 无窗口 CLI 单测覆盖消息分发、重名落盘、脏标记 |
| M2 | 窗口、菜单、打开/保存、未保存确认、标题脏标记 | 打开 → 编辑 → 保存字节一致；关窗三按钮正确 |
| M3 | WebView 宿主、临时页面、拖放、剪贴板、目录/源码/缩放 | 与 0.3.4 行为逐项对照；`MOTE_EVAL` 钩子可复用 |
| M4 | PDF/HTML 导出、打印清理、状态栏前端化 | 800 段文档 A4 多页、无截断、纸面无 UI |
| M5 | 打包 DMG、依赖自检、截图基线、发布 0.4.0 | DMG ≤ 2MB；截图与 Qt 版逐像素比对（内容区） |

每个里程碑单独提交，`native-shell` 分支上不发布中间版本。

## 8. 风险与回退

| 风险 | 应对 |
|---|---|
| 菜单快捷键再踩坑 | 直接移植现有 `NSEvent` 分流逻辑与 `MOTE_KEYLOG` 键位表 |
| 临时页面/权限回归 | 保留 `loadFileURL` + 页面代次；用现有 `MOTE_EVAL` 回归图片显示 |
| PDF 分页回归 | 迁移现有算法，不重写；以 401/800 段样本比对页数与文本 |
| 字体差异 | 代码字体包内自带；正文中文仍用 PingFang，截图基线容忍字形差异 |
| 双构建漂移 | 前端单份、命令表单份、版本号单份；CI 两端各跑一次冒烟 |
| 中途失败 | 原生构建只在新分支；`main` 不受影响，随时放弃 |

## 9. 不做的事

- 不自绘窗口 chrome、不改 macOS 全局菜单栏形态
- 不为原生构建维护第二份 CSS 或第二套命令表
- 不在阶段 A 改 Windows
- 不重写编辑器的解析/渲染/撤销
