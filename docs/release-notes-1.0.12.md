## Mote 1.0.12

### 本次更新

- **表格列宽按内容分配（根本修复）**：彻底解决「表格里不管什么内容列都等宽」的问题。此前 WKWebView 引擎在 `table-layout: auto` 下会把表格剩余空间按列均分，内容短的表格必然趋向等宽，与 Typora（Chromium 按内容加权）行为不一致。现在渲染时直接测量每列内容的最大宽度，按比例注入列宽，任何引擎下列宽都由内容决定，对所有表格统一生效。
- **表格单元格垂直居中**：单元格文字改为垂直居中对齐，与 Typora 一致。此前文字固定在行首，当同行存在多行内容（如窄列逐字换行）时，单行文字下方出现大片空白，浪费大量纵向空间。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `8`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.12-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.12-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.12-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.12-win64-setup.exe SHA256
```

### 升级说明

应用内「检查更新」会自动检测并升级；也可以从下载页手动安装覆盖。构建号 `8`，macOS 与 Windows 同号。
