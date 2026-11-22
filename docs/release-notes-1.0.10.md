## Mote 1.0.10

### 本次更新

本版本集中修复 PDF 导出与 Typora 的版式差异，并降低导出体积；同时完善跨块选区与 Windows 安装包的 WebView2 处理。

- **PDF 版式对齐 Typora**：正文行高、表格行高（26.25pt）、单元格留白、表格铺满正文宽、代码块行距与编号、目录项间距（21.6pt）均按 Typora 样张校准。
- **分页规则对齐**：整张表格或代码块不超过一页时保持完整，不跨页劈开；表格仍按行分页；换页后首行贴正文区顶部。
- **mermaid 按图导出**：mermaid 代码块在导出时渲染为矢量图，不再输出源码文本。
- **导出体积大幅下降**：改为逐页抓取内容 + 超集字体按族共享，59 页技术方案从 4.22MB 降到 1.40MB，文本层与分页保持不变。
- **跨块选区增强**：支持鼠标拖选、Shift+方向键跨块扩展；复制/剪切同时写入纯文本与标准 HTML，保留标题、列表、代码块、表格结构。
- **Windows 安装包**：WebView2 Runtime 改为可选安装任务，仅在系统未安装时显示并默认勾选。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `6`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.10-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.10-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.10-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.10-win64-setup.exe SHA256
```

### 升级说明

应用内「检查更新」会自动检测并升级；也可以从下载页手动安装覆盖。构建号 `6`，macOS 与 Windows 同号。
