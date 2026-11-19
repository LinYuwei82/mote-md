# Mote · 打包与交付说明

本工程是一个 C++20 原生薄外壳（macOS：AppKit + WKWebView；Windows：Win32 + WebView2）的
Markdown 查看/编辑桌面程序，不链接 Qt。
本文档说明打包方式、产物位置，以及在两个平台上的实际执行情况。

| 平台 | 状态 | 产物 |
| --- | --- | --- |
| macOS（本机，已执行） | 已完成并验证 | `dist/Mote-macOS-native.zip`（内含 `.app`）、`dist/Mote-macOS-native-<版本>.dmg` |
| Windows（由 Windows 机器执行） | 已构建并校验，本机未复现 | `dist/Mote-Windows.zip` |

> 本机为 macOS，Windows 产物由 Windows 机器按第 6 节的脚本构建并校验，
> 本机未重复执行该流程。
>
> 第 1.4–1.14 节是 **Qt 构建时代**（2026-11-10 前后）的实测记录，保留作历史；
> Qt 构建路径已在 2026-11-19 删除，当前打包方式以 1.1–1.3 与第 6 节为准。

---

## 1. macOS：已实际执行并验证

### 1.1 环境

- macOS 14 及以上（Apple Silicon，arm64）；更早的系统未经测试
- Xcode Command Line Tools（提供 `codesign`、`strip`）
- CMake 3.25+（`native/` 是唯一的构建入口）
- 不需要额外 SDK：WebKit、AppKit 都由系统提供
- 工程目录：`/Users/lin/Projects/mote`（不在 iCloud 同步范围，避免每次构建都触发同步）

### 1.2 一键打包

```bash
bash packaging/package_macos.sh          # 只产出 zip
bash packaging/package_macos.sh --dmg    # 额外产出一个拖拽安装式 DMG
```

脚本依次完成：

1. 在 **临时目录**（`$TMPDIR/mote-build-native`）做影子构建，避免 iCloud「文稿」目录的
   FinderInfo 扩展属性导致 `codesign` 报 `resource fork, Finder information ... not allowed`；
2. `cmake -S native` + 构建（Release，C++20）；
3. 依赖自检：可执行文件不得链接 Qt；
4. `strip` 调试符号、删除包内指向 `/opt/homebrew`、`/usr/local` 的 rpath、
   清理扩展属性并做**全包外部路径自检**；
5. **Developer ID 签名 + 公证**（找不到证书时 fallback 到 ad-hoc，见 1.5）；
6. 在临时目录组装 `Mote-macOS-native/`（含 `.app`、`samples/` 与字体授权 `licenses/`）
   并 `ditto` 压缩成 zip；
7. 带 `--dmg` 时，再组装一个只含 `Mote.app` 与 `Applications` 替身的暂存目录，
   用 `hdiutil create -format UDZO -fs HFS+` 打成 `Mote-macOS-native-<版本>.dmg`。

### 1.3 产物

```
dist/Mote-macOS-native.zip
└── Mote-macOS-native/
    ├── Mote.app/                   # 只含系统框架，无第三方运行时
    ├── licenses/
    │   ├── JetBrainsMono-OFL.txt             # 内置代码字体的 SIL OFL 授权
    │   └── LICENSE-AGPL-3.0.txt              # 项目自身的 AGPL-3.0 全文
    └── samples/
        ├── welcome.md
        └── sample-diagram.png

dist/Mote-macOS-native-<版本>.dmg
└── Mote（挂载后的卷）
    ├── Mote.app                    # 与 zip 里同一个 app
    └── Applications -> /Applications          # 拖进去即安装
```

- 当前体积：`.app` 约 4.1 MB（含 Sparkle.framework），DMG 约 1.7 MB
- 可执行文件架构：`arm64`（Apple Silicon 原生，Intel 机器不可直接运行）
- Bundle ID：`com.mote.Mote`
- 版本号读自仓库根 `VERSION.txt`，由 CMake 填进 `Info.plist`

### 1.4 干净环境验证（已实际执行）

> 说明：1.4–1.14 的验证记录产生于 **Qt 构建时代**（Qt 外壳 + `src/` 实现）。
> 2026-11-19 起 Qt 构建路径已删除，产物统一由 `native/` 的 AppKit + WKWebView 外壳产出；
> 这些记录保留作历史，当前口径见 1.1–1.3 与 README。

把 zip 解压到全新临时目录 `/tmp/clean-test`，在**不设置任何 Qt 环境变量**的终端里
直接启动 `.app` 内的可执行文件，并使用 `samples/welcome.md` 验证：

| 验证项 | 结果 | 说明 |
| --- | --- | --- |
| 解压 | 通过 | `ditto -x -k` 解压，结构完整 |
| 外部依赖 | 通过 | 扫描包内所有 Mach-O，无 `/opt/homebrew`、`/usr/local` 绝对依赖 |
| 签名校验 | 通过 | `codesign --verify --deep --strict` 无输出 |
| 双击启动 | 通过 | `open Mote.app`（等同 Finder 双击）正常启动 |
| 文件对话框打开 | 通过 | `Cmd+O` → 前往文件夹 → 选中 `samples/welcome.md`，标题、正文、目录同步更新 |
| 渲染 | 通过 | 标题/段落/粗斜体/列表/代码块（等宽+浅底）/表格（边框+表头）/图片均正常 |
| 代码高亮 | 通过 | `samples/welcome.md` 内 C++、Python、JavaScript、JSON、HTML、Shell、SQL、CMake 代码块分别按语言着色：关键字红、字符串深蓝、注释灰、数字蓝、函数紫、类型棕；**每个代码块的首行也正常着色**（见 1.9） |
| 代码字体 | 通过 | 代码块为随包内置的 JetBrains Mono **Light(300)**，行内代码为 Regular；均无需系统安装。字体加载失败时回退 Menlo / SF Mono / 系统等宽，已临时屏蔽加载实测无方块、无报错 |
| 代码块行号 | 通过 | 行号在左侧独立栏、右对齐，弱化灰色；与逻辑行一一对应，长行横向滚动时不重复编号；选中复制不带行号（见 1.9） |
| 行号分隔线 | 通过 | 行号与代码之间有 1px 浅灰竖线，随缩放比例移动，纵向从内容区上端贯穿到下端，不溢出浅灰底 |
| 字号与字重 | 通过 | 正文 16.5pt、PingFang SC ExtraLight；标题 Bold/DemiBold 层级清晰；工具栏、目录侧栏、状态栏同步放大，未出现比例失调 |
| 代码块行距 | 通过 | 行高 145%、末行 112%，背景由 frame 承载无断层；首行距顶 14pt、末行距底 15.5pt（详见 1.8） |
| 字体重叠排查 | 通过 | 100% / 121% / 260% 三档渲染中英混排样张，正文、各级标题、行内代码、代码块、表格、TOC、编辑区均无字符挤压或上下行粘连（原生 2× 截图逐处核对） |
| 无标识代码块 | 通过 | 未写语言标识的围栏只保留等宽字体与浅灰底，不做任何着色 |
| 编辑模式 | 通过 | `Cmd+E` 后为纯文本（无高亮），再切回预览时代码高亮与缩放比例都保持 |
| 图片相对路径 | 通过 | 以 md 所在目录为基准解析 `sample-diagram.png` |
| 目录（TOC） | 通过 | 自动生成多级目录；点击「支持的排版元素」后正文跳转到该章节 |
| 滚动 | 通过 | PageDown 正常滚动 |
| 缩放 | 通过 | `Cmd+=` 两次后状态栏显示「缩放：121%」，字号变大且左侧目录/工具栏布局不变 |
| 编辑 | 通过 | `Cmd+E` 切到源码编辑（等宽字体），工具栏「编辑」高亮 |
| 保存 | 通过 | 粘贴内容后 `Cmd+S`，磁盘文件内容确认已写入，状态栏提示「已保存：…」 |
| 运行输出 | 通过 | 标准输出/错误为空，无 Qt 插件或库加载报错 |
| 大文档打开 | 通过 | 170 KB / 4521 块 / 76 个代码块的真实文档副本，打开到可交互约 0.12 s（优化前 7.97 s），详见 1.6 |

验证结论：**macOS 包可以解压后直接双击运行，无需安装 Qt，也无需配置环境变量。**

### 1.5 macOS 使用注意事项

- **首次打开**：Ad-hoc 签名未做公证。若 zip / dmg 是通过网络（浏览器/AirDrop）传到别的机器，
  Gatekeeper 会提示「无法验证开发者」，此时右键 →「打开」即可；或执行：
  `xattr -dr com.apple.quarantine /path/to/Mote.app`（DMG 分发见 1.14）
- **文件与文件夹权限**：打开位于「文稿」「桌面」「下载」等受保护目录中的 md 时，
  macOS 可能弹一次「想访问…文件夹」的授权框，允许即可（系统行为，与程序无关）。
- **架构**：仅 arm64。要支持 Intel Mac，需要在 Intel 机器或 `arch -x86_64` 环境下
  用同一脚本重新构建（或改用通用二进制方案）。
- **改名后显示名仍是旧的（LaunchServices 缓存）**：应用已从「Markdown 查看器」更名为
  Mote（`CFBundleName`/`CFBundleDisplayName`/`CFBundleExecutable` 均为 `Mote`，
  Bundle ID 为 `com.mote.Mote`）。若 Finder、程序坞或「打开方式」里仍显示旧名，
  是 LaunchServices 缓存导致的，按以下顺序处理：
  1. 删掉旧的 `.app`（尤其是还留在「下载」「桌面」里的旧副本），只保留 `dist/` 里新解压的 `Mote.app`；
  2. 刷新缓存：`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /path/to/Mote.app`；
  3. 必要时 `killall Dock`（或注销/重启）让程序坞重建；
  4. 只重新打包不改 Bundle ID 时也会命中缓存，以上步骤同样适用。
- 更换图标后重新生成资源：`python3 tools/make_icon.py`（仅用 Python 标准库 +
  macOS 自带 `iconutil`）。

### 1.6 打开性能（本机实测）

测量样本（均为副本，未改动原件）：

- 小文档：`resources/samples/welcome.md`，3.9 KB / 123 个块。
- 大文档：一份真实的学习记录 170 KB / 4946 行 / 4521 个块 / 76 个代码块
  （C++、Bash、Python、CMake），打开后文档高度约 79,000 px。

