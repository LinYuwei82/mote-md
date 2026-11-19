# Mote 复刻技术方案（交给 AI 的重建手册）

> 目的：让另一个 AI 在不重复试错的前提下，按本文件重建 Mote 这个项目。
> 结论先行：**外壳是原生实现（macOS：AppKit + WKWebView；Windows：Win32 + WebView2），正文交给系统 WebView；前端是零依赖的原生 JS，靠一套「块模型 + 零位移标记」维持所见即所得；PDF 与复制等平台能力全部回到原生侧实现，不依赖网页 API。**
>
> 本文件只写有代码或文档依据的结论。标注「未验证」的条目不要当成设计承诺。
>
> **历史说明**：本文件主体写于 Qt 外壳时代。Qt 构建路径（`Mote.pro` + `src/`）已于
> 2026-11-19 删除，文中涉及 qmake / macdeployqt / `src/` 的段落仅作历史参考；
> 当前架构与构建方式以 [技术方案](技术方案.md)、[WEBVIEW-ARCHITECTURE](WEBVIEW-ARCHITECTURE.md)
> 与 `native/CMakeLists.txt` 为准。

**目录**：0 产品定义 · 1 验收线 · 2 选型与硬约束 · 3 文件地图 · 4 块模型 · 5 消息协议 · 6 平台宿主 · 7 PDF · 8 构建打包 · 9 调试验证 · 10 坑清单（P01–P39）· 11 重建路线 · 12 禁止事项 · 13 已知限制 · 14 最小骨架 · 15 打包坑点详解

---

## 0. 一句话产品定义

一个 Markdown 查看 / 编辑器：窗口、菜单、文件读写、打包由原生外壳（macOS：AppKit；Windows：Win32）负责，正文的渲染与编辑交给系统 WebView（macOS：WKWebView，Windows：WebView2），不引入任何前端框架、bundler 或运行时。

核心交互：**正文按空行切块，点击某块就在原位显示该块 Markdown 原文，其余块保持渲染效果；离开即重新渲染。** 这不是整篇切换源码，而是逐块就地编辑。

---

## 1. 成品验收线（重建完成的判据）

按优先级从高到低，前一条不过就不要做后一条：

1. 打开 `.md`，中文、表格、代码块、图片、任务列表渲染正确。
2. 点击任意块 → 原位变成可编辑的 Markdown 原文；点别处 → 变回渲染态，且**块宽高不跳**（零位移）。
3. `Cmd/Ctrl+S` 保存，字节与原文一致；未保存关闭时弹「保存 / 不保存 / 取消」。
4. `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` 能撤销/重做到任意一步编辑，包括改代码块语言。
5. 代码块：语法高亮、行号、语言徽标、复制按钮、语言选择器（搜索 + 键盘 + 自定义语言）。
6. 「文件 → 导出 PDF」得到 A4 多页、无页眉页脚、文字可选中、图片与中文正常的 PDF。
7. 打包产物能在干净机器上双击运行（macOS 需右键打开；Windows 需 Data 目录可写）。

---

## 2. 选型与理由（不要重新论证，直接照抄）

| 决策 | 选择 | 理由 | 被否方案 |
| --- | --- | --- | --- |
| 外壳 | 原生：macOS AppKit + WKWebView、Windows Win32 + WebView2 | 不引入第三方运行时，包体最小（.app 约 4 MB、exe 约 0.6 MB） | Electron（体积 100MB+）、Tauri（Rust 依赖链）、Qt 外壳（包体 40MB 量级，已于 2026-11-19 删除） |
| 正文渲染 | 系统 WebView | 排版、选区、输入法、滚动交给系统内核；HTML/CSS 表达 Markdown 语义最快 | QtWebEngine（+100MB Chromium）、QTextDocument 自绘（旧实现，见 `backup/`，已删除） |
| 前端 | 原生 JS + CSS，无框架、无构建 | 页面只有一个，状态都在 DOM 上；引入框架会带来构建链和版本噪音 | React/Vue + Vite |
| Markdown 解析 | 自写轻量解析（`editor.js`） | 只需要「块级切分 + 行内标记」，第三方库会把标记吃进 DOM，破坏零位移 | marked / markdown-it |
| 语法高亮 | 自写词法扫描（`highlightCode`） | 同上，且要按行号栏与编辑态定制 | highlight.js / Prism |
| 撤销 | 整篇快照 + 绝对偏移 | 语义简单、与输入法/跨块选区不冲突 | 细粒度 diff（在块模型上极易错） |
| PDF | 原生侧抓取 + 自绘分页 | WebKit/WebView2 的现成 PDF 接口都不能直接给 A4 分页 | 网页里 `window.print()`（不可控、会被外壳布局污染） |
| 版本号 | 仓库根 `VERSION.txt` 单一来源 | CMake 构建期注入 `Info.plist` 与 Windows 资源，避免多处手改 | 手写 plist / rc |

**硬约束（改动会连带破坏其它功能，重建时必须当成不变量）：**

1. **零位移**：进入/离开编辑态不改变任何块的宽度与高度；行内标记必须零宽。
2. **`dataset.raw === textContent`**：代码块、表格、分隔线是显式例外（围栏 / `|` / 对齐行不进文本）。
3. **标记不进入选区复制**：复制出去是标准 Markdown，不能带 UI 控件文字。
4. **块几何只在该变的地方变**：插入/转换只影响目标块及其下方块。
5. **撤销以整篇快照为单位**：任何改 `raw` 的新交互都必须走同一条历史入口。

---

## 3. 文件地图（重建时按这个骨架建仓）

