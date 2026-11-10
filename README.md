# Mote

**C++20 + Qt 6 的 Markdown 查看 / 编辑器：窗口、菜单、文件读写由 Qt 负责，正文的渲染与编辑交给系统 WebView（macOS 用 WKWebView，Windows 用 WebView2），不引入任何前端框架或运行时；两端都支持系统级拖放，Windows 安装包会注册 `.md` 文件关联。**

## 功能

按当前实际已实现的能力（macOS）：

- **所见即所得块编辑**：正文按空行切块，点击某块即就地显示该块的 Markdown 原文，其余块保持排版效果；离开该块后按原文重新渲染。
- **代码块**：围栏代码块带语法高亮（内置轻量高亮，无第三方解析/高亮库）、左侧行号与语言徽标；点击徽标可改语言。
- **表格与分隔线**：表格就地编辑（单元格、分隔行、对齐），分隔线可直接选中修改。
- **目录（TOC）**：由标题生成，点击跳转；`Cmd+Shift+L` 开关。
- **查找替换（`Cmd+F`）**：可跨块跳转；一个命中不会跨越块边界或行内标记，替换不会破坏标记结构——跨标记、含换行、表格里的 `|`、代码里的 ``` 等替换会被拒绝并在查找条上说明原因。
- **缩放**：`Cmd+=` / `Cmd+-` / `Cmd+0`。
- **源码模式**：`Cmd+E` 在渲染态与纯文本 Markdown 之间切换。
- **图片**：粘贴或拖入图片会落盘到 Markdown 同目录的 `assets/`，并插入相对路径；相对路径图片按文档所在目录解析。
- **新建**：`Cmd+N`；当前文档有未保存修改时先询问「保存 / 不保存 / 取消」。
- **快捷键与斜杠命令**：见下。
- **块类型转换**：右键任意块弹出「转为」，支持正文、标题 1–3、无序/有序列表、引用、代码块；多选可合并成一个列表。
- **任务列表**：`- [ ]` / `- [x]`（`*`、`+` 作列表符号、缩进子项同样支持）渲染成可点击复选框；点击即改写原文的 `[ ]`／`[x]`，一次撤销可还原。复选框不进入框选复制的文本，复制出去仍是标准 Markdown 任务列表；编辑态下任务标记是可见文本，可直接用键盘改。
- **字数统计**：状态栏右侧显示「中文 N 字 · 英文 M 词」。中文按 CJK 字符逐个计数（含扩展 A 区与兼容区），英文按「连续字母/数字算一个词、词内可含 `'`／`-`／`’`」计数；代码块正文计入、围栏与行号不计。
- **深色模式**：默认跟随系统外观（`QStyleHints::colorScheme`），也可用「视图 → 深色模式」(`Cmd+Shift+D`) 手动切换；手动切换后可用「跟随系统外观」交回系统。切换只换配色，不改文档内容、块几何与编辑状态。
- **链接**：渲染态下 `[文字](地址)` 的文字显示为蓝色带下划线的链接（地址本身仍是零宽标记，不占位、不进入框选复制）；普通点击仍进入编辑态，`Cmd+Click` 才跳转——外部链接交给系统默认浏览器，相对路径的 `.md` 在应用内打开（走未保存确认），文件不存在时弹提示不崩。编辑态显示原始 `[文字](地址)`，复制出去是标准 Markdown。
- **导出 HTML**：`Option+Cmd+E`（「文件 → 导出 HTML…」）导出单文件自包含 HTML——样式内联、图片转 base64 内嵌、代码高亮与任务复选框状态保留，导出过程不改动原文档与 `dataset.raw`。
- **目录手型光标**：鼠标移到目录栏（条目文字行、行间空隙、栏内空白）都是系统手型指针，避免移动时手型闪烁；折叠按钮与滚动条保留自身光标语义。

## 构建与运行（macOS）

依赖：

- macOS 14 及以上（Apple Silicon，arm64）；构建目标为 `-mmacosx-version-min=14.0`，更早的系统未经测试
- Qt 6.x（开发时使用 Homebrew 的 6.11.1，要求 `qmake6` 与 `macdeployqt` 在 `PATH` 中）
- Xcode Command Line Tools（`make`、`codesign`、`iconutil`、`strip`）

