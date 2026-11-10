# Mote 新架构方案：Qt 外壳 + 系统 WebView

状态：MVP 已跑通（打开 → 编辑 → 保存 → 未保存提示），并已补齐代码块语法高亮与
行号、TOC 侧栏、缩放、源码模式。旧纯 Qt 文本引擎的实现在 `src/mainwindow.*`、
`src/previewview.*`、`src/codehighlighter.*`（默认不启用，`MOTE_LEGACY_QT=1` 时回退），
并备份于 `backup/qt-text-engine-20261109/`。

## 1. 分层与职责边界

```
┌────────────────────────────── Qt 外壳（C++） ──────────────────────────────┐
│ 主窗口 / 菜单 / 快捷键 / 文件对话框 / 拖拽 / 最近文件（后续） / 未保存提示     │
│ 文件读写（QFile） · 编码处理（UTF-8）· 窗口标题与 [*] 修改标记 · 错误弹窗      │
└───────────────┬──────────────────────────────────────────────┬──────────────┘
                │ setMarkdown / requestSnapshot                │ save / dirty / open
        ┌───────▼──────────────────────────────────────────────▼───────┐
        │ 桥接层：WebEditor 抽象接口 + 平台实现（WKWebView / WebView2） │
        └───────────────────────────┬─────────────────────────────────┘
                                    │ HTML/CSS/JS（包内资源）
                        ┌───────────▼───────────────┐
                        │ 前端编辑器（唯一数据源=Markdown 源文本）│
                        └───────────────────────────┘
```

- **Qt 侧**：只做操作系统能力与生命周期，不解析 Markdown，不做排版。所有文件写入、
  未保存判断、对话框都在 C++，避免 JS 直接碰文件系统。
- **前端**：负责 Markdown 源文本的编辑、块级渲染、选区/撤销/输入法。前端永远持有
  完整源文本，并在需要时（保存、失焦、关闭）把 `text` 回传。
- **数据流**：打开文件 → Qt 读取 UTF-8 → `setMarkdown(text, baseDir)` → JS 建立模型并渲染；
  编辑 → JS 内部更新模型 + 发 `dirty`；保存 → Qt 请求快照或 JS 主动回传 → Qt 写盘。

## 2. 桥接层设计

### 2.1 接口（与平台无关）

`src/webview.h` 定义 `WebEditor`（QWidget 子类）与工厂：

```cpp
class WebEditor : public QWidget {
    Q_OBJECT
public:
    virtual void setMarkdown(const QString &text, const QUrl &baseDir) = 0;
    virtual void requestSnapshot() = 0;   // 触发 JS 回传 save 消息
    virtual void newDocument() = 0;        // 清空为空白文档，并复位查找/目录/缩放
    virtual void setBaseDir(const QUrl &dir) = 0;  // 另存为后同步图片落盘目录
signals:
    void ready();
    void dirtyChanged(bool dirty);
    void saveRequested(const QString &text);
    void openRequested();
    void dropReceived(const QString &name, const QString &text);
    void errorOccurred(const QString &message);
};

// 平台工厂（定义在 src/webview.h）
WebEditor *createWebEditor(QWidget *parent);
```

macOS 由 `src/macwebview.mm` 实现，Windows 由 `src/webview_win.cpp`（WebView2）实现，
其余平台由 `webview_stub.cpp` 占位。外壳只依赖该接口，替换平台实现不影响窗口逻辑。

### 2.2 macOS：WKWebView 挂进 Qt 窗口

- `MacWebView` 继承 `QWidget`，设置 `WA_NativeWindow`；在 `showEvent` 里把
  `QWidget::winId()` 当作 `NSView *`，用 `addSubview:` 挂载 `WKWebView`，
  `resizeEvent` 同步 frame，`autoresizingMask` 跟随窗口缩放。
- 不使用 `QtWebEngine`（体积大头，违背 40 MB 目标）；WKWebView 是系统框架，
  随 macOS 提供，打包不增加体积。
- 前端资源（HTML/CSS/JS）通过 qrc 编入可执行文件，由 C++ 读出后写成文档目录下的
  隐藏临时文件 `.mote-preview-<pid>.html`，再用
  `loadFileURL:allowingReadAccessToURL:` 载入；页面里注入 `<base href="file:///md目录/">`，
  `assets/x.png` 这类相对路径才能解析并被 WebKit 允许读取。
  注入只替换**页面模板自己的第一处** `</head>`：早先用整串 `replace("</head>", …)`，
  会连内嵌 JS 源码里的 `'</head>'` 字面量一起改掉，导出 HTML 因此凭空多出一个
  `file://` 的 `<base>`（2026-11-10 修复）。
