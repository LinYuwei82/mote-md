# 阶段 B 设计稿：Windows 去 Qt（原生薄外壳 + WebView2）

前置：阶段 A 已把 macOS 换成 AppKit 薄外壳，页面协议、菜单表、图片落盘与脏标记收敛到无 Qt 的 `core/`。本稿只讨论 Windows，macOS 与 `main` 发布链路不动。

## 1. 目标

- Windows 产物不再链接 Qt，与 macOS 共用 `core/`、`resources/web/` 与同一套页面消息协议
- 保留 0.3.4 的全部行为：编辑、打开/保存、未保存确认、拖放、目录/源码/缩放、PDF/HTML 导出、状态栏
- 产物只依赖系统 WebView2 Evergreen Runtime，不分发浏览器内核
- 构建与 macOS 一样用 CMake，版本号仍以 `Mote.pro` 的 `VERSION` 为唯一来源

**非目标**：重写编辑器前端、改视觉设计、动 macOS 代码、支持 Windows 7、去掉 WebView2 依赖、统一安装器品牌。

## 2. 现状盘点

| 部分 | 事实 |
|---|---|
| Qt 外壳 | `src/webwindow.cpp` 约 1050 行：菜单、状态栏、对话框、文档状态、拖放、PDF/HTML 导出入口 |
| 编辑器抽象 | `src/webview.h`：16 个纯虚方法、14 个信号；`QWidget` 派生，参数用 `QString/QUrl` |
| 共享行为 | `src/webviewbase.cpp`：消息分发、ready 前缓存、图片落盘、目录重载、剪贴板命令 |
| Windows 实现 | `src/webview_win.cpp` 约 1470 行 + `webview_win_drop.cpp`：WebView2 初始化、桥脚本、分片注入、PrintToPdf、OLE 拖放 |
| 构建 | `Mote.pro`：`VERSION = 0.3.4`；win32 块链接 `ole32/uuid/shell32`，SDK 走 `WEBVIEW2_SDK`（默认 `C:/dev/webview2sdk/pkg`，NuGet 1.0.2903.40），拷贝 `WebView2Loader.dll` |
| 打包 | `packaging/package_windows.bat`：`windeployqt` 后压 `dist/Mote-Windows.zip`；Qt 翻译单独拷贝；`resources/win/app.rc` 版本需手工同步 |
| 可复用 | WebView2 桥脚本、消息处理、分片注入、PrintToPdf 设置、OLE 拖放解析都能直接搬到新外壳 |

## 3. 方案对比

| 方案 | 做法 | 包体 | 风险 | 结论 |
|---|---|---|---|---|
| A. Win32/C++ 薄外壳 | 新 `platform/win/`，消息/菜单接 `core/` | 约 1–2 MB exe + Loader，无 Qt DLL | Win32 UI 与 IME 细节 | **推荐** |
| B. Qt 外壳接 core | 保留 Qt，只替换协议层 | 仍带 Qt DLL，约 40 MB+ | 低 | 只作为过渡对照，不解决包体 |
| C. WPF/WinUI + WebView2 | .NET 外壳，core 走 C ABI | 需 .NET 运行时或自包含数十 MB | 跨语言边界、构建链 | 不推荐 |

选 A：与 macOS 结构对称，`core/` 直接复用，Windows 只需补 Win32 落地层。

## 4. 目标结构

```
core/                          # 两端共用，阶段 A 已就绪
platform/mac/                  # 现有，不改
platform/win/
  main.cpp                     # WinMain、消息循环、COM 初始化
  main_window.h/.cpp           # 窗口、文档状态、打开/保存/确认、标题
  menus.h/.cpp                 # core 命令表 → HMENU + 加速键
  dialogs.h/.cpp               # IFileOpenDialog / IFileSaveDialog / TaskDialog
  web_host_view.h/.cpp         # WebView2 宿主、页面模板、消息桥、字体内联
  drop_target.h/.cpp           # OLE 拖放（搬 webview_win_drop.cpp）
  pdf_export.h/.cpp            # PrintToPdf（搬现有 A4 设置）
  html_export.h/.cpp           # 本地图片 → data URI
  app.rc.in                    # 版本与图标由 CMake 生成
native/CMakeLists.txt          # if(APPLE) / elseif(WIN32) 两套 target
```

