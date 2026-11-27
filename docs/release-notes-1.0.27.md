## Mote 1.0.27

### 本次更新

- **启动与打开文件大幅提速**：打开约 1 MB 的大文档从 ~6.3 秒降到 0.2 秒以内，冷启动到首屏约 0.25 秒；语法高亮改为分帧补画，长文档不再卡手。
- **换目录打开文件近乎秒开**：运行中打开其他目录的文件不再整页重载，直接注入新正文，窗口不闪、不重新解析脚本。
- **macOS 文件关联补齐**：双击 `.md` 文件可直接用 Mote 打开；应用运行中再双击会复用当前窗口打开新文件。
- **Windows 单实例转发**：应用运行中双击 `.md` 时把文件交给已有窗口并退出新进程，不再多开一个 Mote。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `24`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.27-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.27-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.27-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