```
VERSION.txt               版本号唯一来源（单行 x.y.z）
native/CMakeLists.txt     唯一的构建入口：按平台生成 target，拷贝前端/字体/示例
core/
  json / base64 / paths   协议解析、图片解码、路径与 file:// 目录
  js_bridge               外壳 → 页面的脚本片段
  editor_controller       页面代次、ready 缓存、消息分发、脏标记
  image_store             assets/ 落盘与重名处理
  command_table           菜单唯一来源
  inject_chunks           大文档分片切分（UTF-8 安全）
  update                  更新清单解析、版本比较与升级判定
platform/mac/             AppKit + WKWebView：窗口、菜单、对话框、PDF/HTML、拖放、更新检查
platform/win/             Win32 + WebView2：窗口、菜单、对话框、拖放、PDF/HTML、更新检查
resources/
  web/editor.html         唯一页面骨架（两个占位符）
  web/editor.css          全部样式（含打印与 PDF 清理）
  web/editor.js           解析 + 渲染 + 编辑 + 历史 + 菜单
  fonts/                  JetBrains Mono（Light/Regular/Bold）+ OFL
  icons/ samples/         图标、内置示例
  win/                    Windows 图标资源（app.ico）
packaging/                package_macos.sh / package_windows_native.ps1 / PACKAGING.md
tools/preflight.sh        干净目录构建 + 启动冒烟（macOS）
docs/                     架构、决策、验收、发行说明
```

**页面组装方式**：`editor.html` 只有 `__MOTE_CSS__`、`__MOTE_JS__` 两个占位符。外壳读取产物内的 `web/editor.html`、`web/editor.css`、`web/editor.js`（macOS 在 `Contents/Resources/web/`，Windows 在 exe 同级 `web/`），内联后写到**文档同目录**的隐藏文件 `.mote-preview-<pid>.html`，再加载该文件。这一段是坑 P01 的解，不要改成 `loadHTMLString`。

**`editor.js` 体积警告**：单文件 5.8k 行已经偏大。重建时可以拆成「解析 / 渲染 / 编辑 / 历史 / 浮层」五个 IIFE 文件，但**不要引入 AMD/ESM/bundler**——原生按顺序拼进 `__MOTE_JS__` 即可，保持零构建。

---

## 4. 前端块模型（最容易被写错的部分）

### 4.1 数据源

- 整篇 Markdown 存在内存字符串里；渲染后每个块 `div.block` 上挂 `dataset.raw`（该块原文）。
- 块按**空行**切分；代码块、表格、列表会吸收内部空行，切分时要有状态机，不能简单 `split(/\n\s*\n/)`。
- 块间空行数量属于内容：切块时同时量出文首、块间与文末的换行数（每块之前的值挂在
  `data-gap`），序列化按实际数量拼回，不能固定拼 `\n\n`；选区与撤销的绝对偏移也要
  按实际间隔累加，不能假设「每块 +2」。
- 渲染时行内标记（`**`、`` ` ``、`[]()`）不删除，包进 `display:inline-block; width:0` 的 `.mk` 里；这样 `textContent` 与原文逐字对齐，光标偏移 = 原文偏移。
- 代码块是例外：围栏不进 DOM，语言存在 `dataset.lang`，拼回原文时再补首行围栏。

### 4.2 三种模式

| 模式 | DOM | 说明 |
| --- | --- | --- |
| 渲染态 | `.block` 内是渲染结果 | 默认 |
| 编辑态（单块） | 该块 `contenteditable`，显示 `dataset.raw` | 其余块不动 |
| 源码态 | 隐藏 `#editor`，显示 `textarea#source` | `Cmd+E`；切换不切断历史 |

### 4.3 历史

- `commitHistory()` 前把整篇序列化成快照（`stateText`），带绝对偏移；`undo/redo` 重建 DOM 后按偏移恢复光标。
- 201 步以内的普通文档不优化；超大文档每次输入序列化整篇，是已知代价。
- **任何绕过 `commitHistory` 的 `raw` 修改都会让撤销失效**——这是最常见的回归。

### 4.4 查找高亮

用绝对定位的矩形覆盖层，不往正文插 `<mark>`（插了就会改 `textContent` 与偏移）。替换只在「整段命中且不跨标记边界」时执行，否则明确拒绝并说明原因。

---

## 5. 消息协议（原生 ⇄ 页面）

页面 → 原生（`window.webkit.messageHandlers.mote.postMessage` / `window.chrome.webview.postMessage`）：

| type | 载荷 | 含义 |
| --- | --- | --- |
| `ready` | — | 页面初始化完成，可以注入文档 |
| `dirty` | `value` | 内容是否与上次载入/保存不同 |
| `save` | `text` | 请求保存整篇 |
| `open` | — | 请求打开对话框 |
| `image` | `source,name,mime,data` | 图片字节，原生写 `assets/` 后回调 |
| `status` / `error` | `message` | 状态栏 / 错误 |
| `view` | `toc,source,zoom` | 视图状态，Qt 同步菜单勾选 |
| `openLink` | `href` | `Cmd+Click` 链接 |
| `export` | `html` | 导出 HTML |
| `clipboardWrite` | `text,html?` | 页面算好的内容写入系统剪贴板 |
| `clipboard` | `command` | 请求原生执行 copy/cut/paste |
| `log` | `message` | 诊断日志（仅 `MOTE_KEYLOG=1`） |

原生 → 页面（`evaluateJavaScript` / `ExecuteScript`）：

`window.mote.setMarkdown` / `focus` / `undo` / `redo` / `toggleToc` / `toggleSource` / `zoomBy` / `resetZoom` / `insertImage` / `newDocument` / `state` / `exportHtml` / `pdfBegin` / `pdfEnd` / `format` / `clipboardCopy`。

**页面代次**：每次 `loadPage` 递增 `m_pageGeneration`，写进页面 URL 的 fragment；`ready` 带回代次，旧代次的迟到消息直接丢弃。没有这道防线，快速切换文档会注入错内容。

---

## 6. 平台宿主实现要点

### 6.1 macOS（`platform/mac/web_host_view.mm`）

