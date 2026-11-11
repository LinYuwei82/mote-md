# Mote v0.3.2 — Windows 版

Mote 是一个用 **C++20 + Qt 6** 写的 Markdown 编辑/查看工具，编辑体验参照 Typora：原生外壳 + 系统 WebView，编辑时即时渲染，没有左右分栏，进出编辑块光标不位移。

0.3.2 集中收尾剪贴板的边角：块外粘贴后的撤销不再残留空块，Windows 点最后一块下方空白区粘贴会补块而不是无反应，从资源管理器复制文件不再被当成文本粘进正文；复制到外部应用时行内代码保留反引号与等宽字体，多行粘贴保留换行。另外把 Qt 标准控件（含未保存提示）换成中文。功能范围与 0.3.1 相同，只含这些修复。

> Windows 与 macOS 使用同一版本号 v0.3.2。macOS 包已打出，校验值见文末「校验」。

## 0.3.2 变更

- **块外粘贴撤销**：光标在最后一块下方空白区粘贴后，一次 `Ctrl+Z` / `Cmd+Z` 就能回到粘贴前的状态，不再残留空块、文件尾部不多出空行；重做不会重复插入。
- **空白区粘贴回退（Windows）**：WebView2 下选区落在 `body`、取不到正文块时，退回文档末尾补一个段落块，点空白区粘贴不再没有反应。
- **文件列表剪贴板（Windows）**：剪贴板里只有文件路径（如资源管理器里复制）时，状态栏提示「剪贴板里没有可粘贴的文本」，正文零改动、撤销历史不变，不再把文件路径写进文档。
- **复制保留行内代码**：复制含行内代码的段落，纯文本仍带反引号，粘回 Mote 能还原成行内代码。
- **行内代码等宽字体**：复制的 HTML 给 `<code>` 内联 `Menlo, Consolas, monospace`。此前 Word 的 HTML 导入会把行内代码并进正文东亚字体（宋体），现在保持等宽，代码块（`<pre>`）行为不变。
- **多行粘贴保留换行**：粘贴多行文本按段落拆块，空行保留，不再被压成一行。
- **Qt 控件中文**：为 Qt 标准控件加载中文翻译，未保存提示的三个按钮显示为中文；打包补 `qtbase_zh_CN.qm`，避免换机器后回退英文。

## 系统要求

- macOS 14 及以上（Apple Silicon，arm64）：构建目标为 `-mmacosx-version-min=14.0`，更早的系统未经测试
- Windows 10 1809 及以上 / Windows 11，64 位
- 需要 WebView2 Runtime（Win11 和多数 Win10 自带；缺失时程序会提示并给出下载入口）
- 安装后约 34 MB，绿色版解压后约 34 MB

## 下载与安装

二选一：

1. `Mote-Setup-0.3.2.exe`：按用户安装到 `%LOCALAPPDATA%\Programs\Mote`，不需要管理员权限；安装时可选择关联 `.md`，卸载时会还原你原来的默认程序
2. `Mote-Windows.zip`：解压后直接双击 `Mote.exe`，不写注册表

## 首次启动被拦截

本版未做代码签名，SmartScreen 会提示「Windows 已保护你的电脑」。点「更多信息」→「仍要运行」即可，只需一次。

## 已实现功能（Windows 已实测）

- 打开 `.md`、新建、编辑、`Ctrl+S` 保存
- 标题、段落、列表、任务列表、引用、代码块、表格、分隔线、链接、图片的渲染与就地编辑
- 代码块语法高亮、行号、目录侧边栏、字体缩放、加粗/斜体快捷键、撤销
- 文档同目录的相对路径图片正常显示
- 系统级拖放：拖入 `.md` 直接打开；拖入图片复制到文档同目录的 `assets/` 并插入引用；不支持的类型显示禁止光标、不插入内容
- 剪贴板：复制/剪切带 HTML、空选区提示、块外粘贴兜底与干净撤销、三条入口各只写一次、文件列表剪贴板不写入正文
- 安装版支持 `.md` 关联，卸载可还原原有默认程序

其余 macOS 已有能力随共享前端一并可用，但未在 Windows 上逐项实测。

## 已知限制

- 仅提供 x64；安装向导界面为英文
- **换目录后页面会重新加载**：另存为或新建到另一个目录后，页面会重新加载，滚动位置回到顶部、撤销历史与当前编辑态会重置。这是为了让新目录下的相对图片能正常显示（系统 WebView 的资源访问范围在加载页面时就固定了，只改页内 `<base>` 不够），不是 bug
- 复制出的 HTML 里 `<pre>` 仍保留 `class="code-block"` 与空的 `code-scroll` 容器；非列表节点会带 `list-style-type: disc`。不影响富文本目标显示
- 编辑菜单「粘贴」的插入位置与原生光标位置一致，可能落在块首；快捷键与右键菜单粘贴落在块末/右键处
- 行内代码复制到 Word 后字体为 `Menlo`（macOS）/ `Consolas`（Windows），与页面内使用的 JetBrains Mono 不同，这是为兼容外部应用而写的回退字体栈
- 系统级拖放已接入并实测：`.md` 直接打开、图片落盘到 `assets/` 并插入引用、不支持的类型显示禁止光标；多文件与跨目录等边界情况未逐项实测
- 150% 高 DPI 仅按 `QT_SCALE_FACTOR=1.5` 模拟验证，未在真实 150% 缩放的显示器上逐项复核
- 锚点链接、脚注、数学公式、导出 PDF 尚未支持
- 仅处理本地文件，不含云端同步
- 未做代码签名与公证：Windows 首次运行需按上文通过 SmartScreen，macOS 需手动放行

## 校验

```
SHA256  bbc98c98f4dfee310a92ac1846f83d5811cedad364d4c917affcaaa2765b23d9
大小    12,560,254 字节
文件    Mote-Setup-0.3.2.exe

SHA256  a437177e128cb5966325cfc65a7932646fca50eb97438a164c1e22c1f9cfd2df
大小    15,032,652 字节
文件    Mote-Windows.zip

SHA256  6f7afa2f117b49508045eee5e20cd4ea5917dab24b95a1d604620c2d14e69a89
大小    34,325,855 字节
文件    Mote-macOS-0.3.2.dmg

SHA256  e290ddd8cb2be007289923fc4370750dc96a23ce09e6d398b6f8c27fd750b35c
大小    30,998,152 字节
文件    Mote-macOS.zip
```

Windows 上校验：

```powershell
Get-FileHash .\Mote-Setup-0.3.2.exe -Algorithm SHA256
Get-FileHash .\Mote-Windows.zip -Algorithm SHA256
```

包内 `Mote.exe` 的 FileVersion 与 ProductVersion 均为 `0.3.2`；该文件单独校验：

```
SHA256  c9f30259453d530e97f0134faee6edf9f53ab249a1b779ed8aaf281850f7bca2
大小    1,419,264 字节
文件    Mote.exe（包内）
```

## 许可证

本版以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 `LICENSE`；随包附带的 `licenses/LICENSE-AGPL-3.0.txt` 为同一份全文。更早的版本为 GPL-3.0，已发布版本的授权不受影响。

## 问题反馈

请提到仓库 Issues：`https://gitee.com/lin-yuwei168/mote-md/issues`