- **为什么不用 `loadHTMLString:baseURL:`**：这样载入的页面是「无来源」文档，WebKit 拒绝
  读取任何 `file://` 子资源（实测 `img.naturalWidth=0`、`fetch` 报 `Load failed`），
  相对路径图片永远不会显示；`baseURL` 只是解析基准，不等于读权限。
- 限制说明：临时文件必须与文档同目录（`loadFileURL` 要求主文档在授权目录内），
  正常退出删除，异常退出可能残留；切换文档时重新载入页面，同一文档内刷新只更新模型。

### 2.3 消息协议（JSON）

JS → 原生（`window.webkit.messageHandlers.mote.postMessage(obj)`）：

| type | 载荷 | 含义 |
| --- | --- | --- |
| `ready` | — | 页面与编辑器初始化完成，可以注入文档 |
| `dirty` | `value: bool` | 当前内容与上次载入/保存是否一致 |
| `save` | `text: string` | 请求保存整篇 Markdown（Cmd+S 或快照请求的响应） |
| `open` | — | 请求 Qt 弹出打开对话框（Cmd+O，WebView 内捕获） |
| `drop` | `name, text` | 拖入文件的文本内容（网页层兜底；原生拖放优先，见 §2.6） |
| `image` | `source, name, mime, data(base64)` | 粘贴/拖入的图片字节，原生写入 `assets/` 后回调插入 |
| `status` | `message` | 前端请求显示状态栏提示（不走错误通道） |
| `error` | `message` | 前端异常，Qt 侧显示状态栏/弹窗 |
| `view` | `toc, source, zoom` | 视图状态变化（目录开关、源码模式、缩放倍率），Qt 同步菜单勾选与状态栏 |
| `log` | `message` | 诊断日志；仅 `MOTE_KEYLOG=1` 时打印到 stderr |
| `openLink` | `href` | `Cmd+Click` 链接：外部链接交系统浏览器，相对 `.md` 在应用内打开，`#锚点` 只提示 |
| `export` | `html` | 「导出 HTML…」：整篇自包含 HTML 回传，Qt 侧内嵌本地图片后写盘 |

原生 → JS（`evaluateJavaScript`）：

| 调用 | 含义 |
| --- | --- |
| `window.mote.setMarkdown(text)` | 注入/替换整篇文档（打开文件、回退、外部刷新） |
| `window.mote.focus()` | 焦点交还编辑器 |
| `window.mote.undo()` / `redo()` | 原生菜单与快捷键直接驱动前端自建历史栈 |
| `window.mote.toggleToc()` | 目录侧栏开关 |
| `window.mote.toggleSource()` | 所见即所得 ⇄ 整篇 Markdown 源码 |
| `window.mote.zoomBy(n)` / `resetZoom()` | 缩放 ±0.1 步进 / 回到 100% |
| `window.mote.insertImage(rel)` | 原生把图片写进 `assets/` 后回调：在光标处插入 `![](rel)` |
| `window.mote.newDocument()` | 新建空白文档：关查找、关目录、缩放回 100%、整篇清空并把光标放进空块 |
| `window.mote.state()` | 只读状态（诊断用）：模式、目录、缩放、脏标记、源文本 |
| `window.mote.exportHtml(title)` | 拼出自包含 HTML 并回传 `export` 消息（不读写文档模型） |

- macOS 实现用 `WKScriptMessageHandler` 接收 `NSDictionary`，
  `NSJSONSerialization` 转 JSON 字符串后交给 Qt 的 `QJsonDocument` 解析。
- `WKWebView` 是原生视图，Qt 的窗口级 `QAction` 快捷键在 WebView 获得焦点时不一定触发，
  因此 `Cmd+S`/`Cmd+O` 在 JS 侧也注册一份，两条路径都收敛到同一处理函数，避免重复保存。

### 2.4 macOS 按键链路（撤销/重做为何要单独接管）

AppKit 在页面 `keydown` 之前先处理原生「编辑」菜单的 key equivalent。实测结论：

