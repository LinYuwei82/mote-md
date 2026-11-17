# Mote v0.3.10 — 新应用图标

Mote 是一个 C++20 写的 Markdown 编辑/查看工具，编辑体验参照 Typora：原生外壳 + 系统 WebView，编辑时即时渲染，没有左右分栏，进出编辑块光标不位移。

0.3.10 只做一件事：把重绘后的应用图标同步到全部产物——Windows 的 exe、安装包与卸载入口，以及 macOS 的 App 与 DMG。macOS 0.3.10 同时补上 0.3.9 的隔离路径提示（macOS 未单独发布 0.3.9）。

> **macOS 与 Windows 均已发布 0.3.10。** macOS 用户会从 0.3.8 直接升级到 0.3.10。

## 0.3.10 变更

- **macOS 同步**：App、DMG 与下载页统一使用新图标；隔离路径提示（0.3.9 遗留）随本版生效。
- **新图标**：浅青底 + 深青 `md` 字标，透明圆角（四角 alpha 为 0，不是白底方图），`.ico` 含 16–256 七档尺寸。
- **exe 内嵌图标**：`resources/win/app.ico` 经 `configure_file` 复制到构建目录后由 `rc.exe` 重新编译，资源段确实换成了新图；已用像素抽样核对（旧图中心为纯白，新图中心为 `#012B33`，两版四角均透明）。
- **安装包与卸载入口**：`SetupIconFile=..\resources\icons\app.ico`，`UninstallDisplayIcon` 指向安装后的 `Mote.exe`，向导与「应用和功能」列表中的图标与主程序一致。
- **版本号升至 0.3.10**：0.3.9 的二进制已发布，图标重建属于字节级变更，用新版本号区分，避免线上文件与清单哈希对不上。

## 系统要求

- Windows 10 / 11，x64
- 需要 WebView2 Evergreen Runtime（Windows 11 自带；Windows 10 若缺失，安装程序会提示）
- 运行库静态链接（`/MT`），目标机不需要安装 VC++ 可再发行包
- 安装版约 2.5MB，绿色包约 0.7MB

## 下载与安装

1. `Mote-Setup-0.3.10.exe`：免管理员，按用户安装到 `%LOCALAPPDATA%\Programs\Mote`，含卸载程序与 `.md` 关联选项
2. `Mote-0.3.10-win64-portable.zip`：解压到任意目录，双击 `Mote.exe` 即用

## 从旧版本升级

0.3.9 及更早的安装版可在应用内完成升级：确认后自动下载安装包、校验 SHA256、静默安装并重启。升级完成后若资源管理器仍显示旧图标，执行一次 `ie4uinit.exe -show` 刷新图标缓存即可（本次发布时已在本机执行）。

## 图标核验

| 检查项 | 结果 |
|---|---|
| `Mote.exe` 内嵌图标 | 中心 `1,43,51`，四角 alpha 0（旧版中心为 `255,255,255`） |
| `Mote-Setup-0.3.10.exe` 图标 | 中心 `1,43,51`，四角 alpha 0 |
| 安装目录 / 卸载入口 | 均指向 `Mote.exe`，同一资源 |
| 任务栏、开始菜单、Alt+Tab、200% 缩放目视复核 | **未逐项目视验证**，仅核对资源与像素；如需签字验收请在本机再走一遍 |

## 校验

```
SHA256  1f6f8c546f4ff4fa68be74b4aee22f226e9c55d716f79d4576dd41b511bd05a5
大小    669,542 字节
文件    Mote-0.3.10-win64-portable.zip

SHA256  58a3fbad4fcee13d796cd9f781403f8d2a55c964355c622b2e6fbc62d25da3db
大小    2,645,107 字节
文件    Mote-Setup-0.3.10.exe
```

## 已知限制

- Windows 安装包未做代码签名，首次运行可能出现 SmartScreen 提示，选「更多信息 → 仍要运行」即可
- 图标缓存由系统管理：替换 exe 后任务栏/开始菜单可能短暂显示旧图，`ie4uinit.exe -show` 可强制刷新
- 绿色版无法自我替换，更新后仍需手动解压覆盖
- macOS 0.3.11 已发布，mac 用户可从 0.3.8 直接升级到 0.3.11

## 许可证

本版以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 `LICENSE`。

## 问题反馈

请提到仓库 Issues：`https://gitee.com/lin-yuwei168/mote-md/issues`
