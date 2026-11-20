# 阶段 A 验收记录：macOS 原生薄外壳

对应设计稿 [`thin-shell-stage-a.md`](thin-shell-stage-a.md)。范围仅 macOS；Windows 继续用 Qt 构建，未做改动。

## 结论

阶段 A 目标全部达成：

- macOS 包不再链接 Qt，`.app` 从 49 MB 降到 1.2 MB，DMG 从 23.97 MB 降到 579 KB
- 前端资源只有一份（`resources/web/`），Qt 与原生构建共用
- 页面协议、菜单命令、图片落盘、脏标记收敛到无 Qt 的 `core/`，有 CLI 单测兜底
- 既有 0.3.4 的编辑、打开/保存、拖放、目录/源码/缩放、PDF/HTML 导出行为均保留

## 提交

分支 `native-shell`（基于 `main` 的 `4d6fd9a`）：

| 提交 | 内容 |
|---|---|
| `7424e85` | 阶段 A 设计稿 |
| `9a1f934` | CMake + AppKit + WKWebView 骨架 |
| `5a2352b` | 平台源码移到 `shell/mac/` |
| `437086b` | `core/`：JSON 协议、消息分发、图片落盘、脏标记 + 单测 |
| `6df4afc` | 菜单命令表（33 个命令） |
| `d3fb3a0` | 外壳接入 controller：菜单、打开/保存、未保存确认、标题脏标记 |
| `3676182` | 原生拖放与 MOTE_* 诊断钩子 |
| `96ebb21` | PDF/HTML 导出、状态栏移进前端 |
| `de78870` | core 状态栏脚本片段 |
| `533baae` | 打包 `--native`、Qt 链接自检、preflight `--native` |

`main` 与发布历史未改动，`v0.3.4` 标签未重打。

## 体积

| 产物 | Qt 0.3.4 | 原生 |
|---|---|---|
| `.app` | 49 MB | 1.2 MB |
| zip | — | 540 KB |
| DMG | 23,968,176 B | 578,997 B |

产物名带 `-native` 后缀（`dist/Mote-macOS-native*`），与 Qt 版共存。

## 依赖自检

`tools/package/package_macos.sh --native --dmg` 的最终扫描：

```
Mach-O 文件数：1
otool -L：/opt/homebrew 0 行，/usr/local 0 行，/Users/ 0 行
otool -D：/opt/homebrew 0 行，/usr/local 0 行，/Users/ 0 行
Qt 链接：0 行（原生构建应为 0）
结果：通过
```

## 行为验证

| 项 | 方式 | 结果 |
|---|---|---|
| core 单测 | `ctest --test-dir build-native` | 269 项断言通过 |
| 启动冒烟 | `tools/preflight.sh --native` | `{"textLen":3064,"blocks":34,"imgs":1,"moteApi":true}` |
| 打开文档 | 命令行参数 + 截图 | 标题、正文、状态栏正确 |
| 拖放 `.md` | `MOTE_DROP` | 走未保存确认后打开 |
| 拖放图片 | `MOTE_DROP` | 写入 `assets/`，页面插入并渲染 |
| 目录/源码/缩放 | `MOTE_EVAL` | 视图回报 `toc/source/zoom` 正确，菜单勾选同步 |
| PDF 导出 | `MOTE_COMMAND=exportPdf` | A4 单页渲染无裁切，导出后页面复原 |
| HTML 导出 | `MOTE_COMMAND=exportHtml` | 401 KB，1 张图片内联，无 `file:` 残留 |
| DMG 运行 | 挂载后直接启动 | 字体、示例、前端资源完整 |

截图对照：同一文档下原生版与 Qt 0.3.4 的正文排版、间距、图片、代码块一致；唯一差异是原生版底部多了页面内状态栏（预期改动）。

## 已知差异与遗留

- 状态栏在页面内绘制，Qt/Windows 构建不加 `platform-mac` 类，继续用 Qt 状态栏，两端不重复
- 剪贴板复制/剪切/粘贴走 AppKit 响应链，与 Qt 版 macwebview 的既有做法一致
- 命令表新增“全选”，Qt 菜单尚未消费该表，Windows 侧行为未变
- 源码模式下禁用导出 PDF；其余导出命令已可用
- `core/export_*` 未单独成文件：导出调度在 `EditorController` 与平台层，PDF/HTML 落盘在 `shell/mac/`

## 回退

原生外壳完全在 `native-shell` 分支与 `native/`、`shell/mac/`、`core/` 中，不影响 `main` 的 Qt 发布链路。删除分支即可回退。

## 后续（阶段 B）

- Windows 去 Qt 或让 Qt 外壳消费 `core/`（二选一，需单独设计）
- 版本号统一来自 `Mote.pro` 的 `VERSION`，发布时同步 `app.rc`/安装器

## 常用命令

```bash
# 开发构建
cmake -S native -B build-native && cmake --build build-native
ctest --test-dir build-native

# 原生出包（zip + DMG）
bash tools/package/package_macos.sh --native --dmg

# 本机自检
bash tools/preflight.sh --native
```