1. 菜单里的「撤销/重做」走 responder chain 的 `undo:`/`redo:`，由 WebKit 自己的历史处理，
   与前端自建历史栈不是同一套；`Cmd+Z` 会停在原生这一层，页面根本收不到。
2. NSMenu 匹配字母快捷键时**忽略 Shift**：`Cmd+Shift+Z` 会命中排在前面的「撤销」项，
   表现为「重做变成再撤销一次」。

因此 `MacWebView::ensureWebView()` 安装 `NSEvent addLocalMonitorForEventsMatchingMask:
NSEventMaskKeyDown`，在任何菜单匹配之前分流：

- 仅当 `Command` 按下、无 `Control/Option`、窗口是 key window、且没有模态窗口时接管；
- `Cmd+Z` → `window.mote.undo()`，`Cmd+Shift+Z` / `Cmd+Y` → `window.mote.redo()`；
- 返回 `nil` 吞掉事件，避免再落到原生菜单；
- 其它按键原样放行。监视器在析构时移除。

菜单项「编辑 → 撤销/重做」也接到同一组 `WebEditor::undo()/redo()`，所以菜单点击与
快捷键走同一条路；`Cmd+Shift+Z` 与 `Cmd+Y` 行为一致。

格式类快捷键走另一条路：**必须先在 Qt 菜单里注册 QAction**（`格式` 菜单），
由 AppKit 的 key equivalent 在页面之前消费，再经 `WebEditor::applyFormat(action)`
调 `window.mote.format(name)`。不注册就会出现「system 吞掉 Cmd+B、页面收不到」。
最终取值（`Qt::CTRL` 在 macOS 即 `Cmd`）：

| 动作 | 快捷键 | 动作 | 快捷键 |
| --- | --- | --- | --- |
| 粗体 | `Cmd+B` | 斜体 | `Cmd+I` |
| 行内代码 | `Cmd+Shift+K` | 链接 | `Cmd+K` |
| 标题 1/2/3 | `Cmd+1/2/3` | 正文 | 仅菜单 |
| 无序列表 | `Cmd+Shift+8` | 有序列表 | `Cmd+Shift+7` |
| 引用 | `Cmd+Shift+B` | 代码块 | `Cmd+Shift+C` |
| 表格 | `Cmd+Shift+T` | 分隔线 | 仅菜单 |
| 目录 | `Cmd+Shift+L` | 新建 | `Cmd+N` |

冲突处理：`Cmd+Shift+T` 原来是「目录」，按用户要求让给「表格」，
目录改为 `Cmd+Shift+L`（与系统及其它项均不重叠，`MOTE_KEYLOG=1` 会打印最终菜单表）。
`Cmd+0` 仍是缩放复位，因此「正文」只给菜单项、不占快捷键。

诊断开关（默认关闭，不影响正常使用）：

| 环境变量 | 作用 |
| --- | --- |
| `MOTE_KEYLOG=1` | 打印页面 JS 日志、原生 `keyDown/performKeyEquivalent/undo:/redo:`、Qt 快捷键事件、菜单快捷键表 |
| `MOTE_EVAL=<JS 表达式>` | 文档注入完成后执行一次表达式，结果打到 stderr（只读核对 DOM/状态） |
| `MOTE_SNAPSHOT=<png>` / `MOTE_SNAPSHOT_DELAY=<ms>` | WKWebView 快照路径与延迟（默认 2000ms） |

### 2.5 macOS 原生拖放与图片落盘

网页里的 `drop` 事件只拿得到 `File` 对象，**没有真实路径**，因此 `.md` 拖入无法知道
要打开哪个文件。解法是在原生视图这一层接住拖放：

- `MoteWKWebView`（`WKWebView` 子类）在 `initWithFrame:configuration:` 里
  `registerForDraggedTypes:@[NSPasteboardTypeFileURL]`；
- `draggingEntered:` 从 `draggingPasteboard` 读 `NSURL`（仅 file URL），
  命中 md/图片返回 `NSDragOperationCopy`，否则交给 `super`（文本拖放不受影响）；
- `performDragOperation:` 把路径列表交给 `MacWebView::handleNativeFileDrop`：
  - `.md/.markdown/.mdown/.mkd/.txt` → `emit fileDropRequested(path)`，
    外壳走与菜单打开相同的「未保存确认 → 打开」；
  - 图片 → 复制字节进 `<md 目录>/assets/`，重名自动 `-2/-3`，再
    `window.mote.insertImage("assets/xxx.png")`。