1. 用 `WKWebView` + `loadFileURL:allowingReadAccessToURL:` 加载隐藏临时页面（P01）。
2. `WKScriptMessageHandler` 收 `NSDictionary` → `NSJSONSerialization` → JSON 字符串 → `core/json` 解析。
3. **按键**：`NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown` 接管 `Cmd+Z / Shift+Cmd+Z / Cmd+Y`，返回 `nil` 吞掉事件；其它按键放行（P04、P05）。
4. **拖放**：`WKWebView` 子类注册 `NSPasteboardTypeFileURL`，`draggingEntered` 只接受 md/图片，`performDragOperation` 把真实路径交给 `handleNativeFileDrop`。
5. **PDF**：见第 7 节。
6. 诊断：`MOTE_KEYLOG`、`MOTE_EVAL`、`MOTE_SNAPSHOT`、`MOTE_PDF_AS`、`MOTE_EXPORT_AS`。

### 6.2 Windows（`platform/win/web_host_view.cpp`）

1. `WebView2Loader.dll` 必须与 exe 同级；CMake 的 POST_BUILD 步骤负责复制，不能写死构建子目录（P33）。
2. 文档创建前用 `AddScriptToExecuteOnDocumentCreated` 注入消息桥，`editor.js` 一加载就会 `post ready`，桥必须先生效。
3. 快捷键走 `ICoreWebView2AcceleratorKeyPressed`，在 `AcceleratorKeyPressed` 里把 `Ctrl+Z` 等转成 `window.mote.undo()` 并标记 handled。
4. `PrintToPdf` 在 `ICoreWebView2_7`，打印设置工厂在 `ICoreWebView2Environment6`；Runtime < 108 直接报错，不做降级（P29）。
5. 拖放用 OLE `IDropTarget`，与 macOS 共用 `moteIsMarkdownPath/moteIsImagePath` 判定。
6. 中文路径：全程 UTF-8 `std::string` ↔ `std::wstring`（Win32 边界才转），不要经过本地代码页。

---

## 7. PDF 导出（两端实现完全不同，别想统一）

### 7.1 macOS：抓取 + 自绘分页

现成接口都不满足：

- `createPDFWithConfiguration:` 只能出**一张长页**，且单页高度上限 14400pt（200in），超出部分被裁；
- `printOperationWithPrintInfo:` 在本项目页面上会失控：20 秒内写 408–982MB 不返回（WebKit 的问题，不是参数写错）。

采用的方案（`macwebview.mm`）：

1. 页面加 `body.pdf-export`，清掉工具头栏、语言徽标、箭头、复制按钮、TOC、查找条。
2. 页面侧返回全部**安全切点**（块边界、行盒边界、图片边界），原生 `pdfPlanPages()` 先按 A4 内容区（595.28×841.89pt，左右 51pt，上下 56.7pt）排页；页内没有切点的超高原子块整段缩放进一页，宁可缩小不劈开。
3. `pdfChunks()` 把连续页打成包，每包高度 < 13800 CSS px（低于 14400pt 上限），逐包 `createPDFWithConfiguration`。
4. 用 CoreGraphics 把每包按排好的页切片绘制到 `CGPDFContext`，文字仍是矢量文字。
5. 上限 200 页；失败时删掉半成品文件并发 `pdfExportFailed`。

关键顺序：**先排页、后分包**。反过来会在包尾留下塞不下一页的空白页。

### 7.2 Windows：PrintToPdf

- A4 `8.27×11.69in`，左右 `0.71in`，上下 `0.79in`，打印背景，关闭页眉页脚。
- 先 `window.mote.pdfBegin()` 隐藏外壳，脚本回调成功后再 `PrintToPdfAsync`，完成回调里 `pdfEnd()` 恢复。
- 失败路径必须把 `m_pdfPath` 清空并释放 COM 引用，否则再次导出会拿到脏状态。

### 7.3 共同前提

未保存文档导出前先落盘：PDF 里图片的相对路径按 `.md` 所在目录解析，没有路径就没有图片。源码模式下禁用导出（菜单灰显 + 快捷键不触发）。

---

## 8. 构建与打包

### 8.1 macOS

依赖：macOS 14+、Xcode CLT、CMake 3.25+（不需要 Qt）。

```bash
cmake -S native -B build-native && cmake --build build-native
bash packaging/package_macos.sh --dmg --clean-dist
```

脚本固定七步：影子构建 → 依赖自检（不得链接 Qt）→ 去 rpath/strip → 签名/公证 → 做 DMG → 组装 zip → 外部路径自检。
自检要求 `otool -L/-D` 中 `/opt/homebrew`、`/usr/local`、`/Users/` 均为 0 行。

产物：`dist/Mote-macOS-native-<ver>.dmg`（约 1.7MB）、`dist/Mote-macOS-native.zip`（`.app` 约 4.1MB，含 Sparkle.framework）。

### 8.2 Windows

`packaging/package_windows_native.ps1` 出绿色版 `dist/Mote-Windows.zip`（exe + `WebView2Loader.dll` + `web/` + `fonts/`）；
`packaging/build_installer.ps1` 用 Inno Setup 6 出安装版 `dist/Mote-Setup-<版本>.exe`。
WebView2 SDK（NuGet 1.0.2903.40）放在仓库外，用 `WEBVIEW2_SDK` 覆盖路径。

### 8.3 版本号

- 唯一来源：仓库根 `VERSION.txt`（单行 `x.y.z`）。
- CMake 读取后同时注入编译宏、macOS `Info.plist` 与 Windows `app.rc` 的版本字段。
- 不要在任何脚本里再写一份版本常量；打包脚本自动用版本号命名产物。

---

## 9. 调试与自动化验证

