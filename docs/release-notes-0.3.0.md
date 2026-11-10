# Mote v0.3.0 — Windows 版

Mote 是一个用 **C++20 + Qt 6** 写的 Markdown 编辑/查看工具，编辑体验参照 Typora：原生外壳 + 系统 WebView，编辑时即时渲染，没有左右分栏，进出编辑块光标不位移。

0.3.0 补上了 Windows 的系统级拖放：从资源管理器拖入 `.md` 直接打开，拖入图片落盘到文档同目录的 `assets/` 并插入引用，不支持的类型显示禁止光标。宿主仍基于 **WebView2**，与 macOS 共用同一套编辑协议和前端页面。

> Windows 与 macOS 使用同一版本号 v0.3.0。

## 系统要求

- macOS 14 及以上（Apple Silicon，arm64）：构建目标为 `-mmacosx-version-min=14.0`，更早的系统未经测试
- Windows 10 1809 及以上 / Windows 11，64 位
- 需要 WebView2 Runtime（Win11 和多数 Win10 自带；缺失时程序会提示并给出下载入口）
- 安装后约 38 MB，绿色版解压后约 35 MB

## 下载与安装

二选一：

1. `Mote-Setup-0.3.0.exe`：按用户安装到 `%LOCALAPPDATA%\Programs\Mote`，不需要管理员权限；安装时可选择关联 `.md`，卸载时会还原你原来的默认程序
2. `Mote-Windows.zip`：解压后直接双击 `Mote.exe`，不写注册表

## 首次启动被拦截

本版未做代码签名，SmartScreen 会提示「Windows 已保护你的电脑」。点「更多信息」→「仍要运行」即可，只需一次。

## 已实现功能（Windows 已实测）

- 打开 `.md`、新建、编辑、`Ctrl+S` 保存
- 标题、段落、列表、任务列表、引用、代码块、表格、分隔线、链接、图片的渲染与就地编辑
- 代码块语法高亮、行号、目录侧边栏、字体缩放、加粗/斜体快捷键、撤销
- 文档同目录的相对路径图片正常显示
- 系统级拖放：拖入 `.md` 直接打开；拖入图片复制到文档同目录的 `assets/` 并插入引用；不支持的类型显示禁止光标、不插入内容
- 安装版支持 `.md` 关联，卸载可还原原有默认程序

其余 macOS 已有能力随共享前端一并可用，但未在 Windows 上逐项实测。

## 已知限制

- 仅提供 x64；安装向导界面为英文
- **换目录后页面会重新加载**：另存为或新建到另一个目录后，页面会重新加载，滚动位置回到顶部、撤销历史与当前编辑态会重置。这是为了让新目录下的相对图片能正常显示（系统 WebView 的资源访问范围在加载页面时就固定了，只改页内 `<base>` 不够），不是 bug
- 系统级拖放已接入并实测：`.md` 直接打开、图片落盘到 `assets/` 并插入引用、不支持的类型显示禁止光标；多文件与跨目录等边界情况未逐项实测
- 150% 高 DPI 仅按 `QT_SCALE_FACTOR=1.5` 模拟验证，未在真实 150% 缩放的显示器上逐项复核
- 锚点链接、脚注、数学公式、导出 PDF 尚未支持
- 仅处理本地文件，不含云端同步
- 未做代码签名与公证：Windows 首次运行需按上文通过 SmartScreen，macOS 需手动放行

## 校验

```
SHA256  5417CC3C211BFAB8D61DB0BBA881E9DDF6CAA69A8D14D99C8F799F542BF0984B
大小    12,513,235 字节
文件    Mote-Setup-0.3.0.exe

SHA256  33494739317221905A34F5B55F58B29A25359C05C3EE9FD729F14309A8E5D6A9
大小    14,974,703 字节
文件    Mote-Windows.zip

SHA256  C0C17B203757AF8E45228F8A6EC0E709262FDD5A12F47BDBEF130C70C6043072
大小    34,287,855 字节
文件    Mote-macOS-0.3.0.dmg

SHA256  2F958E5CB15846E30F795BF3CC91D3F7F9E478E2887E621DD98AA885E1220A09
大小    30,934,818 字节
文件    Mote-macOS.zip
```

Windows 上校验：

```powershell
Get-FileHash .\Mote-Setup-0.3.0.exe -Algorithm SHA256
Get-FileHash .\Mote-Windows.zip -Algorithm SHA256
```

## 许可证

本版以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 `LICENSE`；随包附带的 `licenses/LICENSE-AGPL-3.0.txt` 为同一份全文。更早的版本为 GPL-3.0，已发布版本的授权不受影响。

## 问题反馈

请提到仓库 Issues：`https://gitee.com/lin-yuwei168/mote-md/issues`