- 网页层仍保留 `drop` 处理作为兜底（图片转 base64 → 原生落盘，md 读文本）。

图片粘贴走 JS 侧 `paste`：`clipboardData.items` 里取 `image/*` 的 `File`，读成
base64 后 `post({type:'image', source:'paste', …})`；原生解码写盘并回调插入。
`insertImage` 在渲染态直接改 `dataset.raw` 再整块重排（图片立即可见），
表格/代码块里改为在其后插入独立段落；源码态插到 `textarea` 选区。
插入前先 `commitHistory()`，所以一次 `Cmd+Z` 撤掉 Markdown，但**不删磁盘文件**。

未保存文档（`m_baseDir` 为空）不落盘，只发 `statusMessage` 明确提示。

### 2.6 为 WebView2 预留

- `WebEditor` 接口不暴露 WKWebView 类型；Windows 实现类只需：
  1. 用 `ICoreWebView2`（Qt 的 `QWindow` 句柄转 HWND）加载同一份 HTML；
  2. 用 `AddScriptToExecuteOnDocumentCreated` 注入 `window.chrome.webview.postMessage` 兼容层，
     或在 JS 里做 `postMessage` 适配（`window.webkit ? ... : window.chrome.webview...`）；
  3. 把 `WebMessageReceived` 映射到同样的 `dirty/save/open/error` 信号。
- 前端不依赖 WebKit 专有 API（除消息发送适配），Windows 侧无需改编辑器逻辑。
- Windows 侧已按上述方式实现（`src/webview_win.cpp`、`src/webview_win_drop.cpp`），并在 Windows 实机验证。

## 3. 前端编辑器模型

### 3.1 唯一数据源与块模型

- 源文本 `source` 是唯一真相；`blocks` 是 `source` 按空行切分的块（围栏代码块、
  表格内部换行不切）。每块保存 `raw`（Markdown 源）与渲染后的 DOM。
- 序列化：`blocks.map(b => b.raw).join("\n\n")`。MVP 对空行数量有归并（连续多个空行
  会压成一个），属于已知降级，后续改为保留原始分隔符。
- 块渲染规则（MVP）：标题、段落、围栏代码（含行号）、表格、有序/无序列表、引用、图片；
  行内支持 `**粗体**`、`*斜体*`、`` `代码` ``、`[链接](url)`、`![图片](src)`。

### 3.2 「当前块显示标记、其余块渲染」