| 手段 | 用法 | 用途 |
| --- | --- | --- |
| `MOTE_EVAL` | 页面就绪约 1.2s 后执行一次 JS，结果打到 stderr（`JSLOG EVAL ...`） | 只读核对 DOM/状态，替代肉眼 |
| `MOTE_KEYLOG=1` | 打印 JS 日志、原生按键链、Qt 快捷键、最终菜单表 | 查「菜单有、按了没反应」 |
| `MOTE_SNAPSHOT` | 截图到指定 png | 视觉回归 |
| `MOTE_PDF_AS` / `MOTE_EXPORT_AS` | 跳过保存对话框 | 自动化导出 |
| `tools/preflight.sh` | 仓库状态 → 独立目录构建 → 启动冒烟 | 提交前自检 |
| `pbcopy` + `Cmd+V` | 往页面输入 ASCII | 避免 AppleScript `keystroke` 触发中文输入法候选窗 |

自动化经验：

- 用真实坐标点击前，先注入探针记录 `mousedown/mouseup/click` 的 target 与坐标，确认点中的是目标元素（曾经点到 `gutter` 而不是徽标）。
- 检查导出 HTML 是否残留 UI 时，只看 `<article>` 里的真实元素；直接全文搜 `code-tools` 会命中 CSS 选择器字符串，误判。
- `markModified()` 只调 `setWindowModified`，不会每次打印标题；dirty 验证看关闭按钮圆点或 `dirty` 消息，别等日志。

---

## 10. 坑清单（按症状查）

### A. 页面加载与资源

**P01 `loadHTMLString:baseURL:` 下图片永远不显示**
WebKit 把页面当成无来源文档，拒绝一切 `file://` 子资源，`naturalWidth` 恒为 0。
→ 把内联后的页面写到文档同目录的隐藏文件，用 `loadFileURL:allowingReadAccessToURL:` 加载，并注入 `<base href>` 指回文档目录。只给 `baseURL` 不够。

**P02 临时文件残留**
异常退出会留下 `.mote-preview-<pid>.html`。
→ 加入 `.gitignore`；正常退出与换文档时删除；pid 命名避免多实例互踩。

**P03 qrc 改了但运行没变化**
前端资源编在二进制里，必须重跑 `rcc`。
→ 用 `make` 触发 `qrc_resources.cpp` 重编；改 `dist/` 里的 app 无效，必须重新打包。

### B. 按键与菜单

**P04 `Cmd+Z` 有菜单但页面收不到**
AppKit 的 NSMenu 在页面 `keydown` 之前消费 key equivalent；撤销/重做走 responder chain 的 `undo:`，是 WebKit 自己那套历史。
→ 用 `NSEvent` local monitor 在菜单匹配前分流，返回 `nil` 吞掉。

**P05 重做变成再撤销一次**
NSMenu 匹配字母快捷键时忽略 Shift，`Cmd+Shift+Z` 命中排在前面的「撤销」。
→ 同上，必须在 monitor 里先判断 Shift。

**P06 格式类快捷键（`Cmd+B` 等）无反应**
不注册 QAction 就会被系统吞掉，页面收不到。
→ 每个要在 WebView 内生效的组合键都注册原生 QAction，再调 `window.mote.format(...)`；新增键必须查重（`MOTE_KEYLOG=1` 打印全表）。

**P07 右键「转为」只作用到一块**
WebKit 在派发 `contextmenu` 前就把多块选区折成光标。
→ 在右键 `mousedown` 阶段保存 Range，`contextmenu` 时若点击落在保存范围内再恢复。

### C. 编辑模型

**P08 编辑态切换后块宽高跳动**
行内标记占位、边框/内边距变化、滚动条出现都会引起。
→ 标记一律零宽；编辑态与渲染态共用同一盒模型；代码块滚动条用 `normalizeCodeScrolls()` 归一化。

**P09 中文输入法组字时 Enter 被菜单/快捷键抢走**
组合态下 `keydown` 的 `isComposing` 不可靠。
→ 维护独立的 `composing` / `langComposing` 标志（`compositionstart` 置位、`compositionend` 清位），组字期间放行一切 Enter/Escape。

**P10 撤销后光标位置错乱**
重建 DOM 后没有恢复绝对偏移。
→ 快照里带光标绝对偏移，`rebuildFromSnapshot` 后按块定位恢复；找不到就退回块首。

**P11 表格里 Enter 多出一行，导致原文多一行**
块模型假设「一行 = 一条 raw」。
→ Enter 不新增行；新增行用末格 `Tab` 或 `Cmd+Enter`。

**P12 表格的 `|` 与对齐行把列宽撑乱**
→ 两者都做成零宽标记；对齐行放在隐藏 `<tr>`。

### D. 代码块

**P13 代码块渲染后少一行**
结尾的 `\n` 属于正文（末行后的空行），剥掉就会在编辑-重排往返中丢失。
→ 只吃掉围栏前那个 `\n`，结尾保留。

**P14 横向滚动时行号跟着跑**
行号在滚动容器内。
→ 行号独立成栏（`contenteditable=false` + `user-select:none`），放在 `.code-scroll` 之外；代码块只横向滚动，整块随页面纵向滚动，行号与代码行高保持一致。

**P15 重建后代码块高度少 15px**
WebKit 不把横向滚动条高度算进 `.code-scroll` 的 border box；只改 `overflow-x` 不会触发重算。
→ `overflow-y: auto` → 强制回流 → 还原（`normalizeCodeScrolls`）。

**P16 语言徽标能编辑，导致光标进不去/复制出错**
早期把徽标做成 `contenteditable`。
→ 徽标只做 `role=button`，不可编辑；改语言走 `applyCodeLang` → `dataset.lang` → `drawCode`，再 `scheduleDirty/commit`。

**P17 下拉被代码块 `overflow` 裁掉**
菜单嵌在 `.code-scroll` 或 `.block` 里。
→ 下拉挂 `document.body`，`position: fixed`，`z-index: 50`，按锚点矩形定位并钳进视口；滚动/缩放/重建 DOM 时关闭。

**P18 输入 `py` 时同时出现 Python 和「自定义 py」**
→ 候选先按 name/alias/关键词过滤；自定义项只在「输入为 ASCII 且没有任何前缀匹配」时追加；非 ASCII（如 `脚本`）只用于搜索。