`native/` 继续作为唯一构建入口：macOS 产 `Mote.app`，Windows 产 `Mote.exe`。两端共用 `mote_core` 与资源拷贝规则。

## 5. core 需要的少量调整

1. **快捷键语义**：命令表里 `cmd+…` 表示「主修饰键」。Windows 解析时把 `cmd` 映射为 `Ctrl`，`option` 映射为 `Alt`；表本身不改。需在 `command_table.h` 注释写清，并在 Windows 菜单/加速键解析处单点实现。
2. **平台类名**：`js::enableStatusBar()` 现在固定加 `platform-mac`。改为 `enableStatusBar("mac"|"win")`，CSS 增加 `body.platform-win` 的对应规则（与 `platform-mac` 共用样式，只是类名不同）。
3. **路径**：`paths.cpp` 已把 `C:\` 转成 `file:///C:/`，需补 Windows 风格单测（`C:\docs\a.md`、含空格的目录）。
4. **不变的部分**：JSON 协议、`EditorController` 状态机、图片落盘、脏标记、菜单表、`js_bridge` 全部原样复用。

## 6. 平台落地要点

| 能力 | 实现 |
|---|---|
| 页面加载 | 临时页面写到文档目录（或 `%TEMP%\MoteNative`），`CoreWebView2::Navigate` 到 `file://`；保留现有桥脚本把 `chrome.webview` 映射到 `window.webkit.messageHandlers.mote` |
| 正文注入 | 沿用现有「单条 ExecuteScript + 分片回落」双通道，回执仍是 `'ok'` |
| 菜单 | `CreateMenu/CreatePopupMenu`，命令 ID 直接用 `CommandId`；`WM_COMMAND` 转 `performCommand` |
| 快捷键 | 命令表 → `HACCEL` 与原生菜单；WebView2 在消息循环前截获编辑区按键，因此 `AcceleratorKeyPressed` 负责把「虚拟键 + 修饰键」映射回命令表并 `perform_command`（与 `TranslateAccelerator` 同源，`cmd→Ctrl`）。`Ctrl+V` 在此先问图片剪贴板 |
| 打开/保存 | `IFileOpenDialog` / `IFileSaveDialog`（`FOS_FORCEFILESYSTEM`），UTF-8 读写，原子替换用 `ReplaceFile` |
| 未保存确认 | `TaskDialogIndirect`：保存 / 不保存 / 取消；`MOTE_ANSWER` 可跳过 |
| 拖放 | 搬 `webview_win_drop.cpp` 的 `CF_HDROP` 解析与 `RegisterDragDrop`，判定/处理仍调 `EditorController` |
| 剪贴板 | `CF_UNICODETEXT` + `HTML Format`（带 `Version:0.9` 头的偏移写入），对应 core 的 `setClipboard(text, html)` |
| 主题 | 读 `HKCU\...\Themes\Personalize\AppsUseLightTheme` 决定 light/dark，订阅 `WM_SETTINGCHANGE` |
| 状态栏 | 前端 `#statusbar`，`body.platform-win` 启用，Win32 不画状态栏 |
| PDF | `ICoreWebView2_7::PrintToPdf`：A4 纵向、18/20 mm 边距、打印背景、无页眉页脚（沿用现有设置）；先 `pdfBegin()` 再打印，完成/失败都 `pdfEnd()` |
| HTML | 复用前端 `exportHtml`，`html_export` 把相对图片读盘换成 `data:` URI，缺失计数进提示 |
| 字体 | 与 mac 一致，base64 内联 JetBrains Mono，避免文档目录 baseURL 找不到 bundle 字体 |
| 诊断 | `MOTE_KEYLOG` / `MOTE_EVAL` / `MOTE_SNAPSHOT` / `MOTE_DROP` / `MOTE_COMMAND` / `MOTE_ANSWER` / `MOTE_SAVE_AS` / `MOTE_EXPORT_AS` / `MOTE_PDF_AS` 与 mac 同名同义；GUI 子系统没有 stderr，日志写 `MOTE_LOG` 指定文件，默认 `OutputDebugString` |

