# 从 macOS 把本项目搬到 Windows 打包（分步操作指南）

面向对象：代码已经在 macOS 上写好、能正常编译运行，现在想在一台 Windows 机器上
产出可分发的 `Mote-Windows.zip`。

先说清楚三件事：

1. **Windows 包目前没有生成**。本机是 macOS，没有 MSVC / MinGW，也没有 Windows 版
   `windeployqt`，无法交叉编译；本文所有 Windows 侧结果都需要你实际执行后确认。
2. **macOS 上打出的 `dist/Mote-macOS.zip` 不能拿到 Windows 用**，
   里面是 arm64 的 `.app`。Windows 必须用源码重新编译。
3. 整个流程只有一条主线：**只带源码去 Windows → 装 Qt 与工具链 → 跑
   `packaging\package_windows.bat` → 拿 `dist\Mote-Windows.zip` →
   在没装 Qt 的机器上验证**。

---

## 0. 一页速查

macOS（在项目根目录执行）：

```bash
# 只压构建真正需要的源码，排除 macOS 产物与临时文件（-X 丢弃扩展属性，避免 Windows 上出现 ._ 文件）
rsync -a --exclude 'dist' --exclude 'screenshots' --exclude '.DS_Store' --exclude 'build' \
  /Users/lin/Projects/mote/ /tmp/Mote/
cd /tmp && zip -r -X ~/Desktop/Mote-src.zip Mote -x "*.DS_Store"
```

Windows（CMD，推荐 MSVC 方案）：

```bat
set QTDIR=C:\Qt\6.11.1\msvc2022_64
set PATH=%QTDIR%\bin;%PATH%
cd /d C:\dev\Mote
packaging\package_windows.bat
```

产物：`dist\Mote-Windows.zip`。

---

## 1. 拷贝什么、不拷贝什么

先看本仓库的真实结构（`du` 实测）：

| 路径 | 大小 | 是否带走 | 原因 |
| --- | --- | --- | --- |
| `src/` | 88 KB | **必须** | 8 个源文件（`main.cpp`、`mainwindow.*`、`previewview.*`、`codehighlighter.*`），约 2080 行，全部代码都在这里 |
| `resources/` | 1.4 MB | **必须** | `resources.qrc` 引用的图标、样式、三套 JetBrains Mono 字体（约 0.8 MB）、示例 md 与图片；`win/app.rc` + `win/app.ico` 决定 exe 图标 |
| `Mote.pro` | 4 KB | **必须** | qmake 工程文件；`win32 { RC_FILE = resources/win/app.rc }` 分支只在这里 |
| `packaging/package_windows.bat` | 4 KB | **必须** | Windows 打包脚本本体 |
| `packaging/PACKAGING.md`、本文件 | 约 42 KB | 建议 | 交付说明与本文档，方便 Windows 侧照着核对 |
| `packaging/macos/` | 少量 | 可不带 | `Info.plist` 只给 macOS 用，留着也不影响 Windows 构建 |
| `tools/make_icon.py` | 8 KB | 可选 | 只在重新生成图标时用，且依赖 macOS 的 `iconutil`；Windows 上不需要 |
| `build/` | 当前不存在 | **不要** | Windows 脚本每次 `rmdir /s /q` 重建；带过去只会被删 |
| `dist/` | 29.4 MB | **不要** | 里面是 macOS 的 zip（arm64 `.app`），Windows 用不了；脚本第一步也会整目录删除 |
| `screenshots/` | 18 MB | 不要 | 只是文档截图，与构建无关 |
| `.git/` | — | **不要** | 仓库由 `git clone` 获取，不要直接拷贝工作目录；`.git/` 交给 git 管理 |
| `.DS_Store` | 4 个（根目录、`packaging/`、`resources/`、`screenshots/`） | **不要** | macOS 的目录元数据，Windows 上无用，压缩时排除 |

结论：**最小可构建集合 = `src/` + `resources/` + `packaging/package_windows.bat` +
`Mote.pro`**，原始体积约 1.5 MB，压缩后更小。

