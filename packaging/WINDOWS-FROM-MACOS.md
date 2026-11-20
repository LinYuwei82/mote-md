# 从 macOS 把本项目搬到 Windows 打包（分步操作指南）

面向对象：代码已经在 macOS 上写好、能正常编译运行，现在想在一台 Windows 机器上
产出可分发的 `Mote-Windows.zip`（安装版 `Mote-Setup-<版本>.exe` 为可选项）。

先说清楚三件事：

1. **Windows 包必须在 Windows 上构建**。本机是 macOS，没有 MSVC，也无法交叉编译；
   macOS 上打出的 `dist/Mote-macOS-native.zip` 里是 arm64 的 `.app`，Windows 用不了。
2. 整个流程只有一条主线：**只带源码去 Windows → 装 Build Tools / CMake / WebView2 SDK
   → 跑 `tools\package\package_windows.ps1` → 拿 `dist\Mote-Windows.zip`（可选再跑
   `packaging\build_installer.ps1` 出安装版）→
   在干净的 Windows 机器上验证**。
3. Windows 包不链接、也不分发 Qt：外壳是 Win32 + WebView2，只依赖系统组件与
   `WebView2Loader.dll`。

---

## 0. 一页速查

macOS（在项目根目录执行）：

```bash
# 只压构建真正需要的源码，排除 macOS 产物与临时文件（-X 丢弃扩展属性，避免 Windows 上出现 ._ 文件）
rsync -a --exclude 'dist' --exclude 'screenshots' --exclude '.DS_Store' --exclude 'build*' \
  /Users/lin/Projects/mote/ /tmp/Mote/
cd /tmp && zip -r -X ~/Desktop/Mote-src.zip Mote -x "*.DS_Store"
```

Windows（PowerShell，MSVC 环境）：

```powershell
$env:WEBVIEW2_SDK = "C:\dev\webview2sdk\pkg"
cd C:\dev\Mote
cmake -S native -B build-native-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build-native-ninja
powershell -ExecutionPolicy Bypass -File tools\package\package_windows.ps1
```

产物：`dist\Mote-Windows\` 与 `dist\Mote-Windows.zip`。

---

## 1. 拷贝什么、不拷贝什么

| 路径 | 是否带走 | 原因 |
| --- | --- | --- |
| `native/` | **必须** | CMake 工程入口（版本号读仓库根 `VERSION.txt`） |
| `core/` | **必须** | 两端共用的核心与单测 |
| `platform/` | **必须** | `mac/` 在 Windows 不编译，但 CMake 会按平台分支，带上更省事 |
| `resources/` | **必须** | 前端页面、字体、示例、`win/` 图标资源 |
| `VERSION.txt`、`LICENSE` | **必须** | 版本号唯一来源与许可证 |
| `tools/package/package_windows.ps1` | **必须** | Windows 打包脚本本体 |
| `packaging/build_installer.ps1`、`packaging/mote.iss` | 需安装包时 | Inno Setup 安装版构建（版本读 `VERSION.txt`） |
| `packaging/PACKAGING.md`、本文件 | 建议 | 交付说明与本文档，方便 Windows 侧照着核对 |
| `tools/make_icon.py` | 可选 | 只在重新生成图标时用，且依赖 macOS 的 `iconutil` |
| `build*` / `dist/` | **不要** | 构建与打包产物，脚本会重建 |
| `screenshots/` | 不要 | 只是文档截图，与构建无关 |
| `.git/` | **不要** | 仓库由 `git clone` 获取，不要直接拷贝工作目录 |
| `.DS_Store` | **不要** | macOS 的目录元数据，压缩时排除 |

最简单的做法其实是方式 C：直接 `git clone`，`.gitignore` 已经把产物排除干净。

---

## 2. 从 macOS 传到 Windows 的方式

### 方式 A：只压构建需要的源码

```bash
cd /Users/lin/Projects/mote

# 先 rsync 到干净临时目录，顺带排除 macOS 产物与 .DS_Store
rsync -a --exclude 'dist' --exclude 'screenshots' --exclude '.DS_Store' --exclude 'build*' \
  ./ /tmp/Mote/