| 阶段 | 小文档 | 大文档（优化前） | 大文档（优化后） |
| --- | --- | --- | --- |
| 读文件（含 UTF-8 解码） | 0 ms | 1 ms | 1 ms |
| `setMarkdown` | 0 ms | 87 ms | 12 ms |
| 表格样式 | 0 ms | **4085 ms** | 13 ms |
| 代码高亮 | 0 ms | **3795 ms** | 19 ms |
| 生成目录 | 3 ms | 0 ms | 10 ms |
| 完整排版 | 0 ms | 0 ms | 63 ms |
| **openFile 合计** | **19 ms** | **7969 ms** | **119–129 ms** |

结论与做法：

- 瓶颈不在 Markdown 解析（87 ms），而在**文档一直挂在 `QTextBrowser` 上**：
  表格样式与高亮会产生上万次 `setFormat` / `mergeCharFormat`，每次都会连带触发
  整个长文档的重排，单次约 1 ms，累计近 8 秒。
- 修复：预览文档先在**脱离视图**的 `QTextDocument` 里完成 `setMarkdown`、样式与高亮
  （同时关闭撤销栈），最后用一次 `setDocument()` 交给控件；视觉与功能不变。
- 大文档打开耗时 7.97 s → 0.12 s（约 63×），小文档 19 ms → 4–5 ms；
  优化后的首帧绘制约 2 ms。样本不含图片，含相对路径图片的 `welcome.md` 已验证正常。
- 复测方法：设置环境变量 `MDVIEWER_TIMING=1` 启动程序（或 `open --args`），
  终端会按段输出 `TIMING ...` 耗时，取消该变量即无任何输出。

### 1.7 字体与字号

| 用途 | 字体 | 字号 / 字重 |
| --- | --- | --- |
| 正文 | PingFang SC | 16.5pt / ExtraLight(200) |
| 一级 / 二级标题 | PingFang SC | 1.62× / 1.4× 基准，Bold |
| 三级及以下标题 | PingFang SC | 1.22× / 1.12× / 1.02× 基准，DemiBold |
| 代码块、行号 | JetBrains Mono（随包内置） | 代码块 0.92× 基准，**Light(300)**；行号 0.92×0.86 基准，Light |
| 行内代码 | JetBrains Mono（随包内置） | 0.92× 基准，Regular |
| 编辑区源码 | 系统等宽字体（macOS 为 Menlo） | 0.95× 基准，Regular |
| 工具栏 / 目录 / 状态栏 | 沿用系统字体 | 16px / 14pt / 12pt |

- **为什么要显式指定 PingFang SC**：macOS 的系统默认字体 `.AppleSystemUIFont` 没有中文字面，
  仅对默认字体设置 Light/Thin 时，中文仍回落到 PingFang Regular，笔画粗细完全不变。
  指定字体族后再取 ExtraLight 才真正变细。
- **「细三分之一」的实际情况**：字重档位无法精确量化，实测（文本渲染到白底后统计墨量）
  Regular 100% / Light(300) 约 81% / ExtraLight(200) 约 59% / Ultralight 约 44%。
  最终选 ExtraLight(200)，比原稿约细四成，**没有做到精确的三分之一**。
- **代码字体随包分发**：`resources/fonts/` 内为 JetBrains Mono 官方 v2.304 的
  Light / Regular / Bold 三个字重与 `OFL.txt`，通过 qrc 编入可执行文件，启动时用
  `QFontDatabase::addApplicationFont` 注册；用户机器无需预装。
- **代码块改用 Light 的原因**：等宽字体的 Regular 在 15pt 上下墨量比正文
  PingFang SC ExtraLight 更重，代码块显得「粗」。改用随包的真实 Light 字面后，
  实测同一串字符的墨量比 Regular 低约 9%（`Hamburgefonstiv 0123456789` 像素覆盖率），
  笔画变细但未发虚；字重来自字体文件本身，不是 Qt 合成。字号与行距保持原值不变。
- **回退顺序**：JetBrains Mono → Menlo → SF Mono → 系统等宽。实测屏蔽字体加载后
  代码块自动落到 Menlo，无方块字、无字体缺失报错。
- **缩放**：`Ctrl/Cmd+=`、`Ctrl/Cmd+-` 以 1.1 倍步进，`Ctrl/Cmd+0` 回到 100%（即 16.5pt）；
  范围 0.6–2.6 倍，对应正文 9.9–42.9pt。代码块、标题、行内代码都按同一缩放下发，
  界面（工具栏、目录、状态栏）不随文档缩放变化。

### 1.8 代码块行距与背景

- **行距**：代码块每行行高取 145%（`QTextBlockFormat::ProportionalHeight`），
  实测行距由 20px 提到 29px（约 1.44 em），画面明显不再「挤」。
  **末行单独收回 112%** —— Qt 的比例行高把额外空间全部加在行框下方，
  末行若也用 145%，浅灰底下方会比上方空出约 7pt，形成「上紧下松」。
- **背景由 frame 承载**：Markdown 代码块在 Qt 里是「一行一个 block」，
  逐块上背景时一旦拉开行距，背景矩形之间会露白缝（实测 132% 就会出现条纹）。
  现在先把连续代码行整体收进一个 `QTextFrame`（背景 `#f4f6f8`、padding 10、
  上下外边距 8），行距只作用于块，背景始终连续。
- **上下留白**：frame padding 10 对称，实测首行距顶 14pt、末行距底 15.5pt（100% 缩放）。
- **行内代码与正文未受影响**：正文仍是 148% 行距，行内代码只换字体不改行高；
  同一份文档在改动前后的段落行位置逐像素一致（591–626、662–693）。
- **表格单元格补空块**：Qt 的 Markdown 导入在「表格紧跟代码块」时会给单元格多塞
  一个空块，导致该格比同行高出半行（看起来像首行下沉）。`styleTables` 里会清掉
  「首块为空且有后续块」的单元格空块，表格行高恢复一致。

### 1.9 代码块行号

- **行号不进文档**：行号由 `PreviewView`（`src/previewview.*`，`QTextBrowser` 子类）
  在 `paintEvent` 里按行框几何绘制。它不属于 `QTextDocument` 的文本，因此不参与排版，
  也就不会破坏等宽对齐、行距和背景；同时**选中/全选复制时不会带进剪贴板**
  （实测选中整个代码块后 `pbpaste` 只有代码，没有行号）。
- **逻辑行对齐**：代码块是 `nonBreakableLines`，长行不折行、只做横向滚动，
  一个 block 就是一个逻辑行号；基线取首行 `QTextLine::ascent()`，与代码共用同一条基线。
  横向滚动时行号、分隔线随代码一起平移，不重叠、不重复。
- **行号栏**：宽度按该代码块总行数的位数预留（至少两位），同一块内所有行同宽；
  数字右对齐，右侧留 3 个空格、左侧 1 个空格的净距（都以行号字体的空格宽为单位，
  随缩放自动成比例）。颜色 `#9aa3ad`，字号为代码的 0.86×，不抢代码的视觉重点。
- **分隔线**：行号与代码之间画 1px 浅灰竖线（`#d9dee4`），横向位置由行号字体空格宽
  推算，缩放时同步移动；纵向取代码 frame 的内容区
  （`frameBoundingRect` 去掉 margin 与 padding），从首行上端贯穿到末行下端，
  既不缺一截也不溢出浅灰底。
- **首行修复**：`wrapCodeBlocks` 把代码片段插入 frame 时，片段首块的块格式会被
  frame 预留的空块覆盖，导致每个代码块第一行丢失 `nonBreakableLines` 与
  `BlockCodeLanguage`（表现为首行是正文字体、不着色、行距偏紧）。插入后补回原块格式，
  首行现在与其余行完全一致（等宽字体、Light、语法高亮、行号、145% 行距）。
- **与既有方案共存**：代码块行距 145%/末行 112%、frame 背景与 padding 10 均未改动；
  行号栏通过 block 左外边距让出，背景仍由 frame 承载；表格紧跟代码块的单元格修复
  未改动，回归验证通过。

### 1.10 新架构（Qt 外壳 + 系统 WKWebView）打包与验证

架构说明见 [docs/WEBVIEW-ARCHITECTURE.md](../docs/WEBVIEW-ARCHITECTURE.md)。打包脚本
未变，仍然是 `bash packaging/package_macos.sh`。

| 项目 | 结果 |
| --- | --- |
| zip 体积（该次构建，历史记录，与当前 `dist/` 略有差异） | **30,909,313 字节（约 30 MB）**，满足 40 MB 以内的分发目标 |
| 解压后 `.app` | 75 MB（其中 Qt 自带 `libicudata.78.dylib` 32 MB、Qt 框架约 18 MB） |
| SHA256 | `386b6fdcfad8f345e63d1215c49fd83567449e344ef917daf1dc6be22ddee7e0` |
| 新增依赖 | `/System/Library/Frameworks/WebKit.framework`（系统框架，**不增加包体**） |
| QtWebEngine | 未引入 |
| 签名 / 外部依赖 | Ad-hoc 签名通过；包内无 `/opt/homebrew`、`/usr/local` 绝对依赖 |

已执行的验证（干净目录解压 + 不设 Qt 环境变量启动，2026-11-10）：