- 每个块是 `contenteditable` 的 `div`。**失焦态**显示渲染结果；
  **聚焦瞬间**把该块内容替换为原始 Markdown 文本（`textContent = raw`），
  于是标题的 `#`、粗体的 `**`、代码围栏的 ``` 都可见可编辑。
- 失焦时把 `raw = textContent` 写回模型并重新渲染该块。
- **输入过程中不重渲染**，只在失焦/回车/结构操作时更新 DOM。这既避免闪烁，
  也是输入法安全的前提。

### 3.3 光标、选区、撤销、输入法

- **输入法（重点）**：组合输入期间绝不读写 DOM、不替换节点。监听
  `compositionstart/compositionend`，组合结束后才重新计算 dirty 与模型。
  contenteditable 由 WebKit 自身提供候选框定位，中文、日文、emoji 均走系统输入法。
- **光标保持**：块内编辑不重建 DOM，光标天然稳定；只有失焦渲染才替换内容，
  此时光标已离开该块。跨块操作（回车分块、退格合并）在操作后显式
  `setCaret(block, offset)`。
- **撤销/重做（已实现，自建栈）**：`editor.js` 维护 `history`（整篇文本快照 + 绝对字符
  偏移）与 `historyIndex`，`Cmd+Z` / `Cmd+Shift+Z`（含 `Ctrl+Z` / `Ctrl+Y`）统一走
  自建栈，并拦截 WebKit 原生 `historyUndo/historyRedo`，避免两套历史打架。
  - 快照统一表示：`{ text, start, end, blocks?, trail }`。`text` 是整篇规范化源文本
    （块间两个换行、末尾换行按原样），`start/end` 是相对整篇的绝对偏移；
    只在所见即所得态额外保留 `blocks`，按需重建。
  - 粒度：连续输入按 600 ms 停顿合并为一步；失焦、回车分块、退格合并、粘贴、
    输入法上屏各自单独成步。
  - 恢复：按当前模式重建——所见即所得态按 `blocks` 挂块，源码态直接写 `<textarea>`；
    选区按绝对偏移映射回块内偏移，撤销后光标不会跳到文档开头。
  - 跨模式：切换「所见即所得 ⇄ 源码」只同步文本与选区，`sameState` 以 `text` 比较，
    不新增步骤；因此在源码态撤销、再切回渲染态，历史与未保存标记都连续。
  - 净化：`suppressEvents` 屏蔽重建期间的事件；块内容未变化时只更新当前步的
    选区，不新增步骤，所以进出原文态/渲染态不会污染历史。
  - 保存：Qt 写盘成功后调用前端 `markSaved(text)` 回填基准；之后撤销会重新变
    「已修改」，重做回保存点则圆点消失。
- **输入法（重点）**：组合输入期间不读写模型、不落历史步骤、不设合并定时器；
  `compositionstart` 先把已有输入收成一步，`compositionend` 再把上屏内容整体
  收成一步，因此候选上屏后一次撤销整体回退，不会被切成多步。
- **受限项**：上下方向键不跨块移动光标（需鼠标点击或后续实现块间导航）；
  Enter 分块、Backspace 块首合并已实现。

### 3.4 格式变换层（快捷键 / 斜杠命令 / 右键「转为」共用）

三个入口只调用 `editor.js` 里同一组函数，不允许各自拼 Markdown 字符串：

| 层 | 函数 | 职责 |
| --- | --- | --- |
| 识别 | `kindOfRaw(raw)` | 判定 `p / h1-h3 / ul / ol / quote / code / table / hr`，判定顺序与 `renderBlock` 一致 |
| 抽取 | `contentOfRaw(raw, kind)` | 剥掉标题 `#`、列表 `-`/`1.`、引用 `>`、代码围栏，得到正文内容 |
| 生成 | `buildBlockRaw(type, content)` | 只加一层前缀；标题把多行用空格并成一行，列表按行加前缀 |
| 单块转换 | `convertRaw(raw, type, toggle)` | `toggle=false`（「转为」）同类型保持不动；`toggle=true`（快捷键/斜杠）同类型回正文 |
| 选区转换 | `convertBlocks(type, toggle)` | 单块、跨块多选、列表回正文拆分都走这里 |
| 行内 | `inlineTransform` / `toggleInline` | `**`、`*`、`` ` ``、`[文字](url)` 的包裹与取消（斜体不会误吃 `**` 的一半） |
| 入口 | `formatAction(name)` | 原生菜单/快捷键传 `bold/h1/codeBlock/...`；斜杠菜单、右键菜单也调它 |

- **切换语义**：`Cmd+1/2/3` 同级别再按回正文；列表/引用/代码块同理（代码块回正文=去围栏）。
  右键「转为」是纯设置语义，已是目标类型时保持不动。
- **多块多选**：列表/引用/代码块会合并成一个块（按行拼接）；标题/正文按块逐个转换；
  列表/引用回正文会逐行拆回独立段落。选区边界落在 `#editor` 本身时按子节点下标取块。
- **光标**：按结构前缀长度差平移（`leadLength`），标题/列表前缀不会把光标挤走；
  合并型转换光标落在末行，代码块落在正文首行，表格落在第一格（`th`）。
- **撤销**：多块/拆分转换用 `commitBatch` 把中间渲染（含块间焦点移动）合成一个历史步，
  一次 `Cmd+Z` 完整还原；斜杠菜单的「删 `/` + 插入」同样是一步。
- **斜杠菜单**：仅空行/行首的 `/` 触发，浮层挂在 `<body>`，查询、上下键、Enter/Tab 插入、
  Esc 关闭并删掉已输入的 `/`；关闭后 `#slash-menu` 不留在 DOM，原文也不含 `/`。
- **右键「转为」**：自建浮层 `#turn-menu`，条目为正文、标题 1/2/3、无序/有序列表、引用、代码块。
- **占位提示**：仅整篇只有一个空块时（`#editor.bare`）用 CSS `::before` 画
  「开始输入，或按 / 插入内容」，伪元素不属于 `textContent`，不会写进 `dataset.raw`。


## 4. 既有能力在新架构下的落点