`resources/` 里不要漏掉 `fonts/`：代码块和行号用的 JetBrains Mono 是通过 qrc 编进
可执行文件的，漏了字体不会导致编译失败，但运行时会回退到 Consolas/Menlo，
代码观感与 macOS 截图不一致。

---

## 2. 从 macOS 传到 Windows 的方式

### 方式 A（推荐）：只压构建需要的源码

```bash
cd /Users/lin/Projects/mote

# 先 rsync 到干净临时目录，顺带排除 macOS 产物与 .DS_Store
rsync -a --exclude 'dist' --exclude 'screenshots' --exclude '.DS_Store' --exclude 'build' \
  ./ /tmp/Mote/

# 再用 zip -X 打包：-X 不写入扩展属性，Windows 解压时不会出现 __MACOSX/ 与 ._ 文件
cd /tmp
zip -r -X ~/Desktop/Mote-src.zip Mote -x "*.DS_Store"
```

实测结果：zip 约 756 KB、47 个条目，解压后约 1.58 MB，无 `__MACOSX/` 与 `._` 文件。

> 不要用 `ditto -c -k --sequesterRsrc` 打这种要跨平台的包：它会保留 macOS 扩展属性，
> 在 zip 里写成 `._xxx` 附属文件，Windows 解压后每个文件旁边会多一个 163 字节的垃圾文件。

把 `~/Desktop/Mote-src.zip` 拷到 Windows（U 盘、网盘、微信/飞书传文件均可），
在 Windows 上解压到 **纯英文、无空格的目录**，例如 `C:\dev\Mote`。

### 方式 B：只压一份清单里的东西

不想 rsync 时，直接指定路径打包（`zip` 会保留相对路径）：

```bash
cd /Users/lin/Projects/mote
zip -r -X ~/Desktop/Mote-src.zip \
  src resources packaging/package_windows.bat packaging/PACKAGING.md packaging/WINDOWS-FROM-MACOS.md \
  tools Mote.pro \
  -x "*.DS_Store"
```

### 方式 C：走 Git

仓库已经是 git 仓库，并带有 `.gitignore`（`build/`、`dist/`、`screenshots/` 约 18 MB 等
都已排除），不要重新 `git init` 或覆盖 `.gitignore`。直接在 Windows 上 clone：

```bash
git clone <你的仓库地址> C:\dev\Mote
```

macOS 侧如有未推送的提交，先 `git push` 再 clone；双机协作流程见 `docs/COLLAB.md`。

### 不推荐的方式

- **直接拖整个目录到 U 盘 / 网盘同步目录**：会把 `.DS_Store` 和 FinderInfo 扩展属性
  带过去，部分工具解压时会生成 `._xxx` 垃圾文件；请用 zip。
- **用 iCloud「文稿」目录中转**：与 macOS 打包脚本里遇到的是同一个问题
  （扩展属性导致签名/解压异常），中转请放在普通目录。
- **在 Windows 上只拷 `dist/` 里的 macOS 包**：无法运行，见开头第 2 点。

---

## 3. Windows 侧装什么

### 3.1 版本选择

| 项目 | 建议 | 说明 |
| --- | --- | --- |
| Qt | **最低 6.5，推荐 6.11.1**（与本机 6.11.1 对齐，版本要求以 `PACKAGING.md` 2.1 为准） | 工程使用 `QT += core gui widgets`，代码里用了 Qt 6 的 Markdown 导入结果（`QTextBlockFormat::BlockCodeLanguage`、`nonBreakableLines`）。不同小版本的 Markdown 导入细节可能有差异，会影响代码块首行、表格空块这类行为 |
| 备选 | 更低的小版本（如 6.8 LTS）未验证 | 若使用需按第 7 节重新验证上述行为 |
| 位数 | 只支持 64 位 | 不要装 32 位套件 |
| 编译器 | MSVC 2022（推荐）或 MinGW 64-bit | 二者**不能混用**：用 MSVC 的 Qt 必须配 MSVC 工具链，反之亦然 |
| Qt5 | 不支持 | 工程用了 Qt 6 API（`QFont::setFamilies` 等） |

