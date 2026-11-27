## Mote 1.0.28

### 重要修复

- **修复 macOS 版启动约 10 秒后闪退**：1.0.27 的启动优化引入了更新定时器空指针缺陷，导致 macOS 版每次启动约 10 秒后崩溃（与打开哪个文件无关）。本版本已修复。

> **正在使用 1.0.27（macOS）请注意**：该版本在收到自动更新提示前就会闪退，无法自行升级。请到官网重新下载 1.0.28 安装即可，文档内容不受影响。

### 其他

- Windows 版不受此问题影响，1.0.27 用户仍可通过自动更新平滑升级到 1.0.28。
- 1.0.27 的启动与打开文件提速、跨目录免重载、macOS 双击打开、Windows 单实例转发等改进全部保留。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，构建号 `25`。
- Windows 安装包与绿色版同步更新。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.28-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.28-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.28-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
