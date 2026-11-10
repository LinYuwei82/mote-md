# Mote v0.2.0 — Windows 版

Mote 是一个用 **C++20 + Qt6** 写的 Markdown 编辑/查看工具，编辑体验参照 Typora：原生外壳 + 系统 WebView，编辑时即时渲染，没有左右分栏，进出编辑块光标不位移。

0.2.0 首次提供 Windows 版，宿主基于 **WebView2**，与 macOS 共用同一套编辑协议和前端页面。

> Windows 版首次发布；macOS 版仍为 v0.1.0。

## 系统要求

- Windows 10 1809 及以上 / Windows 11，64 位
- 需要 WebView2 Runtime（Win11 和多数 Win10 自带；缺失时程序会提示并给出下载入口）
- 安装后约 38 MB，绿色版解压后约 35 MB

## 下载与安装

二选一：

1. `Mote-Setup-0.2.0.exe`：按用户安装到 `%LOCALAPPDATA%\Programs\Mote`，不需要管理员权限；安装时可选择关联 `.md`，卸载时会还原你原来的默认程序
2. `Mote-Windows.zip`：解压后直接双击 `Mote.exe`，不写注册表

## 首次启动被拦截

本版未做代码签名，SmartScreen 会提示「Windows 已保护你的电脑」。点「更多信息」→「仍要运行」即可，只需一次。

## 已实现功能（Windows 已实测）

- 打开 `.md`、新建、编辑、`Ctrl+S` 保存
- 标题、段落、列表、任务列表、引用、代码块、表格、分隔线、链接、图片的渲染与就地编辑
- 代码块语法高亮、行号、目录侧边栏、字体缩放、加粗/斜体/下划线快捷键、撤销
- 文档同目录的相对路径图片正常显示
- 安装版支持 `.md` 关联，卸载可还原原有默认程序

其余 macOS 已有能力随共享前端一并可用，但未在 Windows 上逐项实测。

## 已知限制

- 仅提供 x64；安装向导界面为英文
- Windows 系统级拖放尚未接入真实文件路径，拖入图片可能拿不到路径
- 锚点链接、脚注、数学公式、导出 PDF 尚未支持
- 仅处理本地文件，不含云端同步
- 未签名，首次运行需按上文放行

## 校验

```
SHA256  F973D11CA7C744978B4C3DEC77836052906A195A9E6F96BB5D8B1901697B8412
大小    12,487,102 字节
文件    Mote-Setup-0.2.0.exe

SHA256  4F720DC5A05C8EAF2003F3516D5A144FCFBDC1D0694966B29255E2062C938B02
大小    14,943,169 字节
文件    Mote-Windows.zip
```

Windows 上校验：

```powershell
Get-FileHash .\Mote-Setup-0.2.0.exe -Algorithm SHA256
Get-FileHash .\Mote-Windows.zip -Algorithm SHA256
```

## 问题反馈

请提到仓库 Issues：`https://gitee.com/lin-yuwei168/mote-md/issues`
