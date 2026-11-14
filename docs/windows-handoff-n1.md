# Windows N1 实机验证交接单

给在 Windows 上验证阶段 B N1 的同事。macOS 侧已实现并验证，Windows 代码尚未在本机编译过，这份清单是唯一的验收依据。

## 1. 代码与边界

- 仓库：`mote`
- 分支：`native-shell`
- 提交：`fa9cb9b`（N1）；N0 为 `294c205`
- 不要修改 `main`、`platform/mac/`、`core/` 的既有行为
- 不要运行 Windows 打包（原生打包在 N5，当前 `packaging/package_windows.bat` 仍是 Qt 流程）
- 所有改动只提交到 `native-shell`

## 2. 环境

| 项 | 要求 |
|---|---|
| 系统 | Windows 10/11 x64 |
| 编译器 | Visual Studio 2022，含“使用 C++ 的桌面开发” |
| CMake | ≥ 3.25 |
| WebView2 SDK | NuGet `Microsoft.Web.WebView2` 1.0.2903.40，解压到 `C:\dev\webview2sdk\pkg`，或设 `WEBVIEW2_SDK` |
| WebView2 Runtime | Evergreen Runtime（Win11 一般自带；缺失时程序会弹提示） |

CMake 会在 configure 阶段检查 `%WEBVIEW2_SDK%\build\native\include\WebView2.h`，缺失会直接报错。

## 3. 构建与运行

```bat
cd /d <仓库路径>
set WEBVIEW2_SDK=C:\dev\webview2sdk\pkg
cmake -S native -B build-native-win -A x64
cmake --build build-native-win --config Release
build-native-win\Release\Mote.exe "C:\path\带空格 的中文.md"
```

构建后应自动生成：

```
build-native-win\Release\
  Mote.exe
  WebView2Loader.dll
  web\editor.html / editor.css / editor.js
  fonts\JetBrainsMono-Light.ttf
  samples\welcome.md
```

若缺少 `web\` 或 `WebView2Loader.dll`，先检查 CMake 第 92 行附近的拷贝命令是否执行。

## 4. 冒烟清单

按顺序做，任一项失败请停下并回报：

1. 启动后显示内置示例，底部状态栏显示“中文 N 字 · 英文 N 词”
2. 打开一个含图片的 `.md`，图片正常显示（相对路径）
3. 正文改一个字，标题出现 `*`
4. `Ctrl+S` 保存，`*` 消失
5. `Ctrl+Shift+S` 另存为，文件名默认 `.md`
6. 修改后 `Ctrl+O`，应弹“保存 / 不保存 / 取消”
7. 中文路径、含空格路径各做一次打开与另存为
8. 修改后点关闭，应弹同样的三选项确认；选“保存”后窗口关闭且文件已写入

## 5. 诊断

启动时带环境变量：

```bat
set MOTE_LOG=%TEMP%\mote.log
set MOTE_KEYLOG=1
```

日志中应依次出现：

```
page loaded
NATIVE ready gen=1
NATIVE open <path>
NATIVE save <path>
```

另外可检查：

- 文档目录下生成了 `.mote-preview-<pid>.html`
- 标题是否按 `name* - Mote` 显示
- 关闭后临时页面是否被删除

## 6. 已知待实机确认

| 项 | 说明 |
|---|---|
| `TaskDialogIndirect` | 三个中文自定义按钮是否正常显示；若没有视觉样式会退回系统确认框（是/否/取消） |
| `app.rc` 图标 | `app.ico` 与生成的 `app.rc` 同在构建目录，确认 exe 图标与“属性 → 详细信息”版本号 |
| 消息来源 fragment | `get_Source()` 是否保留 `#gN`；已做“无 fragment 放行”兜底，需确认不会串页 |
| 大文档注入 | 目前整篇走单条 `ExecuteScript`；超过约 1MB 可能失败，先记录现象，N3 补分片 |
| 中文输入法 | 输入法候选框位置、组合输入是否正常 |

## 7. 回报格式

请提供：

1. 第一个编译错误的完整原文（若构建失败）
2. `%TEMP%\mote.log` 关键片段
3. 复现步骤与文档路径类型（中文 / 空格 / 网络盘）
4. 屏幕缩放比例与 WebView2 Runtime 版本
5. 失败项对应的截图

## 8. 参考

- 设计与里程碑：[`thin-shell-stage-b.md`](thin-shell-stage-b.md)
- N1 代码：[`platform/win/main_window.cpp`](../platform/win/main_window.cpp)、[`web_host_view.cpp`](../platform/win/web_host_view.cpp)、[`dialogs.cpp`](../platform/win/dialogs.cpp)
- macOS 对照实现：[`platform/mac/main_window.mm`](../platform/mac/main_window.mm)