## 7. 构建与打包

- **工具链**：CMake + MSVC 2022 x64（与现有 Qt `msvc2022_64` 一致）。不支持 MinGW：WebView2 的 COM 头与 Loader 以 MSVC 为准。
- **SDK**：继续用环境变量 `WEBVIEW2_SDK`，默认 `C:/dev/webview2sdk/pkg`；CMake 找不到时明确报错。
- **运行时**：启动时 `GetAvailableCoreWebView2BrowserVersionString` 检测；缺失则弹窗并给出 Evergreen Runtime 下载地址，不随包分发内核。
- **版本**：CMake 从 `Mote.pro` 读 `VERSION`，生成 `app.rc`（图标、`FileVersion`、`ProductVersion`），去掉手工同步。
- **产物**：`dist/Mote-Windows/`：`Mote.exe`、`WebView2Loader.dll`、`web/`、`fonts/`、`samples/`、`licenses/`；同名 zip。已按默认产物发布（不再带 `-native` 后缀）；Qt 路径保留为回退，并存时给原生脚本传 `-OutName Mote-Windows-native`。
- **自检**：新增 `packaging/package_windows_native.ps1` 或扩展现有 bat：检查产物目录无 `Qt6*.dll`、无 `platforms/qwindows.dll`；`dumpbin /dependents` 只允许系统 DLL + `WebView2Loader.dll`。

## 8. 里程碑

状态列以 `docs/thin-shell-stage-b-acceptance.md` 的实测记录为准（2026-11-14）。

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| N0 | CMake 多平台、WinMain、WebView2 初始化、空白窗口 | 构建通过；`dumpbin` 无 Qt；能渲染示例 Markdown | 完成 |
| N1 | 接 `EditorController`：消息桥、打开/保存/未保存确认、标题脏标记 | 与 mac 同一套 core 单测；手工打开/保存/另存为 | 完成 |
| N2 | 菜单命令表 → HMENU、快捷键、编辑/格式/视图命令 | 33 个命令逐项可用；`Cmd→Ctrl` 映射正确；无重复触发 | 完成（快捷键分发在 N6 冒烟中修正，见 8.2） |
| N3 | 拖放、剪贴板、链接、主题、状态栏 | 拖 `.md` 打开、拖图片落盘、复制剪切粘贴、深色切换 | 完成 |
| N4 | PDF/HTML 导出 | A4 单页/多页无裁切；HTML 图片内联；失败路径还原页面 | 完成（PDF 只验页数/体积/文字层，未逐页比对） |
| N5 | 打包、自检、截图基线 | zip 体积、无 Qt 依赖、固定样例页数/截图与 mac 对照 | 完成（mac 对照未做） |
| N6 | 可交付验收与回归、默认产物切换 | 功能矩阵复跑、验收记录、原子保存、`MOTE_DROP` | 完成（缺口见 8.1） |

### 8.1 当前状态（2026-11-14）

**已完成**：N0–N6 全部落地，Windows 默认发布包为原生产物（`dist/Mote-Windows`，Qt 脚本保留回退）。原子保存（`ReplaceFile`）、`MOTE_DROP` 端到端、中文 Unicode 输入、1.5 MB 文档加载、PDF/HTML 导出、剪贴板图片（保留 alpha）、快照基线、命令表全部快捷键（含 `Ctrl+Shift+S`、`Ctrl+Alt+E`）均实机通过。

