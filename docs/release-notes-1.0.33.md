## Mote 1.0.33

### 修复

- **插入分隔线时崩溃**：修正分块构建逻辑把分隔线（`---`）误判为标题的问题，插入分隔线不再触发异常。

### 改进

- 前端源码按功能域拆分为 42 个独立作用域分片，原生端（macOS / Windows）大文件按域拆分；界面与操作行为不变。
- 新增 109 条纯函数测试与 13 条事件级测试，并接入持续集成，为后续改动提供回归保障。

### 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `mote-1.0.33-macos-arm64.dmg` | 拖拽到「应用程序」即可 |
| Windows | `mote-1.0.33-win64-setup.exe` | 安装版 |
| Windows | `mote-1.0.33-win64-portable.zip` | 免安装绿色版 |

### 校验

随附 `SHA256SUMS.txt`，下载后可自行校验：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows（PowerShell）
Get-FileHash SHA256SUMS.txt -Algorithm SHA256
```
