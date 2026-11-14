# Mote

**C++20 原生薄外壳 + 系统 WebView 的 Markdown 查看 / 编辑器：macOS 用 AppKit + WKWebView（发布包不含 Qt），Windows 用 Win32 + WebView2；正文的渲染与编辑交给系统 WebView，前端零框架、零构建，不引入 Electron 一类运行时。两端共用 `core/` 与同一份前端资源。**

## 功能

按当前实际已实现的能力（macOS 与 Windows 原生外壳均已实机验收，仍有 mac 对照等缺口，见 [阶段 B 验收记录](docs/thin-shell-stage-b-acceptance.md)；Windows 上快捷键把 `Cmd` 换成 `Ctrl`）：

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
- **深色模式**：默认跟随系统外观（macOS 读 `NSApp.effectiveAppearance`，Windows 读注册表 `AppsUseLightTheme` 并响应 `WM_SETTINGCHANGE`），也可用「视图 → 深色模式」(`Cmd+Shift+D`) 手动切换；手动切换后可用「跟随系统外观」交回系统。切换只换配色，不改文档内容、块几何与编辑状态。
- **链接**：渲染态下 `[文字](地址)` 的文字显示为蓝色带下划线的链接（地址本身仍是零宽标记，不占位、不进入框选复制）；普通点击仍进入编辑态，`Cmd+Click` 才跳转——外部链接交给系统默认浏览器，相对路径的 `.md` 在应用内打开（走未保存确认），文件不存在时弹提示不崩。编辑态显示原始 `[文字](地址)`，复制出去是标准 Markdown。
- **导出 HTML**：`Option+Cmd+E`（「文件 → 导出 HTML…」）导出单文件自包含 HTML——样式内联、图片转 base64 内嵌、代码高亮与任务复选框状态保留，导出过程不改动原文档与 `dataset.raw`。
- **导出 PDF**：`Cmd+P`（「文件 → 导出 PDF…」）导出 A4 多页、无页眉页脚；源码模式下禁用。macOS 与 Windows 均已实现，两端分页切点由各自 WebView 引擎决定，未做逐页像素比对。
- **页面内状态栏**：原生外壳把状态栏画在前端页面底部（`body.platform-mac` / `body.platform-win`），显示打开/保存/导出提示与字数统计；Qt 构建不启用，避免出现两条状态栏。
- **目录手型光标**：鼠标移到目录栏（条目文字行、行间空隙、栏内空白）都是系统手型指针，避免移动时手型闪烁；折叠按钮与滚动条保留自身光标语义。

## 构建与运行（macOS）

依赖：

- macOS 14 及以上（Apple Silicon，arm64）；CMake 目标为 `-mmacosx-version-min=14.0`
- Xcode Command Line Tools
- CMake 3.25+
- **不需要 Qt**

构建：

```bash
cmake -S native -B build-native
cmake --build build-native
ctest --test-dir build-native                    # core 单测，无需 GUI

open build-native/Mote.app                       # 或直接运行
./build-native/Mote.app/Contents/MacOS/Mote 文档.md
```

一键打包（构建 + Ad-hoc 签名 + zip/DMG + 依赖自检）：

```bash
bash packaging/package_macos.sh --native --dmg
# 产物：dist/Mote-macOS-native.zip / dist/Mote-macOS-native-*.dmg
# 当前体积：.app 约 1.2 MB，DMG 约 579 KB
```

`tools/preflight.sh --native` 可在干净构建后跑一次启动冒烟。

### Windows 原生外壳（默认发布路径）

需要 VS2022（C++ 桌面开发）、CMake ≥ 3.25、WebView2 SDK（`WEBVIEW2_SDK`）与 Evergreen Runtime。从零装机的完整步骤（Build Tools 组件 ID、静默安装、各项验证命令）见 [docs/windows-native-build-setup.md](docs/windows-native-build-setup.md)。

```bat
set WEBVIEW2_SDK=C:\dev\webview2sdk\pkg
cmake -S native -B build-native-win -A x64
cmake --build build-native-win --config Release
```

用 Ninja 时：`cmake -S native -B build-native-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build-native-ninja`，产物在 `build-native-ninja\`。

打包（产物 `dist/Mote-Windows/` 与 `dist/Mote-Windows.zip`，不含 Qt）：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\package_windows_native.ps1
```