构建：

```bash
qmake6 Mote.pro && make -j4
open ./Mote.app                       # 或直接运行
./Mote.app/Contents/MacOS/Mote 文档.md  # 带参数打开文件
```

设置 `MOTE_LEGACY_QT=1` 可回退到迁移前的纯 Qt 文本引擎实现，仅用于对照排查。

一键打包（影子构建 + `macdeployqt` + Ad-hoc 签名 + zip）：

```bash
bash packaging/package_macos.sh
# 产物：dist/Mote-macOS.zip（含 Mote.app、samples/、licenses/）
```

Windows 打包脚本已提供（`packaging/package_windows.bat`），但宿主层未实现，详见
[packaging/WINDOWS-FROM-MACOS.md](packaging/WINDOWS-FROM-MACOS.md)。

## 快捷键

| 分组 | 快捷键 | 作用 |
| --- | --- | --- |
| 文件 | `Cmd+N` / `Cmd+O` / `Cmd+S` / `Cmd+Shift+S` | 新建 / 打开 / 保存 / 另存为 |
| 文件 | `Option+Cmd+E` | 导出 HTML（自包含单文件） |
| 编辑 | `Cmd+Z` / `Cmd+Shift+Z` | 撤销 / 重做 |
| 编辑 | `Cmd+F` | 查找替换条 |
| 格式 | `Cmd+B` / `Cmd+I` / `Cmd+K` / `Cmd+Shift+K` | 粗体 / 斜体 / 链接 / 行内代码（再按一次取消） |
| 格式 | `Cmd+1` / `Cmd+2` / `Cmd+3` | 标题 1/2/3（同级别再按回正文） |
| 格式 | `Cmd+Shift+8` / `Cmd+Shift+7` | 无序 / 有序列表 |
| 格式 | `Cmd+Shift+B` / `Cmd+Shift+C` / `Cmd+Shift+T` | 引用 / 代码块 / 表格 |
| 视图 | `Cmd+Shift+L` | 目录开关 |
| 视图 | `Cmd+E` | 源码模式 |
| 视图 | `Cmd+Shift+D` | 深色模式开关（手动切换会退出「跟随系统外观」） |
| 视图 | `Cmd+=` / `Cmd+-` / `Cmd+0` | 放大 / 缩小 / 实际大小 |

斜杠命令：行首输入 `/` 弹出命令面板，输入过滤，`↑`/`↓` 选择，`Enter` 插入，`Esc` 取消。
右键「转为」：正文、标题 1–3、无序/有序列表、引用、代码块。

## 已知限制

- **Windows 宿主层未实现**：非 macOS 下 `createWebEditor()` 返回 `nullptr`，外壳能启动并给出提示，但正文不渲染。
- **仅 arm64**：macOS 包只含 arm64 切片，Intel Mac 需自行重新构建。
- **Ad-hoc 签名、未公证**：从网络下载的 zip 首次打开可能被 Gatekeeper 拦截，需右键「打开」。
- **包体积主要来自 Qt ICU**：`libicudata` 约 32 MB，压缩后整个 zip 约 30 MB。
- **源码模式无语法高亮**：`Cmd+E` 下是纯文本编辑区。
- **查找/替换不跨块**：可以在所有块之间跳转命中，但单个命中不会跨越块边界或行内标记。
- **上下方向键不跨块**：跨块移动光标需鼠标点击。
- **深色模式只覆盖正文区域**：网页侧（正文、标题、引用、表格、行内代码、代码块与语法高亮、目录、查找高亮、斜杠浮层）全部跟随主题；状态栏在深色下单独上色。工具栏与菜单栏仍是系统原生外观，不随文档主题变化。
- **链接只支持两种跳转**：`Cmd+Click` 外部链接（http/https/mailto）与相对路径的 `.md`；**锚点链接**（`#标题`）因为没有生成标题锚点，只在状态栏提示「暂不支持」；**图片**按 `img` 渲染，没有 `<a>` 包裹，`Cmd+Click` 不触发任何跳转（相对路径图片仍按文档目录正常显示与导出内嵌）。
- **导出 HTML 是「网页快照」**：单文件、无外部依赖、无脚本；导出后不提供任何交互（链接仍可点，但任务复选框是静态图形）。
- **不提供导出 PDF**：`WKWebView` 的 `createPDFWithConfiguration:`（macOS 11+）配置只有 `rect`，只能出**单张长页**、无法分页；唯一的分页路径 `printOperationWithPrintInfo:` 在本机（macOS 26.2）三种参数组合下都会失控——20 秒内写出 408–982 MB 且不返回，只能杀进程。因此不做半成品，详见 [packaging/PACKAGING.md](packaging/PACKAGING.md) 的评估记录。
- **任务复选框的复制**：复制处理器剔除隐藏标记；脚本用 `DataTransfer` 走产品同一条 `copy` 处理逻辑验证，真实 `Cmd+C` 写入系统剪贴板的最终结果仍需人工确认。
- 目录在源码模式下隐藏；正在编辑的块在重排前标题高亮可能滞后一帧。

