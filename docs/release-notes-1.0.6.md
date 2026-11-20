## Mote 1.0.6

### 本次修复

- **应用内更新报「此更新未正确签名，无法验证其真实性」**：发布清单 `appcast.xml` 中的 Sparkle 签名串混入了工具调试文本，导致 Ed25519 验签失败。已在发布链路修正，并增加签名长度校验，避免同类问题再次发生。
- **Windows 发布流水线**：打包所需的 `innounp` 下载地址失效（404），已更换为可用源。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `202611191435`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.6-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.6-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.6-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.6-win64-setup.exe SHA256
```

### 升级说明

- 1.0.5 及更早版本：请在应用内「检查更新」，或直接下载本次安装包覆盖安装。
- 若此前遇到「未正确签名」提示，本次发布已修复，可正常升级。

### 系统要求

- macOS 14.0 及以上（Apple Silicon）
- Windows 10 及以上（64 位）

---

<sub>使用中遇到问题请在 Issues 中反馈，并附上版本号与系统信息。</sub>