| 验证项 | 结果 | 说明 |
| --- | --- | --- |
| 解压与签名 | 通过 | `ditto -x -k` + `codesign --verify --deep --strict` 无输出 |
| 外部依赖 | 通过 | 遍历包内所有 Mach-O，无 `/opt/homebrew`、`/usr/local` 绝对依赖 |
| 启动 | 通过 | 打开包内 `samples/welcome.md`，标题、正文、状态栏正常 |
| 前端资源 | 通过 | HTML/CSS/JS 来自 qrc，无外部文件 |
| 渲染 | 通过 | 标题、段落、行内样式、代码块、表格、相对路径图片 |
| 代码字体 | 通过 | 包内 JetBrains Mono Light，计算样式 `font-weight: 300` |
| 代码块行号 | 通过 | 9 个代码块对应 9 个 `.gutter`，行高比 1.450，随缩放 |
| 语法高亮 | 通过 | C++/Python/JS/JSON/Shell/SQL/HTML 分色 |
| 目录侧栏 | 通过 | 9 个条目，多级缩进，点击跳转与当前标题高亮 |
| 缩放 | 通过 | `Cmd+=` / `Cmd+-` / `Cmd+0`，0.6–2.6，状态栏显示百分比 |
| 源码模式 | 通过 | 整篇 Markdown 纯文本，切换不改脏标记、不破坏撤销历史 |
| 保存 | 通过 | 修改经 `save` 消息回传，`QSaveFile` 写回原文件 |
| 未保存提示 | 通过 | macOS 关闭按钮出现圆点，保存后消失 |
| 撤销/重做 | 通过 | 原生菜单与 `Cmd+Z` / `Cmd+Shift+Z` 都走前端自建栈（见下方按键链路说明） |
| 旧实现回退 | 通过 | `MOTE_LEGACY_QT=1` 启动旧界面（仅编译与启动验证） |
| 表格就地编辑 | 通过 | 点进单元格直接改字，表头/对齐/列宽/边框保持；`dataset.raw` 与 `textContent` 逐字相等，`\|` 与对齐行以零宽标记保留；跨格删除只清可见文本、不带走分隔符 |
| 表格加行快捷键 | 通过 | `Cmd+Enter` 下方加行、`Cmd+Shift+Enter` 上方加行（表头上方则落表体首行），光标落新行同列末尾；块高增量=行高、下一段位移=新增行高、上方单元格零位移；裸回车仍为 no-op；撤销链 3行→2行 逐步还原 |
| 跨格删除清理格式 | 通过 | 跨格删空后单元格内的 `**`/`*` 连同承载元素一起移除（原文只剩空单元格），仍有剩余文字的格保留标记；列数、分行 pipe 数不变，`dataset.raw` 与 `textContent` 逐字相等；清理后光标落回首格（不再丢选区）；清理异常时回退为「只清文本、保留标记」 |
| 代码块语言就地编辑 | 通过 | 徽标（空语言显示 `lang` 占位）可以直接改；改后 `dataset.raw` 首行围栏同步、`<code>` 当次按新语言重着色、块与下方段落零位移；`Enter`/`Tab` 提交并回到正文首行；徽标被整块删除时自动补回空徽标 |
| 查找/替换（包内） | 通过 | 干净包上实测：`alpha` → `1/6`、`Enter` → `2/6`、替换一处 → `2/5`、「已替换 1 处」、`invariant:[]`；关闭后 `#find-bar`/`#find-layer`/`.find-hit` 全为 0，`body` 子节点数 2 |
| 图片粘贴（包内） | 通过 | 干净包上实测写入 `<md 目录>/assets/paste-20261110-083027.png`，页面插入 `![](assets/…)` 并完成解码（截图见 `screenshots/imgB-package.png`） |
| 徽标单击即编辑（A1） | 通过 | 捕获阶段接管徽标上的 `mousedown`，**单击一次**即 `editing:true` 且光标落进徽标（`caretInBadge:true, caretInCode:false`），不必先点代码块；单击后直接打字得到 ```` ```python ````。块/代码框/下方段落位移全 0，`scrollHeight` 不变，徽标矩形与静止态一致 |
| 徽标不进剪贴板（A2） | 通过 | 徽标 `user-select:none`，复制处理器把 `.gutter/.mk/.code-lang` 一并剔除。整块 `selectNodeContents(pre)` 后读 `DataTransfer`：剪贴板恰为代码本身，`hasBadgeText:false`、`hasGutterNumber:false`，与 `expectedCode` 逐字相等 |
| 徽标不压代码（A3） | 通过 | 徽标改为绝对定位到代码框**右侧留白**（`left:100%` 起向右生长，不参与 flex 排版）。实测 `badgeLeft 969.5 > preRight 962.91`；换成 `shell-session` 这样的长名仍从同一起点向右生长，块矩形与静止态逐像素相同。静止态 `opacity:0.5 / pointer-events:auto / user-select:none`，编辑态 `opacity:1` + 白底细边（位置不变） |
| 包内前端资源 | 通过 | 解压后启动 `samples/welcome.md`：41 块 / 9 个代码块（`cpp,python,javascript,json,html,bash,sql,cmake,空`）各带 1 个 `.code-lang` 与 1 个 `.gutter`，表格 1 个，`body.inline-proto` 生效，徽标非编辑态 `opacity:0.5`、`pointer-events:auto`、`user-select:none`（快照里以浅灰语言名可见） |
| 分隔线就地编辑 | 通过 | `---` 叠在横线上，进入/离开编辑时块坐标、下方段落坐标、`scrollHeight` 均不变 |
| 相邻标记避让 | 通过 | 仅展开离光标最近的一个标记标签，其余 `opacity:0`；标签绝对定位，显隐不改变任何几何 |
| 锁屏下截图 | 通过 | `MOTE_SNAPSHOT=/path.png` 走 WKWebView `takeSnapshotWithConfiguration:`（屏幕锁定也能出图，不是 screencapture） |
| 查找 Cmd+F（B） | 通过 | 渲染态与编辑态都能打开：右上角查找条（输入框 + `1/5` 计数 + ↑/↓/×）。命中用挂在 `body` 的覆盖层 `#find-layer` 画（`pointer-events:none`），5 处「alpha」各 1 个 `.find-hit`，当前项 `.active` 单独描边；`Enter` → `2/5`、`Shift+Enter` → `1/5`，循环不越界；`Esc` 关闭后 `#find-bar`、`#find-layer`、`.find-hit` 全部为 0，`body` 子节点数回到 2 |
| 查找不污染文档 | 通过 | 关闭查找前后逐块比较：6 个块的 `top/height` 位移为 0（查找中与关闭后都为 0），`scrollHeight` 不变，所有 `dataset.raw` 与 `textContent` 逐字相同；覆盖层不插入任何正文节点，关闭即整层移除 |
| 查找匹配规则 | 通过 | 大小写不敏感（`alpha` / `ALPHA` 都是 `5` 个命中）；中文按字符直接比对（`中文` → `3` 个）；不跨块（跨块拼接的 `这个词。var` → `0/0`）；表格按单元格独立查找（单元格里的 `alpha` 计入）；代码块只查 `<code>` 正文，语言徽标（`js`）与行号栏数字（`2`）均为 `0/0`，跨 token 的 `first";`、`{ return` 各命中 1 处 |
| 编辑态查找落点 | 通过 | 段首光标 → `Cmd+F` → 查询 `alpha` → `Enter`：块进入 `editing`、选区恰为 `Alpha`、起点在该块内，跳转过程块几何零位移；焦点在块上时 `Enter`/`Shift+Enter` 仍是 `3/5`、`2/5`；`Esc` 后光标停在 `Alpha`（选区文本一致、块仍为编辑态），块几何与查找前逐块相同；未跳转直接关闭则回到打开查找前的偏移（实测 2 → 2） |
| 跨块查找（A1） | 通过 | `alpha` 共 6 处：按文档顺序编号 `1/6`→`6/6`→回绕 `1/6`，当前命中高亮 `top` 逐项递增（161.7 → 481.2），跳转全程 6 个块 `top/height` 最大位移 **0**；表格单元格里的 `alpha` 计入且按单元格 DOM 顺序排在表格位置 |
| 当前命中替换（A2a/A2b） | 通过 | `alpha`→`omega` 后计数变 `2/5`、首段变 `alpha beta omega ALPHA…`，`dataset.raw` 与 `textContent` 逐字相等（`invariant:[]`）、块位移 0；`Cmd+Z` 一次即恢复原文并重扫回 `1/6` |
| 全部替换（A2c） | 通过 | 6 处一次替换完成，计数 `0/0`、提示「全部替换 6 处」，不变量为空；**一次** `Cmd+Z` 全部恢复（计数回 `1/6`、首段原文逐字相同） |
| 替换拒绝（A2d） | 通过 | 跨行内标记的命中（`**bold**alpha` 里的 `boldalpha`）拒绝替换，提示「命中跨行内标记或代码着色边界，未替换」，`dataset.raw` 保持原样，不静默改坏 |
| 表格单元格替换（A2e） | 通过 | 单元格内 `表格独有`→`格中`：`dataset.raw` 正确更新，`th/td` 仍为 5 个、`class="table"` 保留，不变量为空 |
| 代码块替换（A2f） | 通过 | 代码内 `"first"`→`"second"`：`dataset.raw` 为 ` ```js ` + 新代码 + 围栏，`data-lang` 与 `.code-lang` 徽标保留，重新着色后 5 个 token `<span>`，不变量为空 |
| 关闭无残留（A2g） | 通过 | `Esc` 后 `#find-bar`/`#find-layer`/`.find-hit` 全为 0，`body` 子节点数回到 2；关闭前后所有块 `dataset.raw` 与整篇 `textContent` 逐字相同 |
| 源码模式查找/替换（A3） | 通过 | `Cmd+E` 后 `Cmd+F` 照常可用：计数 `1/5`，`Enter` 后 `textarea` 选区恰为 `needle`；全部替换 5 处后 `needle` 为 0、计数 `0/0`，`Cmd+Z` 一次恢复（计数 `1/5`、`needle` 4 处可继续跳转、文本长度回到替换前） |
| 本地图片加载（修复） | 通过 | 原实现用 `loadHTMLString:baseURL:` 载入页面，WebKit 拒绝读取任何 `file://` 子资源（实测 `img.naturalWidth=0`、`fetch` 报 `Load failed`），相对路径图片从未真正显示。改为把页面写成文档目录下的隐藏临时文件，用 `loadFileURL:allowingReadAccessToURL:` 载入并 `<base>` 指回文档目录：`welcome.md` 的 `sample-diagram.png` 实测 `naturalWidth=256` |
| 图片粘贴落盘（B5） | 通过 | 粘贴通道把图片字节交给原生，写入 `<md 目录>/assets/`（目录不存在自动创建）。实测首次粘贴生成 `assets/paste-20261110-082710.png`，`dataset.raw` 变为 `![](assets/paste-…png)`，`<img>` 的 `naturalWidth=256` 当场可见，不变量为空 |
| 重名不覆盖（B5） | 通过 | 同名图片再次落盘自动加序号：`photo.png` 已存在时再拖入得到 `photo-2.png`、`photo-3.png`；连按两次粘贴（同一秒内）得到两个不同时间戳文件，`sameSrc:false` |
| 拖入图片（B6） | 通过 | 原生拖放把真实文件复制进 `assets/` 并插入 `![](assets/photo-3.png)`，`<img>` 正常解码（`naturalWidth=256`）；网页 `drop` 事件仍保留 base64 → 原生落盘的兜底路径 |
| 拖入 md（B7） | 通过 | `MoteWKWebView` 注册 `NSPasteboardTypeFileURL`，`draggingEntered`/`performDragOperation` 取到真实路径后发 `fileDropRequested`，由外壳走与菜单相同的「未保存确认 → 打开」。诊断钩子（`MOTE_DROP`，调用同一函数）实测把 `doc.md` 切换为 `dropped.md`，正文变为「拖入的文档」 |
| 图片插入的撤销（B8） | 通过 | 插入前先 `commitHistory()`：`Cmd+Z` 一次把 `![](assets/photo-3.png)` 从 `dataset.raw` 移除、块数与其余图片恢复；**磁盘文件保留**（`photo-3.png` 仍在 `assets/`），重做只恢复 Markdown，不会重新写文件 |
| 未保存文档粘贴图片 | 通过 | 未命名/内置示例没有目录：原生提示「图片未插入：当前文档还没有保存位置，请先保存 .md 文件」，块数不变、不插入任何 `![](…)`、不创建 `assets/` |
| 新建文档（Cmd+N） | 通过 | 工具栏「新建」与「文件 → 新建」同一 `QAction`（`QKeySequence::New`），实测 `Cmd+N` 走系统菜单快捷键触发；新建后 `m_filePath` 为空，窗口标题 `未命名 - Mote`，状态栏「已新建空白文档（未命名，保存时会询问位置）」 |
| 新建后状态重置 | 通过 | 页面只剩 1 个空块（`blocks:1`、`raw0=""`）、`tocItems:0` 且 `#toc-list` 清空、`#find-bar`/`#find-layer`/`.find-hit` 均不存在、缩放回 100%（正文 16.5px）、光标落进空块可立即输入；`dataset.raw` 与 `textContent` 自洽 |
| 新建的未保存保护 | 通过 | 当前文档有改动时先弹「有尚未保存的修改，是否保存？」（保存 / 不保存 / 取消）：取消 → 文档与光标原地不动、不新建；不保存 → 直接得到空白文档；保存 → 写盘后（`dirty:0`）再新建。三支均已实测（截图见 `screenshots/new-confirm.png`） |
| 未命名文档保存 | 通过 | 无路径时「保存」转「另存为」，默认扩展名 `.md`；保存后标题变为 `<文件名> - Mote`、`dirty:0`，后续图片落盘目录跟随新路径（实测另存到 `/tmp/mote-saveas5/out.md` 后粘贴图片写入该目录 `assets/`） |
| 未命名文档空态无残留 | 通过 | 新建前后对比：旧块全部被替换（`body` 只剩工具栏/编辑根两个子节点）、旧 TOC 节点清空、旧查找高亮层移除；不存在旧 `dataset.raw` |
| 连续新建两次 | 通过 | 连发两次 `Cmd+N`：两次标题均为 `未命名 - Mote`、`dirty=0`、路径为空；第二次后仍只有 1 个空块、`tocItems:0`、无查找条、缩放 100%，说明上一份状态没有残留 |
| 空白占位提示 | 通过 | 空文档 `#editor` 带 `bare`，`::before` 内容为「开始输入，或按 / 插入内容」；`textContent=""`、`dataset.raw=""`，提示不进入原文；输入任意字符后 `bare` 移除 |
| 另存为记住目录 | 通过 | 打开 `/tmp/mote-fmt/doc.md` 后新建，`MOTE_SAVE_PROMPT=1` 记录的默认路径为 `/tmp/mote-fmt/未命名.md`（会话内记住上次打开/另存为目录；对话框也从该目录起步） |
| 格式快捷键（原生菜单） | 通过 | 选中正文后注入真实 `Cmd+B`，日志出现 `NATIVE -> JS format bold`，`dataset.raw` 变 `**…**` 且与 `textContent` 一致；菜单表由 `MOTE_KEYLOG` 打印，无重复/冲突（目录已让出 `Cmd+Shift+T`，改为 `Cmd+Shift+L`） |
| 行内切换语义 | 通过 | `bold` 两次回到原文；`italic` 两次回到原文；`inlineCode`/`link` 包裹后再执行一次取消（链接还原为纯文字）；斜体不会误吃粗体的 `**` |
| 标题/列表切换 | 通过 | `h1→h2` 前缀只有一个（`##`），`h2→h2` 回正文；`ul→ol→quote→正文` 逐级只有一个前缀；`h1` 后一次撤销回到 `h2` |
| 多块转换与撤销 | 通过 | 选中 3 段正文 → `ul` 合成 1 个列表块（3 项），一次撤销恢复 3 段；3 段 → `codeBlock` 合成 1 个围栏块（3 行），一次撤销恢复；3 段 → `h2` 变 3 个标题块，一次撤销全部回正文（`commitBatch` 合并中间渲染） |
| 列表回正文拆分 | 通过 | 2 项列表 → 正文拆成 2 个独立段落（不是单块硬换行），一次撤销恢复原列表块 |
| 零位移数据（单块转换） | 通过 | 5 段文档把第 2 段转代码块：`tops` 由 `[45,92,139,186,233]` → `[45,92,186,233,280]`；上方块`top` 不变，下方块整体 +47px，恰等于被转换块的高度增量，没有额外抖动 |
| 斜杠菜单 | 通过 | 行首输入 `/` 弹出 12 项；输入 `code` 过滤为「代码块 / 行内代码」；`ArrowDown` 两次高亮「表格」、`Enter` 插入 2×2 表格且光标在首个 `th`；`#slash-menu` 关闭即移除 |
| 斜杠 Esc | 通过 | 输入 `/quo` 后 `Esc`：浮层消失、块原文回到 `""`（连同 `/quo` 一起删除），没有残留节点或半截命令 |
| 斜杠插入代码块 | 通过 | `/code` + `Enter`：得到 ` ```\n…\n``` `，光标在正文首行；随后直接输入 `console.log(1);` 落在代码体内 |
| 右键「转为」 | 通过 | 右键块弹出 `#turn-menu`（正文 / 标题 1-3 / 无序 / 有序 / 引用 / 代码块）；点「代码块」后该块整体包进围栏、其余块只随高度平移；已是目标类型再执行保持不动 |
| 源码模式格式 | 通过 | 源码态选中 5 字 → `bold` 得 `**第一段文字**`，一次撤销还原；`h2` 得 `## 第一段文字`；切回渲染态 `raw/textContent` 一致 |
| 重新打包后包内复测 | 通过 | 干净目录解压 2026-11-10 该次重新打包的最终包（30,904,323 字节，历史记录）后，在包内 `Mote.app` 上复跑：两次 `Cmd+N` 均为 `未命名 - Mote`/`dirty=0`、1 个空块、`bare` 占位、toc 0、无查找条、16.5px；注入真实 `Cmd+B` 后 `**第二段文字。**`（`raw === textContent`）；斜杠 `/code` 过滤出「代码块/行内代码」，`Enter` 插入围栏块且 `#slash-menu` 已移除；`正文→标题 1` 得 `# 第一段文字。`（同类型再执行不变，一次撤销还原）；5 段文档第 2 段→代码块 `tops` 由 `[45,92,139,186,233]`→`[45,92,186,233,280]`；3 段→无序列表合成单块 3 项、一次撤销回 3 段 |

