## Mote v0.3.0

Mote 是一个用 **C++20 + Qt 6** 写的 Markdown 编辑/查看工具，编辑体验参照 Typora：原生外壳 + 系统 WebView，编辑时即时渲染，没有左右分栏，进出编辑块光标不位移。

**相对 0.2.0 的主要变化：Windows 端从占位实现换成了完整的 WebView2 宿主**——正文真正由 WebView2 渲染与编辑，并补齐了系统级拖放、安装包与 `.md` 关联。macOS 端功能不变，两端共用同一版本号。

### 系统要求

- **Windows**：Windows 10 1809 及以上 / Windows 11，64 位；需要 WebView2 Runtime（Win11 和多数 Win10 自带，缺失时程序会提示并给出下载入口）
- **macOS**：macOS 14 及以上，仅 Apple Silicon（arm64）；构建目标为 `-mmacosx-version-min=14.0`，更早的系统未经测试
- 安装后 Windows 版约 38 MB，绿色版解压后约 35 MB

### 下载附件

| 平台 | 文件 | 大小（字节） | SHA256 |
|---|---|---|---|
| Windows | `Mote-Setup-0.3.0.exe` | 12,513,235 | `5417CC3C211BFAB8D61DB0BBA881E9DDF6CAA69A8D14D99C8F799F542BF0984B` |
| Windows | `Mote-Windows.zip` | 14,974,703 | `33494739317221905A34F5B55F58B29A25359C05C3EE9FD729F14309A8E5D6A9` |
| macOS | `Mote-macOS-0.3.0.dmg` | 34,287,855 | `C0C17B203757AF8E45228F8A6EC0E709262FDD5A12F47BDBEF130C70C6043072` |
| macOS | `Mote-macOS.zip` | 30,934,818 | `2F958E5CB15846E30F795BF3CC91D3F7F9E478E2887E621DD98AA885E1220A09` |

校验命令示例：

```powershell
# Windows（PowerShell）
Get-FileHash .\Mote-Setup-0.3.0.exe -Algorithm SHA256
Get-FileHash .\Mote-Windows.zip -Algorithm SHA256
```

```sh
# macOS
shasum -a 256 Mote-macOS-0.3.0.dmg
shasum -a 256 Mote-macOS.zip
```

### 安装

**Windows**（二选一）：

1. `Mote-Setup-0.3.0.exe`：按用户安装到 `%LOCALAPPDATA%\Programs\Mote`，不需要管理员权限；安装时可选择关联 `.md`，卸载时会还原你原来的默认程序
2. `Mote-Windows.zip`：解压后直接双击 `Mote.exe`，不写注册表

**macOS**（二选一）：

1. `Mote-macOS-0.3.0.dmg`：打开后把 `Mote.app` 拖进「应用程序」
2. `Mote-macOS.zip`：解压后把 `Mote.app` 拖进「应用程序」

### 首次启动被拦截

本版未做代码签名与公证，两端首次运行都会被系统拦一次：

- **Windows**：SmartScreen 提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」，只需一次
- **macOS**：提示无法验证开发者。在 Finder 里按住 Control 点按 `Mote.app` 选「打开」，或到「系统设置 → 隐私与安全性」点「仍要打开」

### 功能

**已在 Windows 实测：**

- 打开 `.md`、新建、编辑、`Ctrl+S` 保存
- 标题、段落、列表、任务列表、引用、代码块、表格、分隔线、链接、图片的渲染与就地编辑
- 代码块语法高亮、行号、目录侧边栏、字体缩放、加粗/斜体快捷键、撤销
- 文档同目录的相对路径图片正常显示
- 系统级拖放：拖入 `.md` 直接打开；拖入图片复制到文档同目录的 `assets/` 并插入引用；不支持的类型显示禁止光标、不插入内容
- 安装版支持 `.md` 关联，卸载可还原原有默认程序

**在 macOS 可用、本版未逐项复测：**

- 上述编辑与渲染能力随共享前端一同提供；本版只改动了 Windows 宿主，macOS 侧沿用 0.2.0 的实现，未逐项重新验证
- 两端均未实测的能力：多文件同时拖入、跨目录拖入、超长文档性能

### 已知限制

- 未做代码签名与公证：Windows 首次运行需通过 SmartScreen，macOS 需手动放行
- Windows 仅提供 x64；macOS 仅提供 arm64（Apple Silicon），不支持 Intel Mac
- Windows 安装向导界面为英文
- 150% 高 DPI 仅按 `QT_SCALE_FACTOR=1.5` 模拟验证，未在真实 150% 缩放的显示器上逐项复核
- **换目录后页面会重新加载**：另存为或新建到另一个目录后，页面会重新加载，滚动位置回到顶部、撤销历史与当前编辑态会重置。这是为了让新目录下的相对图片能正常显示（系统 WebView 的资源访问范围在加载页面时就固定了，只改页内 `<base>` 不够），不是 bug
- 锚点链接、脚注、数学公式、导出 PDF 尚未支持
- 仅处理本地文件，不含云端同步

### 许可证

本版以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 `LICENSE`，Windows 包内另附 `licenses/LICENSE-AGPL-3.0.txt` 同一份全文。0.2.0 及更早版本为 GPL-3.0，已发布版本的授权不受影响。

### 问题反馈

请提到仓库 Issues：https://gitee.com/lin-yuwei168/mote-md/issues
