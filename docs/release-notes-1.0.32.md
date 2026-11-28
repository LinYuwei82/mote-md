## Mote 1.0.32

### 修复

- **「关于 Mote」版权行错别字**：「小图在线」更正为「小兔在线」（macOS 与 Windows 同步）。

### 其他

- 本版本仅此一处文案修正，无功能变更。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.32-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.32-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.32-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