按键链路（本轮修复，详见架构文档 §2.4）：macOS 原生「编辑」菜单会在页面 `keydown`
之前吃掉 `Cmd+Z`，且 NSMenu 匹配字母快捷键时忽略 Shift，导致 `Cmd+Shift+Z` 命中「撤销」。
现在用 `NSEvent addLocalMonitorForEventsMatchingMask:` 在菜单之前分流到前端历史栈，
菜单项点击与快捷键走同一条路。验证方式为 `NSApp sendEvent:` 注入（与物理按键同一响应链），
**不再用 DOM 合成 `keydown` 冒充**。

### 1.11 快捷键逐项回归（2026-11-10，最终包）

方式：按键全部经 **System Events `key code`**（系统事件链，与物理按键同一路径；格式键由原生
NSMenu key equivalent 消费），右键用 **`cliclick` 真实鼠标事件**；页面侧用 `MOTE_EVAL` 每
150 ms 采样 `dataset.raw`、`textContent`、光标父节点与块几何。仅「准备文档/选区」用 `window.mote.*`，
**没有**用直接调用函数冒充按键。

| 组 | 覆盖 | 结果 |
| --- | --- | --- |
| 行内 ⌘B / ⌘I / ⌘K / ⇧⌘K | 光标在词中 + 有选区各一组，apply→toggle→apply→undo | 通过；`raw === textContent`，再按取消，一次撤销回上一步 |
| 标题 ⌘1/2/3 | 正文→h1/h2/h3、跨级直转、同级再按回正文 | 通过；前缀始终只有一个，不出现 `## ##` |
| 块插入 ⇧⌘C / ⇧⌘8 / ⇧⌘7 / ⇧⌘B / ⇧⌘T | 插入位置、光标落点（CODE/LI/BLOCKQUOTE/TH）、块几何 | 通过；仅目标块高度增量 + 下方块等量平移 |
| 大纲 / 表格 ⇧⌘L、⇧⌘T | 目录开关；2×2 表格 | 通过；⇧⌘L 开目录、⇧⌘T 落表格 |
| 旧键 ⌘N/⌘F/⌘E/⌘S/⌘Z/⇧⌘Z/⌘=/⌘-/⌘0 | 新建、查找、源码切换、保存写盘、撤销重做、缩放 | 通过；未被新菜单项抢占 |
| 斜杠菜单 | `/` 触发、输入过滤、↑↓、Enter、Esc | 通过；浮层挂在 `BODY`、不在 `#editor` 内 |
| 右键「转为」 | 正文↔标题、→代码块、代码块→正文、3 段多选→列表 | 通过；多选合成单块，一次撤销回 3 段 |
| 菜单冲突 | 24 个带快捷键的菜单项全表（`MOTE_KEYLOG`） | 24 个组合唯一，无重复；⌘0 = 实际大小；新增 `⌘⇧D`（深色模式）与原有 23 个均不重叠（1.13 新增「导出 HTML…」`⌥⌘E` 后全表 25 项仍唯一） |

本轮修掉的两处问题：

1. 无选区 ⌘K 二次按下只识别到链接文字一侧，产生 `[链接文字[](url)](url)` 嵌套。改为向上查找完整
   `[...](...)` 整体取消，并修正取消后的偏移（去掉 `[` 后整段左移一位，`start: lb`）。
2. 跨块选区右键时 WebKit 会在 `contextmenu` 之前把选区折叠成光标，「转为」只作用于首块。改为在
   `mousedown`（右键）阶段保存 Range，`contextmenu` 时若点击块在保存范围内则恢复选区。

