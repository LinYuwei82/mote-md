## Mote 1.0.25

### 本次更新

- **启动与打开文件明显提速**：mermaid 图形库（3.3MB）以前每次启动、每次打开不同目录的文件都要随整页重新解析，是慢的主因；现在改为**按需加载**——只有文档里真正出现 ```mermaid 代码块时才加载，页面体积从约 4.2MB 降到 0.85MB，启动到可编辑实测快约 35%。
- **双击文件启动不再走弯路**：带文件启动时原来会先加载内置示例页、再切到文档目录重载一次；现在直接打开目标文件，只加载一次页面。
- mermaid 图的渲染、点图回源码、PDF 导出前等待出图等行为均不变；导出时会等待按需加载与渲染完成。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `22`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.25-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.25-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.25-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