**P19 候选列表滚动导致下拉关闭**
全局 `scroll` 监听把列表自身滚动也算作页面滚动；`scrollIntoView` 还会滚整页。
→ 捕获阶段监听时若 `menu.contains(event.target)` 直接返回；用 `scrollTop` 定位，不用 `scrollIntoView`。

**P20 打印/导出 PDF 里出现徽标、箭头、按钮、下拉**
→ `@media print` 与 `body.pdf-export` 两条路径都隐藏 `.code-tools`、`#lang-menu`、TOC、查找条；导出前若菜单开着先 `closeLangMenu()`。

**P21 展开箭头被复制进剪贴板**
用字符画箭头会进入 `textContent`。
→ 用纯 CSS 边框画空 `span`（无文本），`aria-hidden="true"`，旋转由 `aria-expanded` 控制。

### E. 剪贴板

**P22 复制按钮把行号/语言也带出去**
按钮在 `<pre>` 内，直接取 `textContent` 会带上 UI。
→ 只取 `<code>` 的正文；按钮 `contenteditable=false` 且不在 `<code>` 内；复制统一走 `clipboardWrite` 回原生写系统剪贴板，不另造逻辑。

**P23 网页侧 `navigator.clipboard` 不可用或行为不一致**
WKWebView / WebView2 的权限与安全上下文口径不同。
→ 所有写入都回传原生（Qt `QClipboard` / `NSPasteboard`），页面只负责算出 `text` 与可选 `html`。

**P24 复制任务列表带出复选框图形**
→ `copy` 处理器剔除 UI 标记，只输出 Markdown；复选框是 `aria-hidden` 的非文本节点。

### F. PDF

**P25 `createPDF` 抓整篇只得到前半段**
单页高度上限 14400pt，超出被裁。
→ 分段抓取，每段 < 13800 CSS px，最后用 CGPDF 拼接。

**P26 分页拼接处重复或缺行、文字被横向劈开**
切点没落在安全位置。
→ 页面侧返回块/行盒/图片的安全切点；先按 A4 排页，再把连续页分包；页内无切点的超高块整段缩放。

**P27 `printOperationWithPrintInfo:` 写盘失控**
本机实测 20s 内 408–982MB 不返回，属 WebKit 实现问题。
→ 不要重试、不要调参，直接放弃这条路。

**P28 PDF 里图片丢失**
文档未保存，没有目录可解析相对路径。
→ 导出前强制先保存；源码模式禁用导出。

**P29 Windows 上 PrintToPdf 失败**
Runtime < 108 或接口拿不到。
→ 明确报错「需要 108 或更高版本」，不做静默降级。

### G. 打包

**P30 `macdeployqt` 报 `Cannot resolve rpath QtPdf/QtSvg/虚拟键盘`**
这些框架本来就要删，是噪声。
→ 不要因此中断脚本；紧跟的「删除插件」步骤会清掉它们；最终以依赖自检的 0 行为准。

**P31 包体 30MB 下不去**
`libicudata` 约 32MB。
→ 与架构无关；要减只能换无 ICU 的 Qt 构建（未做）。

**P32 双击提示「已损坏」/ 无法打开**
Ad-hoc 签名、未公证，带 quarantine。
→ 文档写明右键「打开」；不做假公证。

**P33 Windows 绿色版报缺 `WebView2Loader.dll`**
复制目标目录写死 `release/`，MSVC 与 MinGW 产物目录不同。
→ 用 `$(DESTDIR)`；同时保留 `WEBVIEW2_SDK` 环境变量覆盖。

**P34 版本号三处不一致**
`app.rc` 是 rc.exe 直接编译，qmake 不替换。
→ `Mote.pro` 为准；`Info.plist` 用占位符自动展开；Windows 的 `FILEVERSION/PRODUCTVERSION/字符串` 手工同步，提交信息里写明。

**P35 安装包注册 `.md` 关联后图标与右键菜单不刷新**
Explorer 缓存了旧的关联信息。
→ 用 `SHChangeNotify`（`SHCNE_ASSOCCHANGED` + `SHCNF_IDLIST`）显式通知，安装与卸载两处都要调（`packaging/mote.iss` 已有实现）；不要去改系统图标缓存。

### H. 协作与发布

**P36 iCloud 目录导致构建缓慢、产物反复同步**
→ 工程移出同步目录；影子构建放 `$TMPDIR`。

**P37 双机行尾不一致**
→ `.gitattributes`：`* text=auto`、`*.sh eol=lf`、`*.bat/*.cmd eol=crlf`、图片与字体 `-text`。

**P38 发行页附件大小显示为空**
Gitee release 详情接口不返回 `assets.size`。
→ 以上传接口的返回值与本机 `stat` 为准。

**P39 先建发行版再推 tag，结果生成了轻量标签**
Gitee 在 `tag_name` 不存在时会按 `target_commitish` 自建 tag。
→ 顺序固定：先 `git push origin vX.Y.Z`（附注标签），再 `POST /releases`。

---

## 11. 重建路线（给 AI 的分阶段任务）

每个阶段都以「可运行 + 可验收」结束，不要跳步。

### M0 骨架可跑（半天量级）
- 建 qmake 工程、`webwindow`、`webview.h` 抽象、`webviewbase`。
- 页面能加载 `editor.html` 内联版，显示一段固定 Markdown。
- 验收：启动即见渲染结果，`MOTE_EVAL` 能读到 `document.body.innerText`。

### M1 只读渲染
- 块切分、行内标记、表格、代码块高亮、行号、图片、任务列表、TOC。
- 验收：`dataset.raw === textContent` 对普通块成立；代码/表格/分隔线按例外处理。

### M2 块级编辑
- 单击进编辑态、失焦回渲染态、零位移、光标偏移映射。
- 保存/打开/脏标记/未保存确认。
- 验收：编辑前后块 `top/height` 不变；保存字节与原文一致。

