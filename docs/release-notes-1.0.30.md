## Mote 1.0.30

### 重要修复

- **macOS 关窗崩溃**：1.0.29 中，多窗口打开时关闭任意一个非最后窗口会导致应用崩溃、所有窗口一起消失。已修复（窗口生命周期双重释放），现在可以随意逐个关闭。

### 新功能：「关于 Mote」对话框

- 双平台统一的原生关于面板：应用图标、版本号与构建号、版权信息。
- 内置「官网与下载」链接与「检查更新…」按钮，不用绕菜单。
- 入口：macOS `Mote → 关于 Mote`；Windows `文件 → 关于 Mote…`。

### 工程加固

- Windows 发布产物的构建号校验字符串改用链接器强制保留，修复新版 MSVC 死代码消除导致 CI 产物校验降级的问题（不影响功能，提升发布防线）。
- 内置示例与用户手册补充多窗口 / 最近打开说明。

### 构建与分发

- macOS 与 Windows 同版本同步发布，构建号 `27`。
- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**。
- 1.0.29 的多窗口并行编辑、最近打开列表等功能行为不变。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.30-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.30-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.30-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