# 再用 zip -X 打包：-X 不写入扩展属性，Windows 解压时不会出现 __MACOSX/ 与 ._ 文件
cd /tmp
zip -r -X ~/Desktop/Mote-src.zip Mote -x "*.DS_Store"
```

> 不要用 `ditto -c -k --sequesterRsrc` 打这种要跨平台的包：它会保留 macOS 扩展属性，
> 在 zip 里写成 `._xxx` 附属文件，Windows 解压后每个文件旁边会多一个 163 字节的垃圾文件。

把 `~/Desktop/Mote-src.zip` 拷到 Windows（U 盘、网盘、微信/飞书传文件均可），
在 Windows 上解压到 **纯英文、无空格的目录**，例如 `C:\dev\Mote`。

### 方式 B：走 Git

```bash
git clone <你的仓库地址> C:\dev\Mote
```

macOS 侧如有未推送的提交，先 `git push` 再 clone；双机协作流程见 `docs/COLLAB.md`。

### 不推荐的方式

- **直接拖整个目录到 U 盘 / 网盘同步目录**：会把 `.DS_Store` 和 FinderInfo 扩展属性
  带过去，部分工具解压时会生成 `._xxx` 垃圾文件；请用 zip。
- **用 iCloud「文稿」目录中转**：扩展属性会导致解压异常，中转请放在普通目录。
- **在 Windows 上只拷 `dist/` 里的 macOS 包**：无法运行，见开头第 1 点。

---

## 3. Windows 侧装什么

完整装机步骤（Build Tools 组件 ID、Windows SDK、CMake/Ninja、WebView2 SDK 与 Runtime、
逐项验证命令）见 [docs/windows-native-build-setup.md](../docs/windows-native-build-setup.md)。

一句话版本：

- VS 2022 生成工具（MSVC x64）+ Windows SDK
- CMake ≥ 3.25、Ninja
- WebView2 SDK（`WEBVIEW2_SDK` 指向 NuGet 包解出的 `pkg` 目录）
- WebView2 Evergreen Runtime（Win11 一般自带）

### 3.1 路径规范（很重要）

构建工具对路径里的空格/中文支持不稳定。请把项目放在：

- ✅ `C:\dev\Mote`、`D:\work\Mote`
- ❌ `C:\Users\张三\Desktop\新建文件夹\`、`C:\My Projects\Mote Project\`
- ❌ OneDrive / 坚果云同步目录（文件被占用会导致清理产物目录失败）

---

## 4. 执行打包

```powershell
$env:WEBVIEW2_SDK = "C:\dev\webview2sdk\pkg"
powershell -ExecutionPolicy Bypass -File tools\package\package_windows.ps1
```

脚本按 6 步执行：

1. `cmake --build` 构建 Release（`-SkipBuild` 可跳过，`-BuildDir` 可指定构建目录）；
2. 清理并创建 `dist\Mote-Windows\`；
3. 复制 `Mote.exe` 与 `WebView2Loader.dll`；
4. 复制 `web/`、`fonts/`、`samples/` 与 `licenses/`；
5. 自检：产物里不得出现 Qt DLL / `platforms\qwindows.dll`，`dumpbin` 依赖只允许系统 DLL
   与 `WebView2Loader.dll`；
6. `Compress-Archive` 压成 `dist\Mote-Windows.zip`（exe+loader > 3 MB 或 zip > 2 MB 会直接失败）。

构建号 `MOTE_BUILD` 必须与发布清单一致：脚本会提示本次构建写进 `CMakeCache.txt` 的值，
发布时 `publish_windows.ps1` 要用同一个构建号。

### 4.1 可选：打安装包

绿色包就绪后，用 Inno Setup 6 产出按用户安装的 `setup.exe`：

```powershell
choco install innosetup --yes --no-progress   # 或 winget install JRSoftware.InnoSetup
powershell -ExecutionPolicy Bypass -File packaging\build_installer.ps1
# 产物：dist\Mote-Setup-<版本>.exe（版本读仓库根 VERSION.txt）
```

脚本会先断言绿色包里 `Mote.exe`、`WebView2Loader.dll`、`web\editor.html`、
`fonts\JetBrainsMono-Light.ttf` 齐全且不含 Qt 产物，再编译 `packaging\mote.iss`。
发布时该文件存在就一并上传，不存在则只发绿色包。

---

## 5. 产物与结构

```
dist\Mote-Windows.zip
└── Mote-Windows\
    ├── Mote.exe
    ├── WebView2Loader.dll
    ├── web\                          ← 编辑器页面（editor.html/css/js）
    ├── fonts\                        ← JetBrains Mono
    ├── samples\welcome.md, sample-diagram.png
    └── licenses\JetBrainsMono-OFL.txt, LICENSE-AGPL-3.0.txt