验收项、实测结论与仍未覆盖的项（干净机、IME 组词、mac 截图对照）见
[docs/thin-shell-stage-b-acceptance.md](docs/thin-shell-stage-b-acceptance.md)；
打包细节见 [packaging/PACKAGING.md](packaging/PACKAGING.md) 第 6 节。

Windows 已知限制：文件相关快捷键里 `Ctrl+Shift+S`（另存为）与 `Ctrl+Alt+E`（导出 HTML）会被 WebView2/系统层先吃掉，编辑区按不出效果，用「文件」菜单或工具栏对应项；其余 `Ctrl+S/O/P/…`、`Ctrl+Shift+L/D`、`Ctrl+/` 正常。

### Qt 构建（保留的对照/回退路径）

仓库根的 `Mote.pro` 与 `src/` 仍可构建，用于与原生外壳对照或在 Windows 原生验证未完成时兜底：

```bash
qmake6 Mote.pro && make -j4
```

Qt 构建与原生构建共用 `resources/web/` 与 `core/`；版本号仍以 `Mote.pro` 的 `VERSION` 为唯一来源。Qt 版 macOS 打包为 `bash packaging/package_macos.sh`（不带 `--native`）；Windows 的 Qt 打包保留为回退，步骤见 [packaging/WINDOWS-FROM-MACOS.md](packaging/WINDOWS-FROM-MACOS.md)。

## 快捷键

macOS 用 `Cmd`；Windows 把 `Cmd` 换成 `Ctrl`（`Option` 换成 `Alt`）。

| 分组 | 快捷键 | 作用 |
| --- | --- | --- |
| 文件 | `Cmd+N` / `Cmd+O` / `Cmd+S` / `Cmd+Shift+S` | 新建 / 打开 / 保存 / 另存为 |
| 文件 | `Option+Cmd+E` | 导出 HTML（自包含单文件） |
| 文件 | `Cmd+P` | 导出 PDF（A4 多页；源码模式下禁用） |
| 编辑 | `Cmd+Z` / `Cmd+Shift+Z` | 撤销 / 重做 |
| 编辑 | `Cmd+C` / `Cmd+X` / `Cmd+V` | 复制 / 剪切 / 粘贴 |
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

- **仅 arm64**：macOS 包只含 arm64 切片，Intel Mac 需自行重新构建。
- **Ad-hoc 签名、未公证**：从网络下载的 zip 首次打开可能被 Gatekeeper 拦截，需右键「打开」。
- **macOS 包不含 Qt**：`.app` 约 1.2 MB，DMG 约 579 KB；主要体积来自应用自身与内联字体，WebKit 由系统提供。
- **源码模式无语法高亮**：`Cmd+E` 下是纯文本编辑区。
- **查找/替换不跨块**：可以在所有块之间跳转命中，但单个命中不会跨越块边界或行内标记。
- **上下方向键不跨块**：跨块移动光标需鼠标点击。
- **深色模式只覆盖正文区域**：网页侧（正文、标题、引用、表格、行内代码、代码块与语法高亮、目录、查找高亮、斜杠浮层）全部跟随主题；状态栏在深色下单独上色。菜单栏仍是系统原生外观，不随文档主题变化。
- **链接只支持两种跳转**：`Cmd+Click` 外部链接（http/https/mailto）与相对路径的 `.md`；**锚点链接**（`#标题`）因为没有生成标题锚点，只在状态栏提示「暂不支持」；**图片**按 `img` 渲染，没有 `<a>` 包裹，`Cmd+Click` 不触发任何跳转（相对路径图片仍按文档目录正常显示与导出内嵌）。
- **导出 HTML 是「网页快照」**：单文件、无外部依赖、无脚本；导出后不提供任何交互（链接仍可点，但任务复选框是静态图形）。
- **导出能力按平台分阶段**：macOS 已支持 PDF（CGPDFContext 分段抓取 + A4 拼页）与 HTML；Windows 原生外壳的导出仍是占位，计划在 N4 实现。
- **Windows 原生外壳未完成验收**：N0–N3 代码已入库，但尚未在真实 Windows 上编译/运行验证；验证清单见 [docs/windows-handoff-n1.md](docs/windows-handoff-n1.md)。
- **任务复选框的复制**：复制处理器剔除隐藏标记；脚本用 `DataTransfer` 走产品同一条 `copy` 处理逻辑验证，真实 `Cmd+C` 写入系统剪贴板的最终结果仍需人工确认。
- 目录在源码模式下隐藏；正在编辑的块在重排前标题高亮可能滞后一帧。