### M3 历史与查找
- 整篇快照撤销、重做、查找覆盖层、替换边界拒绝。
- 验收：20 步连续编辑可完整回退；跨标记替换被拒绝并有提示。

### M4 代码块增强
- 复制按钮、语言徽标、语言选择器、展开箭头、打印清理。
- 验收：复制内容与 `<code>` 逐字节一致；下拉不被裁剪；PDF/打印无 UI。

### M5 PDF 与导出
- macOS 抓取 + 分页 + 拼接；Windows PrintToPdf。
- 验收：800 段长文档导出为多页 A4，无截断、无空白页、中文与图片正常。

### M6 打包与发布
- `package_macos.sh --dmg`、Windows 脚本、preflight、版本号、发行说明、tag、发行页。
- 验收：干净目录构建通过；DMG 挂载启动冒烟通过；依赖自检 0 行。

---

## 12. 明确不要做的事

1. 不要用 `loadHTMLString` 加载正文页。
2. 不要引入 Markdown/高亮库，也不要把语法标记从 DOM 删掉。
3. 不要在页面上用 `navigator.clipboard` 写系统剪贴板。
4. 不要试图用 `printOperationWithPrintInfo:` 做 PDF。
5. 不要把行号放进代码滚动容器，也不要用 `position: sticky` 固定它。
6. 不要在 `app.rc`/`Info.plist` 里另立版本号来源。
7. 不要在 `.code-tools` 上加回底部分隔线（0.3.3 已按设计去掉）。
8. 不要为了「更快」把整篇快照撤销换成细粒度 diff——历史与输入法会打架。
9. 不要用 `scrollIntoView` 给浮层列表定位。
10. 不要把助手说明、临时路径写进发行说明与发行页正文。

---

## 13. 已知限制（照实写进 README，不要承诺）

- macOS 仅 arm64；Ad-hoc 签名、未公证。
- 查找/替换不跨块；跨标记替换主动拒绝。
- 上下方向键不跨块。
- 源码模式无语法高亮，目录隐藏。
- 深色模式只覆盖正文区，菜单栏/工具栏跟随系统。
- 锚点链接按 GitHub 风格 slug 在文档内跳转（中文保留、去标点、空格转 `-`，重名加 `-1`）；图片不包 `<a>`，`Cmd+Click` 不跳转。
- 撤销是整篇快照，超大文档有性能上限。
- 输入法候选窗、长按连发、触控板手势只能人工确认。

---

## 14. 最小骨架（示意，不是可直接编译的完整实现）

### 14.1 页面组装与加载

```cpp
// 读 qrc → 内联 → 写到文档目录隐藏文件 → 用文件 URL 加载
QString html = readAll(QStringLiteral(":/web/editor.html"));
html.replace(QStringLiteral("__MOTE_CSS__"), readAll(QStringLiteral(":/web/editor.css")));
html.replace(QStringLiteral("__MOTE_JS__"),  readAll(QStringLiteral(":/web/editor.js")));

const QString page = baseDir.toLocalFile()
    + QStringLiteral("/.mote-preview-%1.html").arg(QCoreApplication::applicationPid());
writeFile(page, html);

// macOS
[web loadFileURL:[NSURL fileURLWithPath:page.toNSString()]
  allowingReadAccessToURL:[NSURL fileURLWithPath:baseDir.toLocalFile().toNSString()]];
```

注入 `<base href="file:///文档目录/">` 后再 `setMarkdown`，相对图片才能解析。

### 14.2 消息分发（两端共用）

```cpp
void WebViewBase::handleMessage(const QString &json)
{
    const QJsonObject m = QJsonDocument::fromJson(json.toUtf8()).object();
    const QString type = m.value(QStringLiteral("type")).toString();

    if (type == QLatin1String("ready"))  { m_pageReady = true; flushPending(); }
    else if (type == QLatin1String("dirty")) { emit dirtyChanged(m.value("value").toBool()); }
    else if (type == QLatin1String("save"))  { emit saveRequested(m.value("text").toString()); }
    else if (type == QLatin1String("open"))  { emit openRequested(); }
    else if (type == QLatin1String("image")) { saveImageBytes(...); }
    else if (type == QLatin1String("clipboardWrite")) { writeClipboard(m); }
    else if (type == QLatin1String("export")) { finishExportHtml(m.value("html").toString()); }
}
```

要点：`ready` 之前收到的文档/导出请求先缓存，`ready` 后统一 flush；`ready` 必须带页面代次。

### 14.3 块渲染循环（JS）

```js
function mountBlocks(blocks) {
  root.textContent = '';
  blocks.forEach(function (raw) {
    var el = document.createElement('div');
    el.className = 'block';
    el.dataset.raw = raw;          // 唯一真相
    renderBlock(el, raw);          // 渲染态 DOM
    root.appendChild(el);
  });
  normalizeCodeScrolls(root);      // P15
}
```

编辑态进入时用 `dataset.raw` 重建该块文本；离开时重新 `renderBlock`，前后不得改动其它块。

---

## 15. 打包坑点详解（macOS / Windows）

本节细化第 10 节 G 组（P30–P35）。打包是「代码都对、包一跑就崩」的高发区，建议直接照抄 `packaging/package_macos.sh`、`packaging/package_windows.bat`、`packaging/mote.iss` 的处理顺序。

### 15.1 macOS

**M01 工程放在 iCloud「文稿」等同步目录，签名必失败**
FileProvider 会反复给 `.app` 写 `com.apple.FinderInfo`，`codesign` 报 `resource fork, Finder information, or similar detritus not allowed`。
→ 构建目录、zip 暂存、DMG 暂存全部放 `$TMPDIR`（脚本用 `mote-build` / `mote-stage` / `mote-dmg`）；签名前 `xattr -cr`，并显式删除 `com.apple.FinderInfo` 与 `com.apple.fileprovider.fpfs#P`。

