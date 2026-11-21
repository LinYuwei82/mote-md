## Mote 1.0.8

### 本次更新

- **Windows 运行时编码统一**：新增独立模块 `win_encoding`，把命令行参数、文件/目录路径、控制台输出、子进程输出重定向与错误文本统一收敛到 UTF-8 边界，修复中文路径/中文输出在 Windows 下可能出现的乱码。
- **错误文本处理更彻底**：CRT 错误文本、系统错误码文本统一转换，补充输出重定向与 GBK 文件端到端测试用例。
- **构建号统一**：macOS 与 Windows 的 `build` 均等于 tag 序号（本次为 4），两端同号，避免更新判定混乱。
- **发布门禁增强**：v2 更新清单校验单测接入 CI；pre-commit 的 Ed25519 公钥校验扩展为全仓扫描；修复发布脚本可能把本地旧平台段写回线上清单的问题。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `4`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.8-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.8-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.8-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.8-win64-setup.exe SHA256
```

### 升级说明

- 应用内「检查更新」会自动获取本次版本；也可直接下载安装包覆盖安装。
- 从 1.0.6 升级的 macOS 用户会跳过中间构建，直接更新到 1.0.8。

### 系统要求

- macOS 14.0 及以上（Apple Silicon）
- Windows 10 及以上（64 位）

---

<sub>使用中遇到问题请在 Issues 中反馈，并附上版本号与系统信息。</sub>
