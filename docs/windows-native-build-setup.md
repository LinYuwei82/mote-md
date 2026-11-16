# 干净 Windows 11 上搭建 mote 原生构建环境

面向一台全新的 Windows 11 x64 机器，从零装到能编译、运行、跑单测。只装 Native（Win32 + WebView2）构建需要的东西；完整 Visual Studio IDE、Qt、MinGW、vcpkg 都不需要。

版本口径以本机实测（2026-11-14）为参照：

| 组件 | 本机实测 | 说明 |
|---|---|---|
| Visual Studio 生成工具 2022 | 17.14.x（安装器口径 17.14.45；`vswhere` 的 `installationVersion` 为 17.14.37906.3，两个字段含义不同） | 只要 Build Tools，不用 IDE |
| MSVC 工具集 | 14.44.35207 | `VC\Tools\MSVC\` 下的目录名 |
| cl | 19.44.35230 | `cl` 首行输出 |
| Windows SDK | 10.0.26100.0（本机另有 10.0.22621.0） | 两者都能编，推荐 26100 |
| CMake | 4.4.4 | 要求 ≥ 3.25 |
| Ninja | 1.13.2 | 可换 VS 生成器，但本机用 Ninja |
| WebView2 SDK | 1.0.2903.40 | NuGet 包 `Microsoft.Web.WebView2` |
| WebView2 Runtime | 157.0.4341.46 | Win11 一般自带，Evergreen |
| Qt | 6.9.3 `msvc2022_64` | **原生构建不需要**，只服务 Qt 回退路径 |

---

## 1. 装前检查

- Windows 11 x64，管理员权限（安装器需要提权）。
- 至少 15 GB 空闲磁盘（Build Tools + SDK 约 5–7 GB，加上构建目录约 1 GB）。
- Git（拉仓库）：`winget install --id Git.Git -e`，验证 `git --version`。
- 后续所有编译命令都要在**开发者环境**里执行，见 2.3。

## 2. 安装 VS 生成工具 2022

### 2.1 下载安装器

```powershell
Invoke-WebRequest "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile "$env:TEMP\vs_BuildTools.exe"
```

### 2.2 图形界面里勾什么

运行安装器，工作负载页只勾一项，右侧「安装详细信息 → 单个组件」再补两项：

| 位置 | 中文界面名称 | 组件 ID |
|---|---|---|
| 工作负载 | 使用 C++ 的桌面开发 | `Microsoft.VisualStudio.Workload.VCTools` |
| 单个组件 | MSVC v143 - VS 2022 C++ x64/x86 生成工具（最新） | `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` |
| 单个组件 | Windows 11 SDK (10.0.26100.0) | `Microsoft.VisualStudio.Component.Windows11SDK.26100` |

可选（想让 VS 自带一份 CMake/Ninja 时再勾，装了也不冲突）：

| 位置 | 中文界面名称 | 组件 ID |
|---|---|---|
| 单个组件 | 适用于 Windows 的 C++ CMake 工具 | `Microsoft.VisualStudio.Component.VC.CMake.Project` |

不勾：.NET 桌面开发、Web 开发、Azure、Python、C++/CLI、ATL/MFC、Windows 驱动。mote 一个都用不到。

### 2.3 静默安装（一行）

在 `vs_BuildTools.exe` 所在目录打开 cmd：

```bat
vs_BuildTools.exe --quiet --wait --norestart --nocache --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100
```

PowerShell 等价写法：

```powershell
Start-Process -Wait "$env:TEMP\vs_BuildTools.exe" -ArgumentList '--quiet','--wait','--norestart','--nocache','--installPath','"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"','--add','Microsoft.VisualStudio.Workload.VCTools','--add','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','--add','Microsoft.VisualStudio.Component.Windows11SDK.26100'
```

### 2.4 验证

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -products Microsoft.VisualStudio.Product.BuildTools -property installationPath,installationVersion
```

期望：打印安装路径，版本形如 `17.14.37906.3`（≥ 17.14 即可）。