| 能力 | 新架构方案 | 状态 |
| --- | --- | --- |
| 代码块等宽字体 | qrc 内 JetBrains Mono Light，C++ 读成 base64 注入 `@font-face` | 已实现（权重 300，随缩放） |
| 代码块行号 | `<pre>` 内独立 `.gutter` 栏 + `<code>` 真实换行；行号 `user-select:none`、sticky 固定 | 已实现 |
| 行号不参与复制 | `copy` 事件兜底：克隆选区、删掉 `.gutter` 后写 `text/plain` | 已实现 |
| 代码块背景/行距 | `pre` 背景 `#f4f6f8`，行高 145%（0.85rem × 1.45），长行块内横滚 | 已实现 |
| 语法高亮 | 手写逐行分词（C/C++、Python、JS、JSON、Shell、SQL、HTML），跨行注释/字符串 carry | 已实现 |
| 表格 | 解析 `|` 与分隔行，原生 `<table>` + 边框样式 | 已实现（渲染态；编辑以源码文本进行） |
| 图片相对路径 | `loadFileURL:allowingReadAccessToURL:` + `<base>` 指回 md 所在目录 | 已修复并实测 `naturalWidth=256`（旧 `loadHTMLString` 方案读不到任何本地文件） |
| 图片粘贴/拖入 | JS 取 `image/*` → base64 → 原生写 `<md>/assets/` → `insertImage` | 已实现（重名不覆盖；未保存文档明确拒绝） |
| TOC 侧栏 | 前端按块标题生成多级目录，点击 `scrollIntoView`，滚动时按 80px 判定线高亮当前标题 | 已实现（源码态隐藏） |
| 缩放 | `Cmd+=` / `Cmd+-` / `Cmd+0`，`html` 基准 16.5px × 0.6–2.6（步进 0.1），状态栏显示百分比 | 已实现 |
| 拖拽打开 | `MoteWKWebView` 实现 `NSDraggingDestination`，拿真实路径后交给外壳打开 | 已实现（md/图片；其他类型交回 WebKit） |
| 保存/另存为 | Qt `QFile` + 未保存提示 + `[*]` 改标记 | 已实现并实测写盘；保留原文件末尾换行 |
| 新建文档 | 外壳 `newFile()` → 未保存确认 → `startNewDocument()` → `window.mote.newDocument()`；清空 `m_filePath`/`m_lastText`/`m_dirty`，`baseDir` 置空 | 已实现（Cmd+N / 菜单 / 工具栏；标题「未命名 - Mote」；未命名保存走另存为，保存后 `setBaseDir()` 跟随新路径） |
| 空白占位提示 | 仅单个空块时给 `#editor` 加 `bare`，用 CSS `::before` 画灰字 | 已实现（伪元素不属于 `textContent`，不写进 `dataset.raw`） |
| 另存为记忆目录 | `m_lastDir` 在打开/另存为成功后更新；未命名建议 `m_lastDir/未命名.md` | 已实现（会话内有效；打开对话框也从上次目录起步） |
| 格式快捷键 | 原生「格式」菜单 QAction（AppKit key equivalent）→ `applyFormat()` → `window.mote.format()` | 已实现（取值与冲突见 2.4） |
| 斜杠命令 | 行首 `/` → `#slash-menu`（body 浮层）→ 过滤/上下键/Enter → 同一 `formatAction` | 已实现（12 项；Esc 关闭并删 `/`；菜单节点关闭即移除） |
| 右键「转为」 | 自建 `#turn-menu` → `convertBlocks(type, false)` | 已实现（正文/标题 1-3/无序/有序/引用/代码块；多选合并见 3.4） |
| 源码模式切换 | 同一份 `source` 渲染进 `<textarea>`，切换不新增历史步骤、不改脏标记 | 已实现 |

## 5. 明确降级 / 延后

1. TOC 在源码模式下隐藏（不提供源码态目录联动）；当前标题高亮按渲染块位置计算，
   编辑中的块尚未重排时滚动高亮可能滞后一帧。
2. 源码模式用原生 `<textarea>`：有等宽字体与行内滚动，但不做语法高亮与行号。
3. 撤销/重做覆盖文字输入、删除、回车分块、退格合并、粘贴、输入法上屏，并跨模式连续；
   尚未覆盖表格单元格内的结构化编辑（表格仍以源码文本编辑）。
4. 空行数量归并、上下方向键不跨块。
5. Windows WebView2 已实现并在实机验证；`MOTE_EVAL`/`MOTE_SNAPSHOT`/`MOTE_DROP` 仍是
   macOS 侧工具，Windows 侧用 `MOTE_KEYLOG`（日志以 `WIN ` 前缀区分）。
