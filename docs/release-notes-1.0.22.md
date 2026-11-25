## Mote 1.0.22

### 本次更新

- **Tab / Shift+Tab 缩进**：
  - 在列表/任务/引用行按 **Tab**：整行缩进一级（光标在行中间也一样），不再把空格插进正文；普通段落保持行内插入两个空格。
  - 新增 **Shift+Tab** 反缩进：去掉本行行首最多两个空格；本行没有缩进时保持不变（此前 Shift+Tab 与 Tab 同样只会插空格）。
- **全选删除修复**：`Cmd/Ctrl+A` 全选（或鼠标拖选出块）后按退格/删除，原来是一个死键——选区被收成折叠光标、什么都不发生；现在按整篇源码删掉选区，行为与常规编辑器一致。
- 边界验证新增 8 项全通过，此前各轮 72 项回归全通过（累计 80 项），无控制台报错。

### 构建与分发

- macOS 安装包使用 **Developer ID 签名 + Apple 公证 + stapler 票据**，离线状态下也能通过 Gatekeeper 校验。
- Windows 安装包与绿色版同步更新，构建号 `19`。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.22-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.22-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.22-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows
certutil -hashfile mote-1.0.22-win64-setup.exe SHA256
```

### 升级说明

应用内「检查更新」会自动检测并升级；也可以从下载页手动安装覆盖。构建号 `19`，macOS 与 Windows 同号。
