## Mote 1.0.21

### 本次更新

- **行首退格并入上一行**：在软换行（Shift+Enter 产生的换行）之后按退格，原来是一个"死键"——什么都不发生；现在会去掉该换行并把本行内容（自动剥离列表/引用等结构前缀）并入上一行，与 wolai / Notion 行为一致。
- **任务项回车保留复选框**：在 `- [ ]` 任务列表项内按回车拆分时，新行原来会丢掉 `[ ]` 复选框标记、退化成普通列表项；现在首项、项中、末项三种光标位置都会正确保留复选框。
- 边界验证新增 8 项全通过，此前各轮 64 项回归全通过（累计 72 项），无控制台报错。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `18`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.21-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.21-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.21-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.21-win64-setup.exe SHA256
```

### 升级说明

应用内「检查更新」会自动检测并升级；也可以从下载页手动安装覆盖。构建号 `18`，macOS 与 Windows 同号。