6. 大文档性能未测：前端为全量重排，未做虚拟滚动。
7. 真实物理键盘的最终行为仍需人工确认的项：`Cmd+C` 实际写入系统剪贴板的内容（脚本无法
   伪造用户手势，已验证的是 `copy` 事件的文本构造结果）。
8. 图片只支持常见位图；未保存文档不落盘（明确提示）；撤销不删除已写入 `assets/` 的文件，
   重做只恢复 Markdown。源码态粘贴只插入文本，切回渲染态才可见。
9. 真实 Finder 拖放与系统剪贴板截图粘贴属人工验证项；自动化用消息通道 / `MOTE_DROP`
   调用同一条原生函数，覆盖的是数据管线，不是 AppKit 拖放会话本身。
10. 隐藏临时页面 `.mote-preview-<pid>.html` 写在文档目录（`loadFileURL` 要求），
    正常退出删除，异常退出可能残留。
11. 新建文档会把目录侧栏关闭、查找条关闭、缩放重置回 100%——这是刻意复位视图状态；
    未命名文档不写 `assets/`（沿用「请先保存 .md 文件」提示），首次保存走另存为后
    才由 `setBaseDir()` 接管图片落盘目录。
12. `Cmd+N` 通过 `QKeySequence::New` 挂在 `QAction` 上，实测用 `osascript` 向系统菜单
    注入按键（与物理按键同一分发路径）；WebView 内没有额外注册 JS 侧快捷键。
13. 斜杠菜单的「图片」只插入 `![](图片路径)` 占位（选中占位文字待替换），不弹文件框；
    真正写入 `assets/` 仍走粘贴/拖入。
14. 行内格式（粗体/斜体/行内代码/链接）对代码块、表格、分隔线不生效，会提示
    「当前块不支持行内格式」；跨块多选时行内格式只作用于选区起始块。
15. 列表/引用转正文会逐行拆成多个段落；代码块转正文保留为单个多行块（不去拆行），
    因为代码行之间可能依赖换行语义。
16. 斜杠菜单按输入事件判定：只有刚键入的 `/` 且位于行首才触发；粘贴进来的 `/`
    或行中间的 `/` 不弹菜单（避免把正文里的斜杠误当命令）。

## 6. 安全与打包

- 前端不访问网络（`WKWebView` 不加载远程 URL），不执行外部脚本，避免 CSP 问题。
- HTML/CSS/JS 全部来自 qrc，打包后不依赖外部文件；WKWebView 为系统框架，
  不增加包体。目标 40 MB 以内，预计与当前 29 MB 包体接近。
- 文件读写仍由 Qt 完成，JS 只拿到文本与 base 目录，不开放任意文件 API。

## 7. MVP 验证记录（2026-11-09，本机 macOS arm64）

| 验证项 | 结果 | 说明 |
| --- | --- | --- |
| 编译 | 通过 | `qmake6` + `make`，无警告级错误；`macwebview.mm` 走 `OBJECTIVE_SOURCES` |
| WKWebView 挂载 | 通过 | Qt 原生子视图内显示，窗口缩放时跟随 |
| 包内资源加载 | 通过 | `:/web/editor.html|css|js` 由 qrc 读出并内联，无外部文件依赖 |
| 打开 .md | 通过 | 启动参数与「打开」按钮均走 `openFile`，标题/正文/状态栏同步 |
| 块级渲染 | 通过 | 标题、段落、行内代码与链接、代码块（含行号）、表格均按渲染态显示 |
| 图片相对路径 | 通过 | 以 md 所在目录为 baseURL，`sample-diagram.png` 正常显示 |
| 保存回原文件 | 通过 | 修改后经 `save` 消息回传，`QSaveFile` 原子写入，磁盘内容与编辑结果一致 |
| 未保存提示 | 通过 | 修改后 macOS 关闭按钮出现圆点（`setWindowModified`） |
| 保存后撤销/重做 | 通过 | 保存 → 撤销后 `dirty=1`（圆点重现），重做回保存点后 `dirty=0` |
| 撤销粒度 | 通过 | 连打 5 字符（100 ms 间隔）合并为一步；暂停后再输入另成一步 |
| 撤销覆盖范围 | 通过 | 文字输入、连续删除、回车分块、退格合并、粘贴、组合输入上屏各有断言 |
| 撤销落点 | 通过 | 撤销后焦点仍在原块原文态，光标落在该步记录的字符偏移（实测 8） |
| 编辑态切换 | 通过 | 在块间来回聚焦/失焦后再撤销，仍只回退最近的输入，未被切换步骤污染 |
| 末尾换行 | 通过 | 保存后保留原文件末尾的换行符 |