只能人工确认：物理按键重复速率（长按连发）、输入法组合输入（中文/五笔上屏与候选框）、
触控板手势（双指查找/缩放）。截图：`screenshots/shortcut-menu-format.png`（格式菜单展开）。

**未验证 / 已知降级**（详见架构文档第 4、5 节）：

- TOC 在源码模式下隐藏；当前标题高亮按渲染块位置计算，编辑中的块未重排时可能滞后一帧。
- 语言徽标改为渲染态常驻显示（半透明 0.5）以便单击即编辑；代价是静止阅读时代码块右侧
  会多出一个浅灰语言名。它绝对定位在代码框**右侧留白**，不参与块排版、不遮挡代码字符；
  若窗口很窄或语言名很长，徽标会向代码框右侧的页面留白延伸，窗口宽度不足时可能被视口右边缘
  裁掉（代码本身不受影响，可继续横向滚动）。
- 徽标复制剔除依赖前端 `copy` 处理器；脚本只能验证 `DataTransfer` 内容，真实 `Cmd+C`
  写入系统剪贴板的最终结果仍需人工确认。
- 语言标识会剔除空白与反引号（输 `c + +` 实际写成 `c++`），且不校验是否受支持；
  未知语言只保留等宽与底色、不着色（原文围栏按输入原样保存）。
- 查找/替换的最小单位是「一个文本节点」：跨块、跨表格单元格都能按文档顺序连续命中与跳转，
  但命中本身不会跨过块的边界，也不会跨过单元格边界（跨块拼接的 `这个词。var` → `0/0`）。
  代码块内可跨行（`<code>` 的 `\n` 属于同一段文本），但查找框是单行 `<input>`，
  无法输入换行，实际只能查同一行内、可跨行内元素（token span）的字符串。
- 替换只改 `dataset.raw` 后整块重渲染，命中必须落在**单个文本节点**内、且替换文本不含换行、
  不引入会改变结构的字符（表格里的 `|`、代码围栏 ``` ``` ```）。跨行内标记、跨着色 token
  的命中会拒绝并提示「命中跨行内标记或代码着色边界，未替换」；替换表格单元格时只支持纯文本，
  替换代码块时只改 `<code>` 正文、保留围栏语言。
- 大小写不敏感用两侧 `toLowerCase()` 实现（少数小写后长度变化的语言退回区分大小写）；
  中文按字符逐一比对，不做分词、不做拼音/简繁/全半角归一化；不做正则、不做整词匹配，
  连续空格必须按原样输入（代码块里尤其明显）。
- 查找条 fixed 悬浮在右上角，窗口很窄时可能盖住该位置的正文；源码模式只把当前命中滚进视口
  并选中，不画逐处高亮（`textarea` 无法叠绝对定位色块），计数仍按全文统计。
- 编辑态跳转会把焦点从查找框交给命中的块（否则 `enterEdit` 会把选区覆盖成块尾，
  光标落点就不对了）。因此跳转后继续输入会编辑正文；查找条打开期间 `Enter` /
  `Shift+Enter` 被接管为「下一个/上一个」，不能用来插入换行。未跳转过直接关闭则还原原光标。
- 每次输入都对全文做一遍扫描（120 ms 防抖），大文档未做增量索引；
  命中很多时覆盖层会为每个命中建一个绝对定位色块。
- 查找覆盖层按「视口矩形 + 文档滚动量」定位；页面纵向滚动不需要重画，代码块内部横向
  滚动与窗口缩放会触发重画。真实 `Cmd+F` 物理按键链路仍属人工验证（脚本用 DOM `keydown`）。
- 跨格删除的格式清理只针对被删空的单元格；仍有剩余文字的格刻意保留标记（否则原文里的
  `**` 会丢）。因此「删一半」后格式仍在，无法只删格式不删字。清理异常时回退为只清文本。
- 跨格删空会让该行内容变矮（本轮实测块高 −28 px、下方段落上移 28 px），属于内容变化，
  不是进入/离开编辑产生的位移。
- 源码模式为原生 `<textarea>`，有等宽字体与行内滚动，但不做高亮与行号。
- 图片只处理常见位图（PNG/JPG/GIF/WebP/TIFF/BMP）；HEIC 等能否解码取决于系统 WebKit。
  剪贴板里如果是「文件 URL」而不是位图数据，仍走文本粘贴，不会落盘。
- 图片落盘依赖文档已有保存位置：未命名文档、内置示例（`qrc:/samples/`）只提示
  「请先保存 .md 文件」，不写 `assets/`、不插入 Markdown。
- 撤销只撤 Markdown 插入，**不删除已落盘的文件**；重做只恢复 `![](…)`，不会重写文件。
  若手动删掉 `assets/` 里的图片再重做，会得到破图（路径仍在，文件没了）。
- 源码模式粘贴图片时只插入 `![](… )` 文本，要切回渲染态才看得到图片。
- 旧实现用 `loadHTMLString:baseURL:`，WebKit 会拒绝一切 `file://` 子资源（图片永不显示）。
  现在页面写成文档目录下的隐藏临时文件 `.mote-preview-<pid>.html`，靠
  `loadFileURL:allowingReadAccessToURL:` 换取读取权限；正常退出会删除，异常退出可能残留，
  可直接删除（不影响文档内容）。
- 原生拖放只接 `.md/.markdown/.mdown/.mkd/.txt` 与常见图片；其他类型交回 WebKit 默认行为。
  拖入 md 会走「未保存确认 → 打开」，与菜单打开一致；拖放目标状态（高亮/光标）沿用系统默认，
  没有自定义拖拽预览。
- 只能人工验证：真实 `Cmd+V` 系统剪贴板截图、Finder 真实拖放（脚本用消息通道/`MOTE_DROP`
  调用同一条原生函数，模拟的是数据管线而不是 AppKit 拖放会话本身）；
  真实鼠标拖选、物理键盘逐字输入与输入法候选窗同理。
- 新建文档（`Cmd+N`）后没有路径：标题显示「未命名 - Mote」，此时「保存」自动转「另存为」
  并默认 `.md`；在保存前粘贴/拖入图片只会得到「请先保存 .md 文件」的提示，不写 `assets/`。
- 新建文档会关闭查找条、关闭目录侧栏、把缩放重置回 100%；这是有意的状态重置，
  不是「保留上次视图」——如果只想清空正文，请自行新建后再打开目录/缩放。
- 新建时若当前文档有未保存修改，会先弹「保存 / 不保存 / 取消」；取消会中止新建。
  该弹窗与关闭窗口时的确认是两个独立入口，前者不会退出程序。
- 新建文档后首次保存走另存为，`assets/` 目录随新路径创建；保存前已在内存中的图片
  （未命名文档不会落盘）不会补写，需重新粘贴。
- 斜杠菜单的「图片」只插入 `![](图片路径)` 占位文本并选中路径，不弹文件选择框；
  要得到真实图片，仍需改用 `Cmd+V` 粘贴位图或从 Finder 拖入（两者会写 `assets/`）。
- 行内格式（粗体/斜体/行内代码/链接）只作用于当前块内的选区；在代码块、表格、分隔线块上
  执行会提示「当前块不支持行内格式」，不会跨块做行内包裹。多块选中时只处理光标所在块。
- 代码块 → 正文只去掉围栏，围栏内的多行仍留在同一个正文块里（显示为硬换行），
  不会按行拆成多个段落；反向的「列表 → 正文」才会按项拆成多段。
- 斜杠只在**逐字输入** `/` 时触发：整串粘贴 `/code` 不会弹出浮层（粘贴后光标在 `e` 之后，
  不满足「`/` 是刚输入的最后一个字符」），需要手动敲 `/`。
- 「转为」（右键菜单 / 斜杠菜单 / 工具栏）是**不切换**语义：已是目标类型再执行保持不动；
  格式快捷键是**切换**语义：同类型再按一次回正文（`Cmd+B` 再按取消粗体、`Cmd+1` 再按回到正文）。
  1–3 级标题互切时只保留一个前缀，不会叠加。
- 原生格式菜单占用了 `Cmd+1/2/3`、`Cmd+Shift+7/8/B/C/K/T`；目录快捷键因此从 `Cmd+Shift+T`
  改为 `Cmd+Shift+L`。`Cmd+0` 仍是「实际大小」（缩放复位），所以「正文」菜单项没有快捷键。
- 解压后 75 MB 主要来自 Homebrew Qt 的 ICU 数据（32 MB）与 Qt 框架，架构调整
  不会改变这部分；要把解压体积压到 40 MB 以内，需要换用不带 ICU 的 Qt 构建，
  或把外壳也移出 Qt（不在本轮范围）。

### 1.12 任务列表 / 字数统计 / 深色模式（2026-11-10，最终包）

方式同 1.11：鼠标用 `cliclick` 真实事件、按键经 System Events `key code`；
页面侧 `MOTE_EVAL` 每 150 ms 采样 `dataset.raw`、`textContent`、块几何与计算样式。
最终包解压到全新目录 `/tmp/clean-test2` 后复跑，下表数字均来自**包内** `Mote.app`。

**批次 A：任务列表与状态信息**

| 验证项 | 结果 | 数据 |
| --- | --- | --- |
| 任务列表渲染 | 通过 | 5 项（`-`/`*`/`+`/缩进子项各一）全部变复选框，勾选状态 `[否,是,否,是,否]` 与原文一致；`dataset.raw` 与 `textContent` 逐字相等（`eq:true`） |
| 点击切换 | 通过 | 点第 1 个复选框 → `- [x] 未完成任务`，`dataset.raw` 同步改写，块几何不变（块 `top` 仍为 45） |
| 一次撤销 | 通过 | `Cmd+Z` 一次回到 `- [ ] 未完成任务`，勾选状态与原文同时回退 |
| 复制输出 | 通过 | 复制文本为 `- [ ] … / - [x] … / * [ ] … / + [x] … /   - [ ] …`，无复选框字符（`hasCheckboxText:false`）；验证走产品自身的 `copy` 处理器（`DataTransfer`） |
| 编辑态键盘改 | 通过 | 点进正文进入编辑态后，任务标记是可见文本；真实鼠标拖选 `[ ] ` → 键盘输入 `[x] `，`dataset.raw` 变 `* [x] 星号任务`（`eq:true`）；离开编辑态后重新渲染为已勾选 |
| 字数统计 | 通过 | `中文 5 字 · 英文 5 词`（样例含 5 个汉字、`hello world 123` 与代码块内 `code line`）；口径：CJK 字符逐个计数，英文按连续字母/数字分词，代码块正文计入、围栏与行号不计 |
| `Cmd+Click` 链接 | 未实现（如实记录，已在 1.13 实现） | 本批次时链接以零宽标记 + 纯文本渲染，页面内**没有 `<a>` 元素**，也没有导航拦截或 `openURL` 逻辑；实测 `Cmd+Click` 只让块进入编辑态，页面 URL 仍为本地临时页、正文不变 |