## 目录结构

```
native/CMakeLists.txt    原生构建入口：读 Mote.pro 版本号，按平台生成 target
core/                    无 Qt、无平台 API 的共享核心
  json / base64 / paths  协议解析、图片解码、路径与 file:// 目录
  js_bridge              外壳 → 页面的脚本片段
  editor_controller      页面代次、ready 缓存、消息分发、脏标记
  image_store            assets/ 落盘与重名处理
  command_table          菜单唯一来源
  inject_chunks          大文档分片切分（UTF-8 安全）
platform/mac/            AppKit + WKWebView：窗口、菜单、对话框、PDF/HTML、拖放
platform/win/            Win32 + WebView2：N0–N3，待实机验证
resources/
  web/                   前端编辑器（editor.html / editor.css / editor.js，唯一一份）
  fonts/                 JetBrains Mono（Light）与 OFL.txt
  icons/  styles/        应用图标与 Qt 样式表
  samples/               内置示例文档与示例图
  win/                   Windows 资源脚本（图标）
  resources.qrc          Qt 构建的资源清单
src/                     Qt 外壳（保留的对照/回退路径）
Mote.pro                 qmake 工程；VERSION 是版本号唯一来源
packaging/               打包脚本（原生 / Qt / Windows）与交付文档
docs/                    架构、设计与验收文档
screenshots/             文档引用的截图
backup/                  迁移前的旧 Qt 文本引擎快照（不参与构建）
```

## 文档

- [docs/技术方案.md](docs/技术方案.md)：N3 后的实际架构、方案 A/B 取舍与实施状态
- [docs/thin-shell-stage-a.md](docs/thin-shell-stage-a.md) / [docs/thin-shell-stage-b.md](docs/thin-shell-stage-b.md)：macOS / Windows 薄外壳设计与里程碑
- [docs/thin-shell-stage-a-acceptance.md](docs/thin-shell-stage-a-acceptance.md)：macOS 原生外壳验收记录（体积、依赖、行为）
- [docs/windows-handoff-n1.md](docs/windows-handoff-n1.md)：Windows 实机验证交接单
- [packaging/PACKAGING.md](packaging/PACKAGING.md)：打包、产物、干净环境验证与逐项验收记录
- [docs/WEBVIEW-ARCHITECTURE.md](docs/WEBVIEW-ARCHITECTURE.md)：分层、消息协议、按键链路与前端块模型
- [packaging/WINDOWS-FROM-MACOS.md](packaging/WINDOWS-FROM-MACOS.md)：在 Windows 上构建的步骤与注意事项
- [docs/COLLAB.md](docs/COLLAB.md)：macOS + Windows 双机协作（clone、分工、冲突、Windows 环境）
- [tools/preflight.sh](tools/preflight.sh) / [tools/preflight.bat](tools/preflight.bat)：本机自检（仓库状态 → 独立目录构建 → macOS 启动冒烟）
- [docs/DECISIONS.md](docs/DECISIONS.md)：架构与交互的决策记录（接手前先读）
- [分支命名与归属](docs/DECISIONS.md#四分支命名与归属)：平台专属分支、共享层改动与跨平台提交的归属约定

## 第三方与许可

- **系统 WebKit**：macOS 自带框架，不随包分发。
- **WebView2 Runtime**：Windows 由系统/用户安装的 Evergreen Runtime 提供，不随包分发。
- **Qt 6**：仅用于保留的对照/回退构建，LGPLv3、动态链接；macOS 原生发布包不含 Qt。
- **JetBrains Mono**：SIL Open Font License 1.1；仓库内 [resources/fonts/OFL.txt](resources/fonts/OFL.txt)，
  发布包内 `licenses/JetBrainsMono-OFL.txt`。

## 许可证

Mote 以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 [LICENSE](LICENSE)。

自 v0.3.0 起采用 AGPL-3.0；更早的版本为 GPL-3.0，已发布版本的授权不受影响。