**M02 标准按钮显示英文**
`macdeployqt` 不部署 Qt 翻译，`QMessageBox` 的「保存 / 不保存 / 取消」来自 `qtbase_zh_CN.qm`。
→ 手动拷到 `Mote.app/Contents/translations/`。注意实测路径是 `Contents/translations`，**不是** `Contents/Resources/translations`；缺文件应直接让脚本失败，不要静默出包。

**M03 包体莫名其妙变大，还带进 QML/PDF 依赖**
`macdeployqt` 会把 `QtPdf`、`QtSvg`、`QtVirtualKeyboard`、`QtQml*`、`QtQuick*` 一并拖进来，并打印 `Cannot resolve rpath` 的 ERROR。
→ 删 `PlugIns/platforminputcontexts`、`PlugIns/iconengines`、`PlugIns/imageformats/libqpdf.dylib`、上述 framework，以及 `qml/`。这些 ERROR 是删除前的噪声，不要当成失败。

**M04 Homebrew 传递依赖漏改（典型：`libbrotlicommon`）**
包内二进制仍指向 `/opt/homebrew/...`，换台机器就崩。
→ 遍历包内全部 Mach-O，用 `otool -L` 找 `/opt|/usr/local|/Users` 开头的依赖，`install_name_tool -change` 改成 `@executable_path/../Frameworks/...`。framework 形态要保留 `X.framework/Versions/A/X` 整段相对路径，不能只取 basename。

**M05 framework 的 install id 还是开发机路径**
`install_name_tool` 改依赖不会改 install id。
→ 逐文件用 `otool -D` 判断，别按目录名猜（`QtDBus.framework/Versions/A/QtDBus` 只是恰好同名）；改成 `@executable_path/../Frameworks/<相对路径>`。

**M06 残留的 Homebrew rpath 让程序加载系统库**
依赖已改成包内路径，但 `LC_RPATH` 还留着 `/opt/homebrew/Cellar/...`；装了同版本库的机器会优先加载系统副本，症状是「我这里好好的，别人那里闪退」。
→ 逐个 `-delete_rpath`。注意 `install_name_tool` 会破坏签名，**所有改写完成后统一重签**，再跑外部路径自检。

**M07 没有出包前自检**
→ 打包脚本最后必须扫描所有 Mach-O 的 `otool -L` 与 `otool -D`，`/opt/homebrew`、`/usr/local`、`/Users/` 三项都必须为 0 行，否则非零退出。本次 51 个 Mach-O 全部通过。

**M08 zip 里带进扩展属性，解压后签名校验失败**
`ditto -c -k --sequesterRsrc --keepParent` 是正确写法；暂存目录同样要在 `$TMPDIR`，并 `xattr -cr`。
→ 不要把 `.app` 直接丢进同步目录再压缩。

**M09 DMG 里用 AppleScript 摆图标，换台机器就不可复现**
Finder 自动化需要 GUI 会话与「辅助功能/自动化」授权，脚本在 CI 或无界面环境会卡住。
→ 卷内只放 `Mote.app` 与指向 `/Applications` 的符号链接，图标位置交给 Finder 默认网格；`hdiutil create -format UDZO -fs HFS+` 后用 `hdiutil verify` 校验。

**M10 拿上一次的 SHA256 核对新打的 DMG**
DMG 内含卷 UUID 与时间戳，**每次重建哈希都会变**。
→ 校验值必须在本次打包输出里现取（`stat -f%z` + `shasum -a 256`），不要复用旧值。

**M11 `--clean-dist` 不是默认行为**
默认只覆盖同名产物，否则「只想出 zip」会把手工保留的 DMG 一起删掉。
→ 明确区分两种语义；打包脚本用 `set -euo pipefail`，任何一步失败立即停。

**M12 打包脚本里另写一份版本号**
→ 只读构建产物 `Info.plist` 的 `CFBundleShortVersionString`（qmake 已展开 `@FULL_VERSION@`），脚本里不再写常量。产物命名统一用这个值。

**M13 Ad-hoc 签名 ≠ 可分发**
`codesign --force --deep --sign -` 只解决「本地能跑」；未公证的包从网络下载会被 Gatekeeper 拦。
→ 文档写清「右键 → 打开」；不要伪造公证，也不要承诺双击即开。

**M14 包体积预期**
`libicudata` 约 32MB，是包体主因；实测 zip 约 31MB、DMG 约 34MB、解压后 `.app` 约 75MB。
→ 想显著减小只能换不带 ICU 的 Qt 构建，属于构建链改造，不是打包参数能解决的。

### 15.2 Windows

**W01 直接把 macOS 的 `dist/` 拿去 Windows 用**
里面是 arm64 的 `.app`，Windows 无法运行，脚本第一步还会把 `dist/` 整个删掉。
→ Windows 必须从源码重新编译；跨机只传 `src/`、`resources/`、`Mote.pro`、`packaging/` 或直接 `git clone`。

**W02 用 `ditto --sequesterRsrc` 打跨平台源码包**
会把 macOS 扩展属性带进 zip，Windows 解压出 `__MACOSX/` 与资源叉文件。
→ 跨平台传源码用普通 zip 或 git；`ditto` 只用于 macOS 产物。

**W03 MSVC 与 MinGW 两套 Qt 混用**
用 MSVC 的 Qt 必须配 MSVC 工具链（`nmake`/`cl` 在 PATH），用 MinGW 的 Qt 必须 `mingw32-make`；两套 `bin` 同时进 PATH 时 `where qmake` 会命中错的那个。
→ 每个命令行只激活一套；MSVC 从「x64 Native Tools 命令提示符」启动。

**W04 构建路径含空格、中文或放在同步盘**
`nmake` 在含空格目录经常直接失败，MSVC 在中文路径下有兼容问题；OneDrive/坚果云会锁文件，导致脚本第 1 步 `rmdir /s /q build` 失败。
→ 用短英文路径（如 `C:\dev\mote`），并先关掉正在运行的 `Mote.exe`。