**批次 B：深色模式**

| 验证项 | 结果 | 数据 |
| --- | --- | --- |
| 跟随系统 | 通过 | 系统浅色 → `theme:light`；切系统深色 → 自动变 `dark`；还原 → 回 `light`（测完已还原系统外观） |
| 手动切换 | 通过 | 「视图 → 深色模式」`⌘⇧D`，日志 `NATIVE -> JS theme dark`；与原有 23 个快捷键无重复（见 1.11） |
| 几何不变 | 通过 | 7 个块切换前后 `top` 完全一致：`[45,155,202,278,380,512,647]`；高度 `[96,33,63,87,118,121,58]` 一致 |
| 内容不变 | 通过 | 7 个块的 `dataset.raw` 与整篇 `textContent` 逐字相同（含切回浅色后） |
| 编辑态与光标 | 通过 | 切换前后块 1 仍为编辑态，光标 `block:1, off:2` 未变 |
| 覆盖范围 | 通过 | 正文、标题、引用、表格（表头/边框）、行内代码、代码块（背景、行号栏、竖线、语言徽标）、语法高亮 token、TOC 侧栏、查找栏与命中高亮、斜杠浮层均已取样；状态栏由 Qt 侧单独上色（深色 `#1b2027`） |
| 对比度（深色） | 通过 | 正文 12.86:1、标题 16.22:1、表格 11.28:1、行内代码 10.31:1、代码块 11.69:1；关键字 6.46:1、字符串 10.07:1、注释 5.45:1；目录 12.22:1、查找栏 8.86:1、查找命中 6.42:1、斜杠浮层 12.86:1（选中项 9.79:1）。全部高于 4.5:1，代码高亮可读 |
| 浅色回归 | 通过 | 切回浅色后各取样点计算样式与初始浅色**逐项相同**（`samples` 全等），正文 16.13:1、代码块 14.89:1、行号 2.36:1，与改动前一致，无退化 |
| 截图 | 已补 | `screenshots/theme-light.png`、`theme-dark.png`、`theme-dark-find.png`、`theme-dark-slash.png`、`theme-light-back.png` |

明确的降级点：

- 深色只覆盖网页侧与状态栏；**工具栏、菜单栏、标题栏**仍是系统原生外观（未做自绘），
  两者并排时能看到一条浅色界面带。
- 手动切换会退出「跟随系统外观」；重新勾选「跟随系统外观」才交回系统。
  「不跟随」单独一项没有意义，取消勾选会被立即恢复为勾选。
- 行号分隔线在深色下是 `rgb(47,56,65)`（背景 `rgb(28,34,40)`），刻意保持与浅色同级的
  弱化程度，不追求 3:1 的 UI 对比度。
- 编辑态键盘改任务标记依赖「标记在编辑态是可见文本」这一实现；真实拖选/物理键盘已实测，
  但输入法组合输入路径未单独验证。

### 1.13 链接交互 / 导出 HTML / 目录手型（2026-11-10，最终包）

方式同前：鼠标用 `cliclick` 真实事件、`Cmd+Click` 经 System Events 的 ⌘ 修饰键 + 真实点击，
页面侧每步前采样 `dataset.raw`、`textContent`、块几何、`getComputedStyle`，并用
`elementFromPoint` 做命中测试。**最终包**解压到全新目录 `/tmp/clean-test3` 后复跑，
下表数据均来自包内 `Mote.app`（2026-11-10 该次最终包，30,919,297 字节，与当前 `dist/Mote-macOS.zip` 的 30,919,184 字节略有差异）。
带指针的截图用**整屏** `screencapture -x -C` 再按窗口矩形裁切（`-R` 区域模式实测不含指针）。

**批次 A：链接交互**

| 验证项 | 结果 | 数据 |
| --- | --- | --- |
| 渲染样式 | 通过 | 4 个链接的计算样式均为 `color:rgb(47,111,237)`、`text-decoration-line:underline`、`cursor:pointer`；文字可识别为链接，零宽标记 `[` `](url)` 仍不占位 |
| 普通点击 | 通过 | 点链接文字后仅块 0 进入编辑态（`editing:[true,false,false,false]`），页面 URL 仍是 `.mote-preview-*.html`，`dataset.raw` 与 `textContent` 不变 |
| 编辑态形态 | 通过 | 编辑态下 `a.md-link` 退化为普通文本（`cursor:text`），显示原始 `[示例站点](https://example.com)` |
| 复制输出 | 通过 | 产品自身 `copy` 处理器输出 `链接：[示例站点](https://example.com)`，与 `dataset.raw` 逐字相等（`equalsRaw:true`）；验证走合成 `DataTransfer`（见 §5 第 6 条） |
| `Cmd+Click` 外部链接 | 通过 | 前台应用变为 `Safari`；页面 URL 不变；导航被拦截（`MoteNavigationDelegate` 除首次加载外一律 Cancel，本次未产生导航，`nav blocked` 日志 0 条） |
| `Cmd+Click` 相对 `.md` | 通过 | 应用内打开 `other.md`（2 块，`['# 另一篇','被链接打开的文件。']`），走「未保存确认 → 打开」；日志 `QT openLink href=other.md base=/tmp/verify-mote/cases/` |
| 目标不存在 | 通过 | 弹原生提示框（窗口数 2）、Esc 关闭后进程存活（`alive:true`）、原文档 `dataset.raw` 不变；截图 `screenshots/link-missing-dialog.png` |
| 锚点 `#标题` | 降级（如实记录） | 不导航、不报错，状态栏提示「锚点链接 #标题一 暂不支持（还没有标题锚点）」；文档块数仍为 4；截图 `screenshots/link-anchor-status.png` |
| 图片链接 | 无链接（如实记录） | `![alt](url)` 渲染为 `<img>`，没有 `<a>` 包裹，`Cmd+Click` 不触发跳转；相对路径图片仍按文档目录正常显示 |
| 悬停截图 | 已补 | `screenshots/link-hover.png`：指针停在「示例站点」上，系统标准手型（非自定义位图光标），链接蓝色下划线 |

**TOC 手型（并入本批次）**

| 验证项 | 结果 | 数据 |
| --- | --- | --- |
| 计算样式 | 通过 | `#toc`、`#toc .toc-title`、`.toc-item` 的 `cursor` 均为 `pointer`；无 `cursor:url(...)`，用的是系统标准手型 |
| 条目缝隙命中 | 通过 | 在「第 1 周」与「第 2 周」之间（y=99.39）`elementFromPoint` → `toc-list`，其 `cursor:pointer`，手型不会闪回箭头 |
| 栏内空白命中 | 通过 | 条目下方空白（y=221.14）`elementFromPoint` → `#toc`，`cursor:pointer` |
| 折叠按钮/滚动条 | 未被覆盖 | 折叠按钮保持自身 `cursor:pointer` 语义，滚动条由系统绘制，不继承栏内样式 |
| 跳转与零位移 | 通过 | 点击第 4 个条目后 `scrollY 0 → 2533`，4 个块的 `dataset.raw` 不变（`eq:true`），仅滚动位置变化 |
| 截图 | 已补 | `screenshots/toc-cursor-item.png`（条目文字上）、`toc-cursor-gap.png`（一/二条目缝隙）、`toc-cursor-blank.png`（条目下方空白），三张均为整屏 `-C` 抓取的真实指针 |

**批次 B：导出 HTML**

菜单「文件 → 导出 HTML…」，快捷键 **`Option+Cmd+E`**。为什么不是 `Cmd+Shift+E`：
`Cmd+E` 是源码模式，macOS 原生菜单把大写 `E` 的 Shift 视为同一 key equivalent，
实测 `Cmd+Shift+E` 既不触发也不报冲突（`MOTE_KEYLOG` 只看到修饰键事件），因此改用带 Option 的组合；
`MOTE_KEYLOG` 打印的 **25 个**带快捷键菜单项全表唯一，无重复。

| 验证项 | 结果 | 数据 |
| --- | --- | --- |
| 产物 | 通过 | `/tmp/export-test/page.html`，**389,752 字节**（含 1 张 base64 内嵌图） |
| 自包含 | 通过 | `grep -c` 结果：`file://` **0**、`/Users/` **0**、`<script` **0**、`src="http` **0**、`url(http` **0**、`@import` **0**；`data:image/png;base64` **1** 处（相对路径图片真的嵌进去了，`missing:0`） |
| 样式与高亮 | 通过 | `<style>` 内联整张样式表（含 `@font-face` 的 base64 字体）；代码高亮 `class="tok-*"` 4 处保留；行号栏 `.gutter`/`.code-lang` 已剔除（0 处），导出的不是编辑器截屏而是干净正文 |
| 任务复选框 | 通过 | 勾选 1 个、未勾选 1 个，导出为 `span.task-check-static`（已勾选填 `✓`、蓝底），状态与原文一致 |
| 不修改原文档 | 通过 | 导出前后 `dataset.raw` 与 `textContent` 逐字相等（`raws:true, eq:true`），文件未被写入（窗口标题仍是原文件名，无 dirty 标记） |
| 浏览器打开 | 通过 | Safari 打开渲染正常：标题、粗体、行内代码、链接、任务列表、表格、代码高亮与内嵌图片齐全；文件里没有任何 `<script>`，因此不存在脚本报错；截图 `screenshots/export-browser.png` |

本轮修掉的一个真实缺陷：预览页为了让相对路径图片可用，会在页面模板的 `</head>` 前注入
`<base href="file://…">`。原实现用整串 `replace("</head>", …)`，把**内嵌 JS 源码里的
`'</head>'` 字面量**也一起替换了，导致导出的 HTML 凭空多出一个 `file://` 的 `<base>`。
改为只替换第一处（模板自己的 `</head>`，`src/macwebview.mm`）后，`grep file://` 从 1 变 0。

