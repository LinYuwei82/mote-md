## Mote 1.0.9

### 本次更新

本版本没有业务功能变更，集中于发布链路与产物校验的可靠性修复，避免后续版本出现清单回退、发布标题乱码或缺附件等问题。

- **更新清单不再回退旧平台段**：发布前先拉取线上 `manifest.json` 再合并，避免本地残留的旧平台版本/构建号被写回线上，导致另一端被判定为版本回退。
- **Gitee Release 标题乱码修复**：发布标题与说明改为通过 UTF-8 文件传递，并补全 Gitee PATCH 缺失的 `tag_name` 字段；GitHub 与 Gitee 标题保持一致。
- **发布 Release 自动化**：Windows 发布流程会在打包上传后自动创建/更新 GitHub 与 Gitee Release；单平台发版时缺失的附件自动从 OSS 回源，已存在的不重复上传。
- **依赖自检误报修复**：包内 Mach-O 外部路径扫描剔除 `otool` 输出的文件路径表头，不再把开发机绝对路径误判为残留依赖。
- **构建号校验按平台生效**：同版本双端发布共用 tag 序号时，Windows 构建只与线上 Windows 段的构建号比较，不再被先发平台抬高后的全局最大值误拦。
- **macOS 自动更新签名修复**：appcast 改用与包内 `SUPublicEDKey` 匹配的 Sparkle 专用私钥签名，修复在旧版本上检查更新时提示「此更新未正确签名，无法验证其真实性」的问题；发布脚本新增签名验签门禁，用错密钥会直接拒绝发布。
- **构建号统一**：macOS 与 Windows 的 `build` 均等于 tag 序号（本次为 5），两端同号。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `5`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.9-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.9-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.9-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.9-win64-setup.exe SHA256
```

### 升级说明

- 应用内「检查更新」会自动获取本次版本；也可直接下载安装包覆盖安装。
- 本版本仅修复发布链路，日常使用与 1.0.8 无差异。

### 系统要求

- macOS 14.0 及以上（Apple Silicon）
- Windows 10 及以上（64 位）

---

<sub>使用中遇到问题请在 Issues 中反馈，并附上版本号与系统信息。</sub>
