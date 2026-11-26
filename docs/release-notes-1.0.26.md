## Mote 1.0.26

### 本次更新

- **自动更新机制重构（内部）**：检测 / 编排 / 平台安装彻底分层，macOS 与 Windows 共用同一份更新状态机，消除两端行为差异；修复 Windows 侧「更新清单先判定后验签」的顺序问题，现在两端都在判定前先完成 Ed25519 验签。
- 更新检查节奏、提示文案、强制更新与灰度行为均保持一致，用户无感。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `23`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.26-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.26-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.26-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
