## Mote 1.0.31

### 修复

- **Windows「关于 Mote」对话框排版**：「官网与下载」超链接此前贴左边缘显示且被截断，现已居中，与 macOS 版式一致。

### 其他

- 本版本仅此一处修复，无功能变更；1.0.30 的多窗口、最近打开、关于对话框等行为不变。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.31-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.31-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.31-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
