# Mote v0.3.9 — Windows 应用内更新（下载、校验与静默安装）

Mote 是一个 C++20 写的 Markdown 编辑/查看工具，编辑体验参照 Typora：原生外壳 + 系统 WebView，编辑时即时渲染，没有左右分栏，进出编辑块光标不位移。

0.3.9 的主线是把 Windows 的更新流程从「打开浏览器下载」改成应用内完成：下载更新包 → 校验 SHA256 → 安装版静默安装并自动重启。同时重绘了应用图标，并修掉 macOS 在 Gatekeeper 转译（App Translocation）状态下无法自动更新的问题。

> **本版目前只发布了 Windows。** macOS 0.3.9 需要在 Mac 上出包（公证 + Sparkle 签名），macOS 用户当前仍是 0.3.8；下面的图标与转译状态提示会在 macOS 0.3.9 出包时一并生效。

## 0.3.9 变更

- **Windows 应用内下载**：确认更新后在应用内下载（WinHTTP 流式写盘），下载弹窗实时显示已下载体积，可随时取消；不再跳转浏览器。
- **SHA256 校验**：下载完成后用系统 CNG 计算文件哈希，与清单里的值比对；不一致即删除文件并提示，清单缺少 SHA256 时直接拒绝下载，不做「先装了再说」。
- **安装版静默升级**：exe 同级存在 `unins000.exe` 时判为安装版，取清单的 `setup_url`，以 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RELAUNCH=1` 静默安装，安装结束后自动启动新版本。
- **绿色版保持手动覆盖**：绿色版取 `url` 的 zip，下载并校验通过后打开所在文件夹，由用户解压覆盖——运行中的 exe 无法自我替换，这里不做半截的自更新。
- **不拿未保存内容冒险**：安装前若文档有未保存修改，先提示保存并中止本次更新。
- **旧版本仍需手动一次**：0.3.8 及更早的更新器是「打开浏览器下载」的旧实现，因此 **0.3.9 是最后一个需要手动下载安装的版本**，从 0.3.9 起后续版本可在应用内完成。
- **应用图标重绘**：替换全部尺寸（16–1024 PNG、`.ico`、`.icns`），安装包、窗口图标与任务栏统一使用新图标；图标设计稿一并入库。
- **macOS 转译态提示**：应用带 quarantine 标记首次运行时，Gatekeeper 会把它放进 `AppTranslocation` 只读路径；此时更新前先提示用户把 Mote 拖到「应用程序」并重新打开，不再走到 Sparkle 安装阶段才失败。（随 macOS 0.3.9 出包生效）

## 系统要求

- Windows 10 / 11，x64
- 需要 WebView2 Evergreen Runtime（Windows 11 自带；Windows 10 若缺失，安装程序会提示）
- 运行库已静态链接（`/MT`），目标机**不需要**安装 VC++ 可再发行包
- 安装版约 2.4MB，绿色包约 0.6MB

## 下载与安装

1. `Mote-Setup-0.3.9.exe`：免管理员，按用户安装到 `%LOCALAPPDATA%\Programs\Mote`，含卸载程序与 `.md` 关联选项
2. `Mote-0.3.9-win64-portable.zip`：解压到任意目录，双击 `Mote.exe` 即用

## 从旧版本升级

0.3.8 及更早请手动下载本版安装包或绿色包覆盖一次；之后的新版本会在应用内提示并完成下载与校验，安装版无需再手动操作。

## Windows 端到端实测

以下用例均在 Windows x64 实机、WebView2 Runtime 157.0.4341.46 上跑，更新包为**线上 OSS 实物**（`dl.xiaotu.online`），通过本地清单把版本号指向 9.9.9 触发更新。

| 用例 | 实测结果 |
|---|---|
| 绿色版 + 正确 SHA256 | `target=…Mote-0.3.9-win64-portable.zip installed=0` → `download ok bytes=637679`，`%TEMP%\Mote-update` 下文件与线上长度一致 |
| 绿色版 + 错误 SHA256 | `download failed: 更新包校验失败（SHA256 不一致），已删除下载内容。`，临时目录零残留 |
| 安装版 + 线上安装包 | `target=…Mote-Setup-0.3.9.exe installed=1` → `download ok bytes=2566713` → `installer launched, quitting` → 静默安装完成后新进程启动（`ready gen=1`，路径 `%LOCALAPPDATA%\Programs\Mote\Mote.exe`） |
| 0.3.8 旧版发现更新 | `current=0.3.8 latest=0.3.9 decision=2`，`target=…Mote-Setup-0.3.9.exe installed=1` |
| 0.3.9 自检 | `current=0.3.9 latest=0.3.9 decision=1`，不误报 |

验证结束后已卸载安装版并清理临时目录（安装目录与 `%TEMP%\Mote-update` 均不存在）。

## 已知限制

- Windows 安装包未做代码签名，首次运行可能出现 SmartScreen 提示，选「更多信息 → 仍要运行」即可
- 安装版静默升级会关闭并自动重启 Mote；升级期间未保存的修改会先被拦截，但请避免在升级瞬间编辑
- 绿色版无法自我替换，校验通过后仍需手动解压覆盖
- 清单里的 SHA256 是唯一校验依据，签名验证（代码签名 / 公证）尚未覆盖 Windows
- macOS 0.3.9 尚未发布，mac 用户当前停留在 0.3.8

## 校验

```
SHA256  fe967aefece879c361be71d7fadba2d636e96f26dae34e318323fcd85c25df42
大小    637,679 字节
文件    Mote-0.3.9-win64-portable.zip

SHA256  74f63cd1e5b2ccb64d67681260074c34a5fdc09f73b80cc4e0c7871041de2320
大小    2,566,713 字节
文件    Mote-Setup-0.3.9.exe
```

## 许可证

本版以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 `LICENSE`。

## 问题反馈

请提到仓库 Issues：`https://gitee.com/lin-yuwei168/mote-md/issues`