### 3.2 Qt Online Installer 勾选

安装路径建议 `C:\Qt`（无空格、无中文）。

需要勾的组件：

- `Qt` → `Qt 6.11.1` → **`MSVC 2022 64-bit`**（推荐）
  - 或 `MinGW 64-bit`（想「拷贝即用、不装 VC 运行库」时选）
- 选 MinGW 方案时，还要在 `Developer and Designer Tools` 里勾对应的
  **`MinGW 13.x 64-bit`**（Qt 6.8 起通常是 `mingw1310_64`，以 `C:\Qt\Tools` 下实际目录名为准）
- `Qt Creator`：可不装（我们用命令行 qmake）
- CMake / Ninja：不需要（工程是 qmake `.pro`）
- 额外库（Qt Charts、Qt PDF 等）：**都不需要**，本项目只依赖 Core/Gui/Widgets

官方 Qt 安装包已自带 Qt 的 Markdown 支持（md4c 编在 QtGui 内），无需额外装包；
Homebrew 版把 md4c 拆成了独立依赖，这是 macOS 侧的差异，不影响 Windows。

### 3.3 Visual Studio 生成工具（MSVC 方案）

Qt 的 MSVC 套件不自带编译器，需要：

1. 安装 **Visual Studio 2022 生成工具**（Build Tools）；
2. 工作负载勾选 **「使用 C++ 的桌面开发」**，右侧确保包含
   **MSVC v143 - VS 2022 C++ x64/x86 生成工具** 与 **Windows 10/11 SDK**；
3. 工程使用 `CONFIG += c++20`，v143 满足要求。

装完从开始菜单打开 **「x64 Native Tools Command Prompt for VS 2022」**
（即 `x64 Native Tools 命令提示符`）。

---

## 4. 环境准备（每开一个新命令行都要做）

### 4.1 MSVC 方案

最省事的做法：**直接用开始菜单里的 x64 开发者命令行**，它已经执行过 `VsDevCmd`，
`nmake`、`cl.exe` 都在 PATH 里。然后：

```bat
set QTDIR=C:\Qt\6.11.1\msvc2022_64
set PATH=%QTDIR%\bin;%PATH%
```