## 目录结构

```
Mote.pro                 qmake 工程（C++20，Release）
src/                     Qt 外壳与 WebView 桥接
  main.cpp               入口；默认 WebWindow，MOTE_LEGACY_QT=1 回退旧引擎
  webwindow.*            新架构主窗口：菜单、文件对话框、保存、拖拽
  webview.h              WebView 抽象接口
  macwebview.mm          macOS WKWebView 实现
  webview_stub.cpp       Windows / Linux 占位（当前返回 nullptr）
  mainwindow.*           旧 Qt 文本引擎主窗口（仅回退用）
  previewview.*          旧 Qt 文本引擎的预览视图（仅回退用）
  codehighlighter.*      旧 Qt 文本引擎的代码着色（仅回退用）
resources/
  web/                   前端编辑器（editor.html / editor.css / editor.js）
  fonts/                 JetBrains Mono（Light / Regular / Bold）与 OFL.txt
  icons/  styles/        应用图标与 Qt 样式表
  samples/               内置示例文档与示例图
  win/                   Windows 资源脚本（图标）
  resources.qrc          以上资源全部编进可执行文件
packaging/               打包脚本（macOS / Windows）与交付文档
docs/                    架构文档
screenshots/             文档引用的截图
backup/                  迁移前的旧 Qt 文本引擎快照（不参与构建，仅作历史参考）
```

## 文档

- [packaging/PACKAGING.md](packaging/PACKAGING.md)：打包、产物、干净环境验证与逐项验收记录
- [docs/WEBVIEW-ARCHITECTURE.md](docs/WEBVIEW-ARCHITECTURE.md)：分层、消息协议、按键链路与前端块模型
- [packaging/WINDOWS-FROM-MACOS.md](packaging/WINDOWS-FROM-MACOS.md)：在 Windows 上构建的步骤与注意事项
- [docs/COLLAB.md](docs/COLLAB.md)：macOS + Windows 双机协作（clone、分工、冲突、Windows 环境）
- [tools/preflight.sh](tools/preflight.sh) / [tools/preflight.bat](tools/preflight.bat)：本机自检（仓库状态 → 独立目录构建 → macOS 启动冒烟）
- [docs/DECISIONS.md](docs/DECISIONS.md)：架构与交互的决策记录（接手前先读）

## 第三方与许可

- **Qt 6**：LGPLv3，动态链接；发布包内为独立框架，可替换。
- **JetBrains Mono**：SIL Open Font License 1.1；仓库内 [resources/fonts/OFL.txt](resources/fonts/OFL.txt)，
  发布包内 `licenses/JetBrainsMono-OFL.txt`。
- **系统 WebKit**：macOS 自带框架，不随包分发。

## 许可证

Mote 以 **GNU General Public License v3.0（GPL-3.0）** 发布，完整条文见仓库根目录的 [LICENSE](LICENSE)。