进入开发者环境并确认编译器：

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
cl
```

期望首行：`用于 x64 的 Microsoft (R) C/C++ 优化编译器 19.44.35230 版`。

> 这一步只对当前 PowerShell 会话有效。每次新开窗口编译前都要先跑 `Launch-VsDevShell.ps1`，或者直接用开始菜单里的「Developer PowerShell for VS 2022」。

## 3. Windows SDK

装 2.2 里的 26100 就够；`10.0.22621.0` 可选，装了也不冲突。构建不指定版本，MSVC 默认取最新，因此多版本并存不会报错。

验证：

```powershell
Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\Include" -Directory | Select-Object -ExpandProperty Name
Test-Path "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64\user32.lib"
```

期望：列出 `10.0.26100.0`（或含 22621），第二条输出 `True`。

若第一条为空，说明 SDK 没随 Build Tools 装上，回到安装器「修改 → 单个组件」补勾。

## 4. CMake 与 Ninja

```powershell
winget install --id Kitware.CMake -e
winget install --id Ninja-build.Ninja -e
```

验证（新开窗口，让 PATH 生效）：

```powershell
cmake --version
ninja --version
```

期望：CMake ≥ `3.25`（本机 `4.4.4`），Ninja 输出 `1.13.2`。

注意两点：

- 若 `where.exe cmake` 指向 VS 自带或 Python 环境里的旧版，确认 `cmake --version` 那一行是 ≥ 3.25 的那份。
- `PATH` 里同时存在多个 CMake 不影响 configure，但版本不够会在第一步就报 `CMake 3.25 or higher is required`。

## 5. WebView2 SDK

Windows 端要头文件和 x64 的 `WebView2Loader.dll`。用 NuGet 包 `Microsoft.Web.WebView2` 1.0.2903.40（与验收时一致），解压到 `C:\dev\webview2sdk\pkg`：

```powershell
$ver = "1.0.2903.40"
New-Item -ItemType Directory -Force C:\dev\webview2sdk\pkg | Out-Null
Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$ver" -OutFile "$env:TEMP\webview2.zip"
Expand-Archive "$env:TEMP\webview2.zip" -DestinationPath C:\dev\webview2sdk\pkg -Force
```

验证：

```powershell
Test-Path C:\dev\webview2sdk\pkg\build\native\include\WebView2.h
Test-Path C:\dev\webview2sdk\pkg\build\native\x64\WebView2Loader.dll
```

期望两条都是 `True`。

CMake 的查找顺序：环境变量 `WEBVIEW2_SDK` → 默认 `C:/dev/webview2sdk/pkg`。放到默认路径可以不设变量；放别处就在编译前设置：

```powershell
$env:WEBVIEW2_SDK = "D:\sdk\webview2\pkg"
```

configure 阶段会检查 `<SDK>\build\native\include\WebView2.h`，缺失直接 `FATAL_ERROR`，不会拖到链接阶段才报错。

## 6. WebView2 Runtime

程序运行依赖 Evergreen Runtime（不是 SDK，SDK 只用于编译）。

```powershell
Get-ChildItem "C:\Program Files (x86)\Microsoft\EdgeWebView\Application" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
```

期望：出现类似 `157.0.4341.46` 的版本号。为空则安装：

```powershell
winget install --id Microsoft.EdgeWebView2Runtime -e
```

缺失时程序不会崩，会弹「缺少 WebView2 Runtime」的可操作提示。

## 7. Qt 6.9.3（仅 Qt 回退路径需要）

**原生构建完全不读 Qt**：`native/CMakeLists.txt` 没有任何 `find_package(Qt6)`，也不需要 `CMAKE_PREFIX_PATH`。Qt 只在你要跑仓库根 `Mote.pro` 那条回退路径（qmake + Qt 外壳）时才装。

装法：Qt 在线安装器（Qt Account 登录）→ 自定义安装 → 勾 `Qt 6.9.3` → `MSVC 2022 64-bit`，装到默认的 `C:\Qt`。`msvc2022_64` 对应 MSVC 14.4x 工具集，与上面的 14.44 匹配。

验证：

```powershell
Test-Path C:\Qt\6.9.3\msvc2022_64\bin\qmake.exe
& C:\Qt\6.9.3\msvc2022_64\bin\qmake.exe -query QT_VERSION
```

期望：`True` 与 `6.9.3`。

`CMAKE_PREFIX_PATH` 的用法（只为以后可能出现的 Qt/CMake 工程或 IDE 识别准备，对当前原生 configure 无作用）：

```powershell
$env:CMAKE_PREFIX_PATH = "C:\Qt\6.9.3\msvc2022_64"
# 永久写入用户环境变量（可选）
[Environment]::SetEnvironmentVariable("CMAKE_PREFIX_PATH", "C:\Qt\6.9.3\msvc2022_64", "User")
```

Qt 回退版走 qmake，不读这个变量：`qmake6 Mote.pro && nmake`（或 `jom`）。

## 8. 从零 configure + build

同一条 PowerShell 会话里按顺序执行：

```powershell
# 1) 开发者环境（Build Tools 没装 IDE 时用这个）
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64 -SkipAutomaticLocation