dist\Mote-Setup-<版本>.exe            ← 可选安装版，内容与绿色包一致
```

exe 只链接系统 DLL；WebView2 运行时由目标机器提供（Evergreen），不随包分发。
打包机另可选产出 `dist\Mote-Setup-<版本>.exe`（Inno Setup 安装版，见 4.1），内容与绿色包一致。
未做 Windows 代码签名。

---

## 6. 怎么验证

### 6.1 在打包机上先粗查

- 确认 `dist\Mote-Windows\` 里没有 `Qt6*.dll` 与 `platforms\qwindows.dll`（脚本已自检）；
- `dumpbin /dependents dist\Mote-Windows\Mote.exe` 只应出现系统 DLL 与 `WebView2Loader.dll`。

### 6.2 关键一步：换一台**干净**的 Windows 机器

把 zip 拷过去（U 盘/网盘），解压到任意目录，双击 `Mote.exe`。

| 检查项 | 期望 |
| --- | --- |
| 启动 | 无控制台黑框；缺 WebView2 Runtime 时提示安装，而不是闪退 |
| 打开文档 | `Ctrl+O` 打开 `samples\welcome.md`，标题/列表/表格/图片正常 |
| 代码高亮 | C++/Python/JS/JSON/HTML/Shell/SQL 代码块分别着色 |
| 行号 | 代码块左侧有行号，空行也有编号，编号右对齐 |
| 复制 | 选中整段代码 `Ctrl+C`，粘贴到记事本：只有代码，没有行号 |
| 字体 | 代码为 JetBrains Mono 字形（无需系统安装） |
| 编辑保存 | `Ctrl+E` 编辑、`Ctrl+S` 保存，重新打开内容已更新 |
| 拖拽 | 把 `.md` 拖进窗口可打开 |
| 快捷键 | `Ctrl` 代替 `Cmd`；`Ctrl+Shift+S` / `Ctrl+Alt+E` 与 mac 侧行为一致 |
| 高 DPI | 200%/250% 缩放下行号栏、分隔线与代码对齐 |

### 6.3 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 窗口空白 / 提示缺 WebView2 | 目标机器没有 Evergreen Runtime | 安装 WebView2 Runtime 后重试 |
| 提示缺 `WebView2Loader.dll` | 打包时没复制 Loader | 重新跑 `package_windows.ps1`（确认 `WEBVIEW2_SDK`） |
| SmartScreen「Windows 已保护你的电脑」 | 未签名 | 点「更多信息 → 仍要运行」；正式发布需购买代码签名证书 |
| `cmake --build` 失败 | 没在 MSVC 环境，或 `WEBVIEW2_SDK` 未设置 | 在 VS 开发者环境重开 PowerShell，按第 3 节核对 |
| 第 2 步清理失败 | `dist` 里有正在运行的 `Mote.exe` 或被资源管理器占用 | 关闭占用后重试 |

---

## 附：手动命令（不用脚本时）

```powershell
$env:WEBVIEW2_SDK = "C:\dev\webview2sdk\pkg"
cmake -S native -B build-native-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build-native-ninja

mkdir dist\Mote-Windows
copy build-native-ninja\Mote.exe dist\Mote-Windows\
copy build-native-ninja\web dist\Mote-Windows\web -Recurse
copy build-native-ninja\fonts dist\Mote-Windows\fonts -Recurse
copy "$env:WEBVIEW2_SDK\build\native\x64\WebView2Loader.dll" dist\Mote-Windows\
Compress-Archive -Path dist\Mote-Windows -DestinationPath dist\Mote-Windows.zip -Force
```

与脚本相比，手动步骤**不会**替你复制 `samples/`、`licenses/`，也不会做依赖自检。