如果你是在普通 CMD 里手动进环境（路径按实际安装位置调整，Community 版把
`BuildTools` 换成 `Community`）：

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64
set QTDIR=C:\Qt\6.11.1\msvc2022_64
set PATH=%QTDIR%\bin;%PATH%
```

### 4.2 MinGW 方案

```bat
set QTDIR=C:\Qt\6.11.1\mingw_64
set PATH=%QTDIR%\bin;C:\Qt\Tools\mingw1310_64\bin;%PATH%
set USE_MINGW=1
```

`USE_MINGW=1` 是脚本判断「用 `mingw32-make` 而不是 `nmake`」的开关，漏了会出现
`'nmake' 不是内部或外部命令`。

### 4.3 三条命令自检

```bat
qmake -v
where qmake
where windeployqt
```

- `qmake -v` 输出 `Using Qt version 6.11.1`（或你所装的最低 6.5 及以上的版本），且路径在 `%QTDIR%\bin` 下；
- 再按方案确认 `where nmake`（MSVC）或 `where mingw32-make`（MinGW）能找到。

**不要同时把 MSVC 与 MinGW 两套 Qt 的 `bin` 放进同一个 PATH**：`where qmake`
会命中先出现的那一个，容易出现「qmake 用 A 套件、编译用 B 套件」的错配。

---

## 5. 执行打包

```bat
cd /d C:\dev\Mote
packaging\package_windows.bat
```

PowerShell 里当前目录不会自动执行，需要写 `.\packaging\package_windows.bat`。

脚本没有位置参数，全部靠两个环境变量：`QTDIR`（必填）、`USE_MINGW`（选 MinGW 时设为 1）。
它按 6 步执行：

1. 删除并重建 `build\`、`dist\`（**会整目录删除**，有正在运行的 exe 会失败）；
2. `qmake Mote.pro`（脚本内是带引号的绝对路径）；
3. `nmake /NOLOGO`，或 `mingw32-make -j%NUMBER_OF_PROCESSORS%`；
4. 复制 exe 到 `dist\Mote-Windows\`，执行
   `windeployqt --release --no-translations --no-system-d3d-compiler --no-opengl-sw`；
5. 删除 `opengl32sw.dll`、`d3dcompiler_47.dll`、`Qt6Pdf/Qml/Quick` DLL、`translations\` 下的其它 `.qm`、
   `qml\`、`*.pdb/*.exp/*.lib`，只保留 `translations\qtbase_zh_CN.qm`，并复制 `resources\samples\`；
6. `Compress-Archive` 压成 `dist\Mote-Windows.zip`。

成功时最后会打印：

```
打包完成：
  C:\dev\Mote\dist\Mote-Windows.zip
```

### 5.1 路径规范（很重要）

脚本本身给 `ROOT`、`BUILD`、`DIST`、qmake 参数都加了引号，但**构建工具本身对路径
里的空格/中文支持不稳定**（`nmake` 在含空格目录里常直接失败，MSVC 在中文路径下
偶发乱码）。请把项目放在：

- ✅ `C:\dev\Mote`、`D:\work\Mote`
- ❌ `C:\Users\张三\Desktop\新建文件夹\`、`C:\My Projects\Mote Project\`
- ❌ OneDrive / 坚果云同步目录（文件被占用会导致第 1 步删除失败）

---

## 6. 产物与结构

```
dist\Mote-Windows.zip
└── Mote-Windows\
    ├── Mote.exe
    ├── Qt6Core.dll / Qt6Gui.dll / Qt6Widgets.dll / Qt6Network.dll ...
    ├── platforms\qwindows.dll          ← 少了它必然启动失败
    ├── imageformats\ (qgif/qico/qjpeg...)
    ├── styles\ (qmodernwindowsstyle.dll 等)
    └── samples\welcome.md, sample-diagram.png
```

MinGW 方案会额外带 `libgcc_s_seh-1.dll`、`libstdc++-6.dll`、`libwinpthread-1.dll`。

**与 macOS 包的已知差异（仓库现状，需你手工补一步）**：

- macOS 打包脚本会把 `JetBrainsMono-OFL.txt` 放进 `licenses/`，**Windows 脚本没有这一步**。
  发布前建议补上再重新压缩：

  ```bat
  mkdir dist\Mote-Windows\licenses
  copy resources\fonts\OFL.txt dist\Mote-Windows\licenses\JetBrainsMono-OFL.txt
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path 'dist\Mote-Windows' -DestinationPath 'dist\Mote-Windows.zip' -Force"
  ```
- MSVC 包**不含** VC 运行库；MinGW 包不含 VC 运行库也不需要。
- 未做 Windows 代码签名。

---

## 7. 怎么验证

### 7.1 在打包机上先粗查

- 看 `dist\Mote-Windows\platforms\qwindows.dll` 是否存在；
- 开发者命令行里可查依赖（仅 MSVC 有 `dumpbin`）：

  ```bat
  dumpbin /dependents build\release\Mote.exe
  ```
  若该路径不存在，换成脚本实际使用的 `build\Mote.exe`。

  应只出现 `Qt6Core.dll`、`Qt6Gui.dll`、`Qt6Widgets.dll` 与系统 DLL
  （`KERNEL32.dll`、`USER32.dll` 等），不应出现 `C:\Qt\...` 的绝对路径。

### 7.2 关键一步：换一台**没装 Qt** 的 Windows 机器

把 zip 拷过去（U 盘/网盘），解压到任意目录，双击 `Mote.exe`。
按本项目实际情况逐项确认：

| 检查项 | 期望 |
| --- | --- |
| 启动 | 无「This application failed to start because no Qt platform plugin could be initialized」；无控制台黑框 |
| 打开文档 | `Ctrl+O` 打开 `samples\welcome.md`，标题/列表/表格/图片正常 |
| 代码高亮 | C++/Python/JS/JSON/HTML/Shell/SQL 代码块分别着色，**每个代码块第一行也着色** |
| 行号 | 代码块左侧有行号与 1px 浅灰分隔线；空行也有编号；编号右对齐，与代码逻辑行一一对应 |
| 长行 | 横向滚动条拖动后，行号与分隔线随代码平移，编号不重复 |
| 复制 | 选中整段代码 `Ctrl+C`，粘贴到记事本：只有代码，没有行号 |
| 背景/行距 | 浅灰底连续无白缝，代码行距明显宽于正文行内代码 |
| 缩放 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` 正常，最大缩放下行号栏与分隔线不缺失、不溢出 |
| 字体 | 代码为 JetBrains Mono 字形（无需系统安装）；未装字体也不应出现方块 |
| 表格 | 表格紧跟代码块时，单元格行高一致（无半行错位） |
| 编辑保存 | `Ctrl+E` 编辑、`Ctrl+S` 保存，重新打开内容已更新 |
| 拖拽 | 把 `.md` 拖进窗口可打开 |

### 7.3 缺 DLL 的对应处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 提示缺 `VCRUNTIME140.dll` / `MSVCP140.dll` / `VCRUNTIME140_1.dll` | MSVC 构建，目标机器没装 VC 运行库 | 目标机器安装「VC++ 2015-2022 Redistributable (x64)」；或改用 MinGW 套件重新打包 |
| 提示缺 `libgcc_s_seh-1.dll` / `libstdc++-6.dll` / `libwinpthread-1.dll` | MinGW 运行库没被复制 | 确认打包时 `USE_MINGW=1`，且 PATH 里的 MinGW `bin` 与 Qt 套件匹配，重新打包 |
| 提示缺 `Qt6Core.dll` 等 | `windeployqt` 没执行成功，或 exe 与 `%QTDIR%` 版本不一致 | 用同一套 Qt 重跑第 5 节；检查 `where windeployqt` 是否指向 `%QTDIR%\bin` |
| 「no Qt platform plugin could be initialized」 | `platforms\qwindows.dll` 缺失 | 重新复制该目录；确认测试机没有设置 `QT_PLUGIN_PATH` / `QT_QPA_PLATFORM_PLUGIN_PATH` 指向别处 |
| SmartScreen「Windows 已保护你的电脑」 | 未签名 | 点「更多信息 → 仍要运行」；正式发布需购买代码签名证书 |

---

## 8. 常见报错与处理

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `[错误] 请先设置 QTDIR 指向 Qt 6 安装目录` | 没设 `QTDIR` | 按 4.1 / 4.2 设置后重开命令行 |
| `[错误] 找不到 ...\bin\qmake.exe` | `QTDIR` 写错（例如漏了 `msvc2022_64` 这一级，或版本号不对） | 到 `C:\Qt` 下核对实际目录名，例如 `C:\Qt\6.11.1\msvc2022_64` |
| `[错误] 找不到 ...\bin\windeployqt.exe` | 同上，或只装了 Qt Creator 没装 Qt 版本 | 用 Qt Maintenance Tool 补装对应套件 |
| `'nmake' 不是内部或外部命令` | 没在 VS 开发者命令行里，或没装 VS 生成工具 | 从「x64 Native Tools Command Prompt for VS 2022」打开；或按 4.1 手动 `call VsDevCmd.bat -arch=x64` |
| `'mingw32-make' 不是内部或外部命令` | MinGW 的 `bin` 不在 PATH | 把 `C:\Qt\Tools\mingwXXXX_64\bin` 加进 PATH |
| `fatal error C1083: 无法打开包括文件: "QApplication"`（或 `stddef.h` 找不到） | Qt 套件与编译器错配，或 PATH 里混进了另一套 Qt | 只保留一套 Qt 的 `bin`；MSVC 套件配 MSVC 命令行，MinGW 套件配 `USE_MINGW=1` |
| `nmake` 报 `fatal error U1077: ... 返回代码 0x2` | 具体编译错误在更早的输出里，`chcp 65001` 下中文可能显示异常 | 往上翻第一条 `error C....`/`error: ...`；把项目移到纯英文路径后重试 |
| qmake 成功但链接时找不到 `Qt6Widgets.lib` | `QTDIR` 对应的是 MinGW 版，却用 nmake 链接 | 换对应套件，或改用 `USE_MINGW=1` |
| `windeployqt` 报 `Unable to find dependent libraries of ...Mote.exe` | exe 与 windeployqt 不是同一套 Qt 构建 | 用 `%QTDIR%\bin\windeployqt.exe`，并确保 exe 由同一 `%QTDIR%` 的 qmake 生成 |
| 第 1 步 `rmdir` 失败 / 目录非空 | `dist`、`build` 里有正在运行的程序或资源管理器占用 | 关闭已启动的 `Mote.exe` 与打开这些目录的窗口后重试 |
| `Compress-Archive` 报路径过长/被占用 | 压缩时目标 zip 正在被打开，或路径过长 | 关闭占用；把项目放在较短路径（如 `C:\dev\Mote`） |
| `qmake` 在含空格路径下有奇怪报错 | 构建工具对空格路径支持差 | 移到 `C:\dev\Mote` 这类路径 |
| `rc.exe` / `app.ico` 相关错误 | `.rc` 里写的是相对路径 `app.ico` | 确认 `resources\win\app.rc` 与 `app.ico` 在同一目录；必要时把 `app.rc` 中的 `"app.ico"` 改成绝对路径 |

---

## 9. 我在 macOS 上无法验证、需要你在 Windows 上确认的部分

下面这些我**没有**在 Windows 上跑过，请不要把 macOS 的结论直接当成 Windows 的结论：

1. **能否编译通过**：MSVC v143 与 MinGW 13 下的 C++20 编译、qmake 生成 Makefile、
   `RC_FILE` 图标编译，均未在 Windows 实机执行。
2. **`windeployqt` 的实际输出**：具体复制了哪些 DLL/插件，需你在 `dist\Mote-Windows\`
   里核对（尤其 `platforms\qwindows.dll`）。
3. **Qt 版本行为差异**：若 Windows 上装的不是推荐的 6.11.1（版本要求见 3.1），Markdown 导入的
   `BlockCodeLanguage`、`nonBreakableLines`、表格空块行为可能与 macOS 不同，
   需重点复查「代码块首行高亮」「行号数量」「表格紧跟代码块」三项。
4. **Windows 字体渲染**：Light 字重与行号的观感在 DirectWrite 下与 macOS CoreText
   不完全相同；另外本程序只在系统存在 PingFang SC 时用它，Windows 上正文会走
   系统默认字体（中文回落到 Microsoft YaHei），ExtraLight 字重可能不存在而按 Regular 显示——
   这是预期差异，请确认中文可读、无方块。
5. **高 DPI**：Windows 200%/250% 缩放下，行号栏、分隔线与代码的对齐需实机确认。
6. **快捷键与弹窗**：`Ctrl` 代替 `Cmd`，文件对话框、拖拽打开、保存提示的实际表现。
7. **安全软件**：SmartScreen、企业杀软对未签名 exe 的拦截情况。

---

## 10. 附：不用脚本的手动命令

等价于 `packaging/package_windows.bat` 的主要步骤（在开发者命令行中、项目根目录执行）：

```bat
set QTDIR=C:\Qt\6.11.1\msvc2022_64
mkdir build
cd build
"%QTDIR%\bin\qmake.exe" ..\Mote.pro
nmake /NOLOGO
cd ..

mkdir dist\Mote-Windows
copy build\Mote.exe dist\Mote-Windows\
REM 若上面提示找不到文件，改用 copy build\release\Mote.exe dist\Mote-Windows\
"%QTDIR%\bin\windeployqt.exe" --release --no-translations --no-system-d3d-compiler --no-opengl-sw dist\Mote-Windows\Mote.exe
del dist\Mote-Windows\opengl32sw.dll
del dist\Mote-Windows\d3dcompiler_47.dll
```

与脚本相比，手动步骤**不会**替你清理 `qml\`、`translations\`、`*.pdb`，也不会复制
`samples\` 与打 zip，需要自己补。