撤销的自动化验证方式（12 项断言全部通过）：

- 沿用 `/tmp` 下的**临时验证构建**：在 `editor.js` 尾部追加测试脚本，直接调用
  `document.execCommand('insertText'/'delete')`、派发 `Enter`/`Cmd+Z`/`Cmd+Shift+Z`
  键盘事件与 `paste`、`compositionstart/compositionend` 事件；同时在
  `macwebview.mm` 里把 `dirty`/`save`/`error` 消息打印到 stderr。
- 测试脚本读取 DOM 中的块文本与选区做断言，并把 PASS/FAIL 通过 `error` 消息回传；
  这些补丁只存在于 `/tmp` 的验证副本，**未进入产品源码**。
- 原生日志实测：`save` 后 `dirty 0` → 撤销 `dirty 1` → 重做 `dirty 0`；
  保存后的磁盘文件内容与编辑结果一致。

**这轮合成的 `keydown` 有盲区**：真实物理 `Cmd+Z` 在发布包里完全没反应，而合成事件
全部通过。原因是 AppKit 在页面收到 `keydown` 之前就由原生「编辑」菜单吃掉了按键（见
§2.4）。修复后改用 `NSEvent addLocalMonitorForEventsMatchingMask:` 在菜单之前分流，
并用 `NSApp sendEvent:` 注入按键（与物理按键走同一响应链）复测。

## 8. 第二批能力验证记录（2026-11-09，正常启动路径）

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 代码字体与行距 | 通过 | 计算样式 `JetBrains Mono / 300 / 14.025px / 20.336px`，比值 1.450 |
| 行号栏与分隔线 | 通过 | `.gutter` 颜色 `rgb(154,163,173)`，右侧 `1px rgb(223,228,234)`，随缩放 |
| 行号不进入复制 | 通过 | 全选 `<pre>` 后派发 `copy`：`defaultPrevented=true`，纯文本 247 字符、不含行号 |
| 长行横向滚动 | 通过 | `scrollWidth 1729 > clientWidth 746`，行号栏 sticky 不随横滚 |
| 语法高亮 | 通过 | C++/Python/JS 关键字、类型、函数、字符串、注释、数字分色 |
| TOC 生成与层级 | 通过 | 4 项，h1/h2/h3 逐级缩进 |
| TOC 跳转与高亮 | 通过 | 点击第 3 项后 `scrollY=1186`，active 文本为该标题 |
| 缩放快捷键 | 通过 | 注入 `Cmd+=` ×3 → 1.3；`Cmd+-` ×2 → 0.8；`Cmd+0` → 1.0；上限 2.6 = 42.9px |
| 源码模式切换 | 通过 | 切换后 `mode=source`、文本一致、`dirty=false`（切换不产生步骤） |
| 源码编辑 / 撤销 / 重做 | 通过 | 源码内改动 `dirty=true` → 撤销内容还原且 `dirty=false` → 重做 `dirty=true` |
| 跨模式历史连续 | 通过 | 撤销后切回所见即所得：`blocks=14`、`dirty=false`，未新增历史步 |

自动化手段说明：

- 状态与 DOM 用 `MOTE_EVAL` 探针读取（同一页面上下文，非模拟 UI）。
- 快捷键用 `NSApp sendEvent:` 注入，与物理按键同一入口（菜单/响应链/本地监视器）；
  上一轮的教训是**不能用 DOM 合成 `keydown` 证明快捷键可用**。
- 仍只能人工验证：真实 `Cmd+C` 落到系统剪贴板的最终内容（脚本无法获得用户手势）。

仍需人工确认的部分（如实说明）：

- 真实鼠标点击进入编辑、真实键盘逐字输入：本机未授予终端「辅助功能」权限，
  未做真实事件注入；上述用 `execCommand` 走的是同一条编辑/输入事件链路，
  但不是物理键盘。
- 真实中文输入法的候选窗、联想与上屏：只用合成 `CompositionEvent` 验证了
  「上屏整体一步撤销」，候选窗定位与多段组合需要人工用系统输入法确认。