**部分完成**：

- IME 组词/候选窗未验：本机只有 US 键盘布局，无法自动化；IME 最终提交走的 Unicode 路径已实测。

**未闭合**：

- mac 截图对照：需 mac 机按 `PACKAGING.md` 6.2 的命令产出基线后比对。
- PDF 跨平台逐页像素比对：两引擎分页切点不同，目前只验页数/体积/文字层。
- 干净机验证：无 VS/Qt 的机器解压即用、缺 WebView2 Runtime 的提示，尚未在真实干净机跑过。

### 8.2 冒烟中发现并修复的问题

1. **外壳快捷键整体失效**：WebView2 在消息循环之前截获键盘，`TranslateAccelerator` 只对原生菜单生效，编辑区聚焦时 `Ctrl+P`、`Ctrl+/`、`Ctrl+Shift+L/D` 全部无反应。修法：`AcceleratorKeyPressed` 统一走 `mote::win::command_for_shortcut`（与加速键表同源、跳过 WebView2 原生编辑命令）→ `perform_command`；`Ctrl+V` 仍先走图片剪贴板。同时设 `ICoreWebView2Settings3::put_AreBrowserAcceleratorKeysEnabled(FALSE)`，避免 Chromium 内置浏览器快捷键抢键。
2. **诊断缺口**：`MOTE_KEYLOG` 增加 `NATIVE key vk=<虚拟键> mods=<修饰键位掩码>`，用于区分「外壳没收到」与「收到了但没匹配」。
3. **两条 Shift/Alt 组合键被浏览器层消费**：`Ctrl+Shift+S`、`Ctrl+Alt+E` 连 `AcceleratorKeyPressed` 都收不到。修法：进程内低级键盘钩子（`WH_KEYBOARD_LL`，仅前台为本窗口时生效）用 `command_for_shortcut` 匹配后 `PostMessage` 回窗口线程执行，键位不变、mac 侧与共享 `resources/web/editor.js` 均未改动。实测 `vk=83 mods=12 → 另存为`、`vk=69 mods=24 → 导出 HTML`，其余快捷键回归通过。

## 9. 风险与回退

- **输入法/IME**：WebView2 自身处理 IME，但 Win32 窗口需正确转发 `WM_IME_*`；N1 起用中文输入法实测。
- **快捷键冲突**：`Alt` 菜单键、`Ctrl+Z/Y`、`Ctrl+Shift+Z` 与页面按键可能双触发；`AcceleratorKeyPressed` 统一按命令表分发后双触发已消除，Chromium 层先消费的两条组合键由键盘钩子兜底（见 8.2）。
- **PDF 差异**：PrintToPdf 的分页由引擎决定，与 mac 的切点排页不同；用同一长文档比对页数与首末页截图，差异写进验收记录。
- **WebView2 版本**：`PrintToPdf` 需要 Runtime 108+；低于此版本明确报错。
- **回退**：新外壳只存在于 `platform/win/` 与 CMake 的 WIN32 分支；Qt Windows 构建与 `package_windows.bat` 保持可用，删分支即可回退。

## 10. 验收标准

- `dumpbin /dependents Mote.exe` 无任何 Qt DLL，仅系统库 + `WebView2Loader.dll` —— 已满足
- exe + Loader 总体积目标 ≤ 3 MB；zip ≤ 2 MB —— 已满足（exe 635 KB / loader 166 KB / zip 609 KB）
- 功能矩阵（编辑/文件/视图/格式/导出/拖放/剪贴板）逐项与 0.3.4 Windows 版一致 —— 除 8.1 列出的两键外已实测通过
- core 单测在 Windows 上通过（含路径与图片落盘）—— 已满足
- `MOTE_SNAPSHOT` 与 mac 同文档截图对照：正文排版一致，状态栏类名不同但样式一致 —— 未完成（需 mac 机）
