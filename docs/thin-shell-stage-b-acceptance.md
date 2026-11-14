# 阶段 B（Windows 原生外壳）验收记录

日期：2026-11-14
分支：`native-shell`
环境：Windows / MSVC 14.44 x64 / CMake + Ninja / WebView2 Runtime 157.0.4341.46

## 1. N6 口径

交接单（`docs/thin-shell-stage-b.md`）只定义到 N5。本阶段把 N6 定义为
**可交付验收与回归**：在同一构建上重跑全部功能矩阵、补齐验收记录，不改
默认产物。是否让原生产物取代 Qt 成为 Windows 正式发布包属于产品方向决定，
留给用户拍板（见第 4 节）。

## 2. 功能矩阵与实测值

| 项 | 结论 | 实测 |
|---|---|---|
| 构建 | 通过 | CMake + Ninja 全量 19/19；仅既有 `getenv` C4996 |
| core 单测 | 通过 | `mote_core_tests` 292 项断言 |
| 菜单 / 命令分发 | 通过 | 菜单树 4 菜单 / 7+17+9 项；`WM_COMMAND` 与 `MOTE_COMMAND` 均触发 `NATIVE command` |
| 快捷键 | 通过 | 命令表 token 与加速键集合比对无缺失；`Ctrl+/` 切换源码模式（`source=1`） |
| 拖放注册 | 通过 | 注册在 `Chrome_RenderWidgetHostHWND`；真实 OLE 拖拽进 `Drop`（`NATIVE drop paths=1`） |
| 拖 .md（脏） | 通过 | 弹「未保存的修改」三按钮；选不保存后打开新文件，原文件未变 |
| 拖图片 | 通过 | 40×30 PNG 落到同级 `assets/`，源文件保留，插入 `![](assets/dropme.png)` |
| 剪贴板 alpha | 通过 | 32bpp 透明渐变 120×80 → PNG `minAlpha=15`；8bpp 调色板 100×60 正常 |
| 剪贴板格式 | 通过 | 仅 `PNG` 注册格式 33×17 可粘贴；`CF_HDROP` 不落图也不当文本 |
| 大文档分块 | 通过 | 600 KB→200,002 cjk/659 ms；1.5 MB→500,002/797 ms；2.1 MB→700,002/522 ms |
| 导出 HTML | 通过 | 含图文档 391 KB，`img src` 全为 data URI；缺图计数并提示；本地路径只留在 `data-raw` 原文 |
| 导出 PDF | 通过 | 23.7 KB md → PDF 23.3 KB / 6 页；非法目录失败弹「导出失败」，两次均还原 `pdf-export` 类 |
| 打包 | 通过 | exe 632,832 + loader 165,968 字节，zip 607,489 字节；依赖仅系统 DLL，无 Qt |
| 版本信息 | 通过 | 文件/产品版本 0.3.4，自动取自 `Mote.pro` |
| 快照基线 | 通过 | `MOTE_EVAL` 44 blocks、`cjk=909 words=345`；PNG 1180×800 / 105,464 字节 |

## 3. 本阶段修复的缺陷

1. `OleInitialize` 只在未初始化时调用，导致 OLE 拖放注册 `E_OUTOFMEMORY`。
2. 32bpp `CF_DIB` 的 alpha 被 WIC 丢弃；同时 Ctrl+V 被 Chromium 转码，改为
   外壳优先处理图片剪贴板。
3. Chromium 占用渲染子窗口 IDropTarget，注册成功但真实拖拽收不到 Drop。
4. `Drop` 先清状态再设 effect，拖放源拿不到 Copy。
5. 导出 HTML 的产物清单缺 `web/` 与 `fonts/`，打包后页面无法启动。
6. `evaluate_script_result` 空回调直接返回，导致 `pdfEnd()` 不执行、页面停在导出态。

## 4. 未覆盖 / 待决定

1. **mac 截图对照**：需在 mac 上以 `PACKAGING.md` 6.2 的同名命令产出基线再比对；
   本机无法运行 mac 版。
2. **PDF 逐页像素比对**：PrintToPdf 分页由 Chromium 决定，与 mac 切点不同；
   只做了页数/体积/文字层验证，未做逐页截图差异统计。
3. **正式产物切换**：`package_windows_native.ps1` 与 Qt 脚本并存，默认仍是 Qt；
   切默认属产品方向变化，待用户确认。