# 2) 仓库与环境变量
cd D:\projects\mote-md
$env:WEBVIEW2_SDK = "C:/dev/webview2sdk/pkg"

# 3) configure
cmake -S native -B build-native-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release

# 4) build
cmake --build build-native-ninja

# 5) core 单测
ctest --test-dir build-native-ninja --output-on-failure

# 6) 运行
.\build-native-ninja\Mote.exe .\resources\samples\welcome.md
```

说明：

- 工程根是 `native/`，不是仓库根；版本号自动从 `Mote.pro` 的 `VERSION` 读。
- `-G Ninja` 省略时会退回 VS 生成器（需要 MSBuild），同样能编，但命令要加 `--config Release`。想用多配置生成器时改成 `cmake -S native -B build-native-win -A x64`。
- 运行库是静态链接（`/MT`），目标机不需要 VC++ 可再发行包。

## 9. 跑通的判断依据

| 阶段 | 期望输出 |
|---|---|
| configure | 末尾 `-- Build files have been written to: <...>\build-native-ninja`，无 `FATAL_ERROR`（尤其不能有「未找到 WebView2 SDK」） |
| build | 最后几行是 `[N/N] Linking CXX executable Mote.exe`，无 `error`、无新增 `warning`（本机实测警告 0、错误 0） |
| 单测 | `100% tests passed out of 1`，`mote_core_tests ... Passed` |
| 产物 | `build-native-ninja\` 下同时有 `Mote.exe`、`WebView2Loader.dll`、`web\`、`fonts\`、`samples\` |
| 运行 | 窗口打开，显示 `welcome.md` 内容与状态栏字数统计；标题为 `welcome.md - Mote` |

产物目录长这样（由 CMake 的 POST_BUILD 自动准备）：

```
build-native-ninja\
  Mote.exe
  WebView2Loader.dll
  web\editor.html / editor.css / editor.js
  fonts\JetBrainsMono-Light.ttf
  samples\welcome.md
```

想再确认页面真的渲染出来了，加一行诊断：

```powershell
$env:MOTE_LOG = "$env:TEMP\mote-build.log"
$env:MOTE_EVAL = "document.querySelectorAll('.block').length"
.\build-native-ninja\Mote.exe .\resources\samples\welcome.md
Get-Content "$env:TEMP\mote-build.log" | Select-String "JSLOG EVAL|stats"
```

期望 `JSLOG EVAL 44`（示例文档 44 个块）与 `NATIVE stats cjk=909 words=345`。

## 10. 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| configure 报找不到 C/C++ 编译器 | 不在开发者环境 | 先跑 2.4 的 `Launch-VsDevShell.ps1` |
| 报「未找到 WebView2 SDK」 | `WEBVIEW2_SDK` 没设或路径层级不对 | 确认 `<路径>\build\native\include\WebView2.h` 存在 |
| 链接报找不到 `rc.exe` | 没装 Windows SDK | 安装器补勾 `Windows11SDK.26100` |
| 运行时提示缺 `WebView2Loader.dll` | SDK 里没有 x64 loader，POST_BUILD 跳过 | 检查 `<SDK>\build\native\x64\WebView2Loader.dll` |
| 启动弹「缺少 WebView2 Runtime」 | 目标机没装 Evergreen Runtime | 执行 6 节的 `winget install` |
| 页面空白、日志无 `page loaded` | `web/` 没拷到 exe 同级 | 确认产物目录有 `web\editor.html` 等三个文件 |

## 11. 明确不用装

- Visual Studio 完整 IDE（Community/Professional）——Build Tools 就够。
- .NET 桌面开发 / ASP.NET / Azure / Python / Node 等工作负载。
- 其它 Windows SDK 版本、Windows Driver Kit、DirectX SDK。
- Qt（原生构建；仅 Qt 回退路径需要）。
- MinGW、MSYS2、Strawberry Perl、vcpkg / Conan。
- C++/CLI、ATL/MFC、C++ 分析工具。