**W05 找不到 `Mote.exe`**
MSVC 产物在 `build\release\Mote.exe`，MinGW 在 `build\Mote.exe`。
→ 脚本两个位置都要查，找不到再报错。

**W06 漏掉平台插件，双击必闪退**
`platforms\qwindows.dll` 缺失时提示「could not find or load the Qt platform plugin windows」。
→ `windeployqt --release --compiler-runtime --no-translations --no-system-d3d-compiler --no-opengl-sw`，并在安装包构建前断言 `platforms\qwindows.dll` 存在。

**W07 `WebView2Loader.dll` 不在 exe 同级**
表现为启动即提示缺少 DLL，或「版本不匹配（缺少环境创建接口）」。
→ 从 SDK 的 `build/native/x64/` 复制到 exe 同级；qmake 里用 `QMAKE_POST_LINK` + `$(DESTDIR)` 自动复制，SDK 路径用 `WEBVIEW2_SDK` 覆盖默认的 `C:/dev/webview2sdk/pkg`。

**W08 关掉翻译后中文按钮又变英文**
`--no-translations` 会跳过整个 `translations\`。
→ 手工 `mkdir translations` 并只拷 `qtbase_zh_CN.qm`；不要为了一个文件把整个目录塞回去。

**W09 包体清理删过头或删不够**
该删：`opengl32sw.dll`、`d3dcompiler_47.dll`、`Qt6Pdf.dll`、`imageformats\qpdf.dll`、`Qt6Qml/Quick`、`qml\`、`*.pdb/*.exp/*.lib`。
不能删：`platforms\`、`imageformats\` 里实际用到的格式插件、`styles\`（若 windeployqt 生成了样式插件）、`WebView2Loader.dll`。
→ 按白名单思路清理，并在安装包脚本里做必需文件断言（`Mote.exe`、`WebView2Loader.dll`、`Qt6Core/Gui/Widgets`、`platforms\qwindows.dll`）。「装得上、跑不起来」是这里代价最高的错误。

**W10 MSVC 产物在干净机器上闪退**
依赖 VC++ 2015–2022 x64 运行库（`vcruntime140.dll`、`msvcp140.dll`）。
→ 要么目标机装 Redistributable，要么改用 MinGW + `--compiler-runtime`（带 `libgcc_s_seh-1.dll`、`libstdc++-6.dll`、`libwinpthread-1.dll`），做到解压即用。

**W11 未签名触发 SmartScreen**
→ 文档写明「更多信息 → 仍要运行」；不要假设用户能无障碍打开。

**W12 安装包版本号漂移**
`mote.iss` 不写默认版本，漏传 `/DMyAppVersion` 直接 `#error`；`build_installer.ps1` 从仓库根 `VERSION.txt` 读取后传入。
→ 版本号始终单一来源；手工编译时必须自己传参。

**W13 升级安装变成并存两份**
→ `AppId` 用固定 GUID（本仓 `{7C3E7A2B-4F6D-4E2A-9B7C-1D5E8F3A6C21}`），`UsePreviousAppDir=yes`；否则新版本装到新目录，旧版本文件残留。

**W14 安装需要管理员权限**
→ `PrivilegesRequired=lowest` + `DefaultDirName={localappdata}\Programs\Mote`，按用户安装；`ArchitecturesAllowed=x64compatible`，`MinVersion=10.0`。

**W15 `.md` 关联「设了但不生效」**
Win10 的 `FileExts\.md\UserChoice`（带 `Hash`）优先级高于 `Software\Classes`；Win11 还有 `UserChoiceLatest\ProgId`。
→ 安装时先备份这两个值，再删除/改写 `UserChoice`；卸载时只在当前值仍指向 `Mote.md` 时还原，用户后来换过默认程序就不要碰。写回 `ProgId` 失败时不要写 `Hash`，避免留下不匹配的坏键。

**W16 关联改了，图标与右键菜单不刷新**
`ChangesAssociations=yes` 只管安装阶段。
→ 安装 `ssPostInstall` 与卸载 `usUninstall` 各调一次 `SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0)`。

**W17 覆盖安装时 DLL 被占用**
→ `CloseApplications=yes` 让 Inno 通过 Restart Manager 检测并提示关闭正在运行的 Mote；`RestartApplications=no`，不要替用户自动拉起。

**W18 WebView2 Runtime 缺失时静默失败**
→ 安装时查 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\pv`（32/64 位与 HKCU 各查一遍），缺失时给出微软下载链接，别让用户面对白窗口。

**W19 打包脚本输出中文乱码**
批处理默认代码页不是 GBK。
→ 开头 `chcp 936`；含中文的路径与提示都放在这个代码页下，PowerShell 部分单独用 `-NoProfile -ExecutionPolicy Bypass`。

**W20 `app.rc` 图标找不到**
`rc.exe` 的相对路径以 `.rc` 所在目录为基准；某些环境下找不到 `app.ico`。
→ 保持 `.rc` 与 `app.ico` 同目录；必要时在 `.rc` 里改绝对路径。

**W21 版本号三处不同步**
`app.rc` 由 rc.exe 直接编译，qmake 不替换。
→ `FILEVERSION`、`PRODUCTVERSION`、字符串块三处手工同步；提交信息里注明。

### 15.3 两端共用的交付前自检

- 在一台**没装 Qt**的干净机器上解压/安装后双击，无「缺少 DLL / 平台插件」。
- 打开内置 `samples/welcome.md`：标题、表格、代码块底色、图片、任务列表全正常。
- 代码块用 JetBrains Mono（不依赖系统字体），`licenses/` 内有 OFL 与 AGPL 全文。
- 关联/拖放/命令行传参三条打开路径都试一次。
- 记录产物字节数与 SHA256，并核对发行说明里的数字（DMG 每次重建都会变）。
