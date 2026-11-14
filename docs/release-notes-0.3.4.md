# Mote v0.3.4 — 界面改版、目录性能与包体瘦身

Mote 是一个用 **C++20 + Qt 6** 写的 Markdown 编辑/查看工具，编辑体验参照 Typora：原生外壳 + 系统 WebView，编辑时即时渲染，没有左右分栏，进出编辑块光标不位移。

0.3.4 是一次以「观感 + 体积」为主的版本：去掉重复的文字工具栏，重做目录、标题层级与状态栏；目录改为延迟构建、滚动高亮改二分查表；macOS 改用不带 ICU 的官方 Qt 构建，DMG 从 34.4MB 降到 24.0MB。功能与文件格式没有变化。

> Windows 与 macOS 使用同一版本号 v0.3.4。两边共用同一份前端，界面与目录性能改动在 Windows 重新打包后同样生效；Windows 产物与校验值待打包后填入。

## 0.3.4 变更

- **去掉重复工具栏**：窗口只保留原生菜单栏、正文与状态栏三段。`打开 / 保存 / 另存为 / 目录 / 源码模式` 在菜单里都有同一批动作，工具栏只是重复入口，删除后功能不减。
- **状态栏变薄**：去掉系统灰底与右下角尺寸手柄，改为 11px 文字 + 上方 1px 发丝线，跟随深浅色，不再在底部压出一块灰。
- **排版收紧**：目录当前项由整块底色改为「左侧 2px 强调条 + 强调色文字」；标题层级调整为 h1 1.95em、h2 1.42em、h3 1.16em，标题上方留白加大、首块标题不再把正文顶低；正文行宽 52rem → 50rem；代码块由 4px 直角改为 8px 圆角 + 1px 描边。
- **目录性能**：目录列表改为延迟构建，点击目录按钮的阻塞从 41ms 降到 3ms（900 个标题的样本）；滚动高亮改为缓存标题纵坐标 + 二分查表，不再每次滚动对 900 个标题逐个调 `getBoundingClientRect`。
- **减少无效重建**：正文增删但标题集合未变时，跳过目录 `innerHTML` 重建，只重算当前项高亮。
- **macOS 包体瘦身**：改用官方 Qt 6.11.1（不链接 ICU），去掉 `libicudata` 等约 37MB 依赖；打包脚本同时裁掉包内无人引用的 `QtNetwork`、`libssl`、`libcrypto`（Homebrew Qt 路线同样受益）。macOS DMG 34.4MB → 24.0MB，zip 31.0MB → 21.1MB，解压后 `.app` 75MB → 49MB。

## 系统要求

- macOS 14 及以上（Apple Silicon，arm64）：构建目标为 `-mmacosx-version-min=14.0`，更早的系统未经测试
- Windows 10 1809 及以上 / Windows 11，64 位
- 需要 WebView2 Runtime（Win11 和多数 Win10 自带；缺失时程序会提示并给出下载入口）
- macOS 安装包约 24.0MB（23,968,176 字节），解压后约 49MB；Windows 体积待打包后填入

## 下载与安装

macOS：

1. `Mote-macOS-0.3.4.dmg`：打开后把 `Mote` 拖进「应用程序」
2. `Mote-macOS.zip`：解压得到 `Mote.app`，可放在任意目录

Windows（待 Windows 侧打包）：

1. `Mote-Setup-0.3.4.exe`：按用户安装到 `%LOCALAPPDATA%\Programs\Mote`，不需要管理员权限；可选择关联 `.md`，卸载时还原原有默认程序
2. `Mote-Windows.zip`：解压后直接双击 `Mote.exe`，不写注册表

## 首次启动被拦截

macOS 未做公证：首次打开请右键 `Mote.app` →「打开」。
Windows 未做代码签名：SmartScreen 会提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」即可，只需一次。

## 已实现功能

- 打开 `.md`、新建、编辑、保存（`Cmd/Ctrl+S`）
- 标题、段落、列表、任务列表、引用、代码块、表格、分隔线、链接、图片的渲染与就地编辑
- 代码块语法高亮、行号、复制按钮、可搜索语言选择器（含自定义语言与 Plain Text）
- 目录侧边栏、字体缩放、加粗/斜体快捷键、撤销/重做
- 导出 PDF（macOS 与 Windows 均为 A4、无页眉页脚、代码块与表格底色保留、中文可搜索）
- 文档同目录的相对路径图片正常显示
- 系统级拖放：拖入 `.md` 直接打开；拖入图片复制到 `assets/` 并插入引用

## 已知限制

- **Windows 未逐项复核本版界面**：工具栏移除、状态栏、排版与目录优化在 macOS 实测，Windows 使用同一份前端，但尚未在真机逐项确认
- **换目录后页面会重新加载**：另存为或新建到另一个目录后，滚动位置回到顶部、撤销历史与编辑态会重置。这是为了让新目录下的相对图片能正常显示，不是 bug
- 仅提供 x64（Windows）与 arm64（macOS）
- 未做代码签名与公证：Windows 首次运行需通过 SmartScreen，macOS 需右键打开
- 编辑菜单「粘贴」的插入位置与原生光标位置一致，可能落在块首；快捷键与右键菜单粘贴落在块末/右键处
- 行内代码复制到 Word 后字体为 `Menlo`（macOS）/ `Consolas`（Windows），与页面内使用的 JetBrains Mono 不同，这是为兼容外部应用而写的回退字体栈
- 语言选择器的输入法候选窗未在真机手敲验证，仅用合成组字事件验证了 Enter/Esc 与过滤行为
- 导出后内存不回落到导出前：800 段文档实测约 +44MB 的打印缓冲，导出结束进程仍持有该内存
- **macOS 侧四项复核未完成**：未保存对话框按钮文案、块间 gap 粘贴、源码态粘贴、Word 行内代码字体，本轮未逐项复核，不视为已验证
- 大文档打开仍是一次性整篇重建（344KB / 4545 块约 150ms），本版只优化了目录与滚动，未做分批挂载

## 校验

```
SHA256  e74621269ff7871c8f3a37e29a95c349e7bbb8a01162bd7f9c2b59d0fdac62d7
大小    23,968,176 字节
文件    Mote-macOS-0.3.4.dmg

SHA256  ac32a5297e5799d0529fb4b639f46b7b6e6ddb0ee0197889d847ab518982ab5a
大小    21,116,597 字节
文件    Mote-macOS.zip
```

Windows（待打包后填入）：

```
SHA256  待 Windows 侧打包后填入
大小    待 Windows 侧打包后填入
文件    Mote-Setup-0.3.4.exe

SHA256  待 Windows 侧打包后填入
大小    待 Windows 侧打包后填入
文件    Mote-Windows.zip
```

## 许可证

本版以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 `LICENSE`；随包附带的 `licenses/LICENSE-AGPL-3.0.txt` 为同一份全文。

## 问题反馈

请提到仓库 Issues：`https://gitee.com/lin-yuwei168/mote-md/issues`