PDF 导出的可行性评估见 §5 第 5 条（结论：不提供，理由是实测数据不支持）。

### 1.14 DMG 分发：拖拽安装（2026-11-10，最终包）

```bash
bash packaging/package_macos.sh --dmg     # 在 zip 之外再产出 dist/Mote-macOS-0.3.0.dmg
```

> 文件名自 0.2.0 起带版本号：版本读自构建产物的 `Info.plist`（qmake 用 `Mote.pro` 的
> `VERSION` 填入），脚本里不再另存版本号。下面 2026-11-10 的验证记录是在改名前跑的，
> 命令输出里的 `Mote-macOS.dmg` 与现在的 `Mote-macOS-0.3.0.dmg` 是同一份内容。

卷信息与结构：

| 项 | 值 |
| --- | --- |
| 文件 | `dist/Mote-macOS.dmg`，**34,252,460 字节**（33 MB） |
| SHA256 | `7ff5693b77ff1c8877a7c4e729367ab81c845963305ae60c5f26385c8f58a189` |
| 卷标 | `Mote`（`hdiutil create -volname Mote`） |
| 文件系统 / 格式 | HFS+ / UDZO（zlib 压缩的只读 UDIF；未压缩内容 95,699,968 字节） |
| 卷内 | `Mote.app` 与 `Applications -> /Applications`（符号链接，13 字节），无 `.DS_Store` |

**关于图标位置**：没有用 Finder AppleScript 摆图标。那套做法需要 GUI 会话 + 自动化授权，
在没有登录会话或首次授权的机器上会静默失败，属于「不可复现的手工步骤」。这里只保证
「拖拽安装」这个功能结构（app + Applications 替身），图标位置由 Finder 默认网格决定；
想固定窗口尺寸/坐标就得在挂载后跑 AppleScript 再用 `hdiutil convert` 收尾，本脚本不这么做。

验证（全部实际执行，2026-11-10）：

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 镜像完整性 | 通过 | `hdiutil verify` → `checksum of "dist/Mote-macOS.dmg" is VALID` |
| 挂载 | 通过 | `hdiutil attach -nobrowse -readonly -mountpoint /tmp/dmg-mnt` → `/dev/disk4s1 Apple_HFS /private/tmp/dmg-mnt` |
| 卷属性 | 通过 | `diskutil info` → `Volume Name: Mote`、`File System Personality: HFS+`、只读挂载 |
| 卷内内容 | 通过 | `ls -la` 恰好两项：`Mote.app`（目录）、`Applications -> /Applications` |
| 拷出后签名 | 通过 | `ditto` 到 `/tmp/dmg-test/Mote.app` 后 `codesign --verify --deep --strict` → `valid on disk`、`satisfies its Designated Requirement`；`codesign -dv` → `flags=0x2(adhoc)`、`Signature=adhoc`、`TeamIdentifier=not set` |
| 无 Qt 环境启动 | 通过 | `env -i HOME=… PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=/tmp`（不带任何 `QT_*` / `DYLD_*`）直接运行包内可执行文件：进程存活，`MOTE_EVAL` 输出 `41 blocks, toc=true`，`MOTE_SNAPSHOT` 写出 636,402 字节 PNG，内容为欢迎页正常渲染 |
| 外部依赖 | 通过 | 包内 292 条 Mach-O 依赖中 `/opt/homebrew`、`/usr/local` 绝对路径 **0** 条；23 条 `LC_RPATH` 中绝对路径 **0** 条 |
| 卸载 | 通过 | `hdiutil detach /tmp/dmg-mnt` → `"disk4" ejected.`，`hdiutil info` 无残留挂载点 |

本批次顺带修掉的一个真实缺陷：扫描发现 `libjpeg.8.dylib`、`libjasper.7.dylib`、
`libdbus-1.3.dylib` 里各残留一条 `/opt/homebrew/Cellar/...` 的 `LC_RPATH`。它们的依赖虽然
已经是 `@executable_path/../Frameworks/...`，但这条 rpath 会让**装了同版本 Homebrew 库的机器**
优先加载系统副本而不是包内副本。脚本第 5 步现在会删掉包内所有 Mach-O 上 `/opt/*`、
`/usr/local/*` 的 `LC_RPATH`，重建后绝对 rpath 归零。

**Gatekeeper 现状**（这不是 DMG 能解决的问题）：

- 包是 **Ad-hoc 签名**（`codesign --sign -`），**未用 Developer ID、未做公证（notarization）**。
- 从 Gitee 下载的 DMG/zip 会被打上 `com.apple.quarantine`。挂载 DMG、把 app 拖进
  `/Applications` 后首次打开，会提示「无法打开，因为 Apple 无法验证此 App 是否包含恶意软件」。
- 用户侧两种绕过方式：
  1. 在 Finder 里 **右键（或 Control+点击）→「打开」**，在弹框里再点一次「打开」。只需一次。
  2. 终端：`xattr -dr com.apple.quarantine /Applications/Mote.app`
     （针对**已拷贝到本地**的 app；对挂载卷上的只读 app 执行没有意义）。
- 想彻底去掉提示只能做 Developer ID 签名 + `notarytool` 公证 + `stapler` 装订，那需要
  付费开发者账号与证书；换容器格式、改压缩方式、加图标背景都不会改变这个行为。

与 zip 的分工：DMG 卷内只有 app（`samples/`、`licenses/` 不在卷里；字体 OFL 文本本身已
编进 app 的 qrc `:/fonts/OFL.txt`）；zip 仍保留 `samples/` 与 `licenses/`，适合需要示例文件的场合。

**Gitee 发行版限制**（2026-11-10 查 Gitee 帮助中心）：单个附件不能超过 **100 MB**
（GVP 项目 200 MB）；每个仓库附件总量不超过 **1 GB**（推荐项目 5 GB、GVP 项目 20 GB），
统计范围包含仓库附件与发行版附件。本 DMG 34,252,460 字节约 **32.7 MiB**，约为单附件上限的
三分之一，在限制内；zip 约 29.5 MiB，两个都传合计约 62 MiB，也远低于 1 GB 总量。
若以后包体接近 100 MB（例如引入 QtWebEngine 或去掉压缩），需要拆包或改用其他分发方式。

上传步骤：

1. 打开仓库页 `https://gitee.com/lin-yuwei168/mote-md`，在顶部/右侧找到 **「发行版」**（Release）；
2. 点 **「新建发行版」**（或「创建 Release」），填标签（如 `v0.3.0`）、发行版标题与说明；
3. 在 **「上传附件」** 区域选择 `dist/Mote-macOS-0.3.0.dmg`（可同时添加 `dist/Mote-macOS.zip`）；
4. 需要的话勾选「这是一个预览版本」，然后 **「发布」**；
5. 发布后在发行版详情页能看到附件与大小，下载链接形如
   `https://gitee.com/lin-yuwei168/mote-md/releases/download/<标签>/Mote-macOS-0.3.0.dmg`。

> 不确定项：Gitee 页面按钮文案与附件区名称可能随改版变化，以你打开时的界面为准；
> 本机没有 Gitee 账号登录态，未实际走一遍上传。

---


## 2. Windows：脚本已提供，**需在 Windows 机器上执行**

> 本节所有内容均为操作说明。当前 macOS 机器无法编译 Windows 程序，
> `Mote.exe` 与 `Mote-Windows.zip` 需在 Windows 机器上构建产出。
>
> 从 macOS 搬迁到 Windows 的分步操作见 **[WINDOWS-FROM-MACOS.md](WINDOWS-FROM-MACOS.md)**；
> 从零装机（Build Tools 组件、WebView2 SDK、验证命令）见
> **[docs/windows-native-build-setup.md](../docs/windows-native-build-setup.md)**。

### 2.1 前置条件

1. Windows 10/11 x64。
2. Visual Studio 2022 生成工具（含「使用 C++ 的桌面开发」）与 Windows SDK，
   并从开始菜单打开 **「x64 Native Tools Command Prompt for VS 2022」**。
3. CMake ≥ 3.25、Ninja。
4. WebView2 SDK：`WEBVIEW2_SDK` 指向 NuGet 包解出的 `pkg` 目录。
5. WebView2 Evergreen Runtime（Win11 一般自带；缺失时从微软官网安装）。

### 2.2 一键打包（推荐）

在项目根目录的 PowerShell 中执行：

```powershell
$env:WEBVIEW2_SDK = "C:\dev\webview2sdk\pkg"
cmake -S native -B build-native-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build-native-ninja
powershell -ExecutionPolicy Bypass -File packaging\package_windows_native.ps1
```

脚本会：

1. `cmake --build` 构建 Release（`-SkipBuild` 跳过编译，`-BuildDir` 指定构建目录）；
2. 清理并新建 `dist\Mote-Windows\`；
3. 复制 `Mote.exe` 与 `WebView2Loader.dll`；
4. 复制 `web\`、`fonts\`、`samples\` 与 `licenses\`；
5. 自检：产物内不得出现 `Qt6*.dll` 与 `platforms\qwindows.dll`，`dumpbin /dependents`
   只允许系统 DLL（`api-ms-*` 放行）与 `WebView2Loader.dll`；
6. `Compress-Archive` 压成 `dist\Mote-Windows.zip`。

产物结构：

```
dist\Mote-Windows\
├── Mote.exe
├── WebView2Loader.dll
├── web\                    （editor.html / editor.css / editor.js）
├── fonts\JetBrainsMono-Light.ttf
├── licenses\JetBrainsMono-OFL.txt, LICENSE-AGPL-3.0.txt
└── samples\welcome.md, sample-diagram.png
```

### 2.3 可选：打安装包

绿色包就绪后，用 Inno Setup 6 打一个按用户安装的 `setup.exe`（版本号读仓库根 `VERSION.txt`）：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build_installer.ps1
# 产物：dist\Mote-Setup-<版本>.exe
```

脚本会校验绿色包里运行必需的文件齐全、不含 Qt 产物，再调用 `ISCC.exe` 编译
`packaging\mote.iss`；发布时 `publish_windows.ps1` 检测到该文件就一并上传，
不存在则只发绿色包。

### 2.4 手动逐步执行（不用脚本时）

