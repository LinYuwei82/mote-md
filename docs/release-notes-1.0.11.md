## Mote 1.0.11

### 本次更新

- **表格列宽修复**：编辑器内表格列宽改为按内容比例分配，与 Typora 一致。此前表格强制等宽分列，短标签列被撑到半宽、长内容列被挤成多行，与 Markdown 原文的视觉权重严重不符。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `7`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.11-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.11-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.11-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.11-win64-setup.exe SHA256
```

### 升级说明

应用内「检查更新」会自动检测并升级；也可以从下载页手动安装覆盖。构建号 `7`，macOS 与 Windows 同号。