```powershell
$env:WEBVIEW2_SDK = "C:\path\to\Microsoft.Web.WebView2\pkg"
cmake -S native -B build-native-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build-native-ninja

mkdir dist\Mote-Windows
copy build-native-ninja\Mote.exe dist\Mote-Windows\
copy build-native-ninja\web dist\Mote-Windows\web -Recurse
copy build-native-ninja\fonts dist\Mote-Windows\fonts -Recurse
copy "$env:WEBVIEW2_SDK\build\native\x64\WebView2Loader.dll" dist\Mote-Windows\
mkdir dist\Mote-Windows\samples
copy resources\samples\welcome.md dist\Mote-Windows\samples\
copy resources\samples\sample-diagram.png dist\Mote-Windows\samples\
mkdir dist\Mote-Windows\licenses
copy resources\fonts\OFL.txt dist\Mote-Windows\licenses\JetBrainsMono-OFL.txt
copy LICENSE dist\Mote-Windows\licenses\LICENSE-AGPL-3.0.txt
Compress-Archive -Path dist\Mote-Windows -DestinationPath dist\Mote-Windows.zip -Force
```

然后在干净 Windows 机器上解压 zip，双击 `Mote.exe`，按第 3 节清单逐项确认。

### 2.5 Windows 注意事项

- **静态 CRT**：CMake 用 `/MT` 链接 MSVC 运行库，目标机器不需要额外安装
  VC++ Redistributable。
- 程序图标与文件版本由 CMake 从 `platform/win/app.rc.in` 生成 `app.rc` 后编译进 exe，
  图标取自 `resources/win/app.ico`，版本号取自仓库根 `VERSION.txt`，都不需要手工同步。
- WebView2 运行时由目标机器提供（Evergreen），不随包分发；缺运行时时应用会提示安装。
- 未做代码签名，SmartScreen 可能提示「Windows 已保护你的电脑」，
  点「更多信息 → 仍要运行」即可。

---

## 3. 交付前自检清单（两个平台通用）

- [ ] 解压后直接双击启动，无「缺少 DLL / WebView2 运行时」报错
- [ ] 打开 `samples/welcome.md`：标题、列表、代码块底色、表格边框、图片均正常
- [ ] 代码块按围栏语言着色（关键字/字符串/注释/数字/函数/类型名），无语言标识的代码块保持纯文本
- [ ] 代码块与行内代码使用 JetBrains Mono 字形（不需系统预装），包内 `licenses/` 含 OFL 授权
- [ ] 代码块行距明显宽于正文行内代码，浅灰底连续无白缝，上下留白大致对称
- [ ] 代码块左侧有行号栏与 1px 浅灰分隔线，行号与代码逻辑行一一对应；长行横向滚动、缩放时编号不重复、分隔线不缺失
- [ ] 选中代码块复制，剪贴板内容不含行号
- [ ] 正文字号 16.5pt、字重偏细，标题 Bold/DemiBold 仍与正文有明显层级差
- [ ] 左侧目录层级正确，点击可跳转，滚动时当前标题高亮
- [ ] 缩放正常（macOS 为 `Cmd+=` / `Cmd+-` / `Cmd+0`，100% 即 16.5pt，范围 0.6–2.6），侧栏布局不受影响
- [ ] 源码模式（macOS 为 `Cmd+E`，备选 `Cmd+/`）可在整篇 Markdown 与所见即所得之间切换，切换后撤销历史与未保存标记仍连续
- [ ] 修改后保存（macOS 为 `Cmd+S`），重新打开文件内容已更新；关闭时有未保存提示
- [ ] 拖拽 `.md` 文件到窗口可打开；`Ctrl+O` 文件对话框可打开
- [ ] 新建（macOS 为 `Cmd+N`）得到空白文档，标题「未命名 - Mote」，目录/查找/缩放已复位；有未保存修改时先问「保存 / 不保存 / 取消」
- [ ] 大文档（数百 KB、含大量代码块）打开无长时间卡顿，可交互时间在 0.2 s 量级（见 1.6）
- [ ] 任务列表 `- [ ]` / `- [x]` 显示为复选框，点击可切换；复制出去仍是标准 Markdown 任务列表
- [ ] 状态栏右侧显示「中文 N 字 · 英文 M 词」，与文档实际字数一致
- [ ] 深色模式：默认跟随系统外观；`Cmd+Shift+D` 可手动切换，切换后正文、代码块、表格、目录配色变化，块位置不跳动
- [ ] 关闭有未保存修改的文档时，会弹出保存提示

---

## 4. 资源与路径策略

- 前端只有一份：`resources/web/`（`editor.html` / `editor.css` / `editor.js`）。
  构建时 CMake 把它拷进 macOS bundle 的 `Contents/Resources/web/`，Windows 则拷到 exe 同级的
  `web/`；运行时不依赖仓库路径。
- 内置示例 `resources/samples/welcome.md` 同样随构建拷入；发布包额外在包内保留
  `samples/` 与 `licenses/`，方便用户直接打开示例。
- 图标：macOS 用 `resources/icons/app.icns`（`MACOSX_PACKAGE_LOCATION Resources`），
  Windows 用 `platform/win/app.rc.in` 引用 `resources/win/app.ico`，版本号字段由 CMake 填充。
- 代码字体 JetBrains Mono 以 `.ttf` 形式放在 `resources/fonts/`，构建时拷进产物，
  运行时不依赖系统已安装字体；`OFL.txt` 随发布目录的 `licenses/` 提供。
  回退链为 JetBrains Mono → Menlo → SF Mono → 系统等宽，改动字体时不要破坏这条链。
- 语法高亮与块模型全部在 `resources/web/editor.js`，不依赖第三方解析/高亮库；
  分层与消息协议见 `docs/WEBVIEW-ARCHITECTURE.md`。

---

## 5. 未能完成 / 受限的部分

1. **Windows 包未在本机复现**：本机是 macOS，没有 MSVC，
   无法交叉编译。产物已由 Windows 机器按第 2 节脚本构建并校验，本机未重复构建。
2. **仅 arm64 架构**：macOS 包只包含 arm64 切片，Intel Mac 需要重新构建。
3. **未做 Apple 公证（notarization）**：没有 Developer ID 证书时只有 Ad-hoc 签名，
   从网络下载的 zip / dmg 首次打开可能被 Gatekeeper 拦截，需要右键「打开」或去掉
   quarantine 属性（见 1.14 的历史记录）。
4. **拖拽打开**：功能已实现（`dragEnterEvent`/`dropEvent`），但当前环境无法用自动化
   模拟真实的 Finder 拖放；其余打开方式（文件对话框、命令行传入路径）已实际验证。
5. **导出 PDF 未提供**（本批次实测结论，不是遗漏）：WebKit 在 macOS 上只给两条路，都不满足
   「可靠」——
   - `WKPDFConfiguration`（`createPDFWithConfiguration:`，macOS 11+）的配置对象只有 `rect` 与
     `allowTransparentBackground`，**没有分页 API**。实测能生成 PDF（779×1168 pt 单页、
     138 KB、文字可选中），但整篇文档永远是**一张长页**，页数随文档增长而非 A4 分页。
   - 唯一的分页路径 `printOperationWithPrintInfo:`（macOS 11+）实测失控：三种参数组合
     （`NSFitPagination`+离屏窗口 / `NSClipPagination`+可见窗口 / 全默认 `NSPrintInfo`+有标题栏窗口）
     都在 `runOperation` 里持续写盘不返回，20 秒内产出 **408 MB / 407 MB / 982 MB** 后被强制杀掉，
     没有一次正常结束。属于 WebKit 打印实现的问题，不是参数写错。
   
   结论：不做半成品。若以后要做，可行方向是拿导出好的自包含 HTML 交给系统打印面板由用户
   「存储为 PDF」，而不是绕开用户在应用内静默生成。
6. **链接的复制验证方式**：`Cmd+A`/`Cmd+C` 在 WKWebView 外壳里不会产生选区（历史遗留），
   因此链接的「复制出标准 Markdown」走产品自身的 `copy` 处理器 + 合成 `DataTransfer` 读取
   `text/plain` 验证；真实 `Cmd+C` 写入系统剪贴板的最终结果仍需人工确认。

---

## 6. Windows 原生薄外壳（阶段 B）打包与基线

**这一节是 Windows 的发布路径**：产物 `dist/Mote-Windows/` 与 `dist/Mote-Windows.zip`，
不含 Qt。

### 6.1 打包

在已加载 MSVC 2022 x64 环境的 PowerShell 中：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\package_windows_native.ps1
```

- 默认构建目录 `build-native-ninja`（可用 `-BuildDir` 覆盖），`-SkipBuild` 跳过编译。
- 默认产物名 `Mote-Windows`（可用 `-OutName` 覆盖）。
- 产物 `dist/Mote-Windows/`：`Mote.exe`、`WebView2Loader.dll`、`web/`、`fonts/`、
  `samples/`、`licenses/`；同名 zip。
- 自检：产物内不得出现 `Qt6*.dll` 与 `platforms/qwindows.dll`；`dumpbin /dependents`
  只允许系统 DLL（`api-ms-*` 放行）。
- 实测（2026-11-14，MSVC 14.44 / WebView2 Runtime 157.0.4341.46）：

| 项 | 值 |
|---|---|
| Mote.exe | 632,832 字节（静态 CRT） |
| WebView2Loader.dll | 165,968 字节 |
| zip | 607,489 字节 |
| 依赖 | USER32 / ole32 / ADVAPI32 / SHLWAPI / SHELL32 / COMCTL32 / KERNEL32 |
| Qt 文件 | 0 |

绿色包就绪后可按 2.3 打安装包（Inno Setup 6，产物 `dist/Mote-Setup-<版本>.exe`）。

### 6.2 截图与页面基线

`MOTE_EVAL`、`MOTE_SNAPSHOT`、`MOTE_SNAPSHOT_DELAY` 在 Windows 与 mac 同名同义；
Windows 用 `CapturePreview` 直接渲染（不依赖截屏）。基线命令：

```powershell
$env:MOTE_LOG="$env:TEMP\mote-snap.log"; $env:MOTE_KEYLOG="1"
$env:MOTE_EVAL="document.querySelectorAll('.block').length"
$env:MOTE_SNAPSHOT="$env:TEMP\mote-snap.png"
dist\Mote-Windows\Mote.exe dist\Mote-Windows\samples\welcome.md
```

实测：`JSLOG EVAL 44`（44 个 block），`NATIVE stats cjk=909 words=345`，
PNG 1180×800 / 105,464 字节，页面正常渲染。

mac 对照基线需在 mac 上以同一命令产出后比对（当前 Windows 机器无法运行 mac 版），
比对时关注：正文排版、代码块高亮、状态栏样式（类名不同但样式应一致）。

