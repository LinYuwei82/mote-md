# 阶段 B（Windows 原生外壳）验收记录

日期：2026-11-14
分支：`native-shell`
环境：Windows / MSVC 14.44 x64 / CMake + Ninja / WebView2 Runtime 157.0.4341.46

## 1. N6 口径

交接单（`docs/thin-shell-stage-b.md`）只定义到 N5。本阶段把 N6 定义为
**可交付验收与回归**：在同一构建上重跑全部功能矩阵、补齐验收记录；验收通过后
再按用户确认把 Windows 默认发布包切到原生产物（见第 4 节第 5 条）。

## 2. 功能矩阵与实测值

| 项 | 结论 | 实测 |
|---|---|---|
| 构建 | 通过 | 干净重建 CMake + Ninja 全量 21/21；警告 0、错误 0（`getenv` 的 C4996 已按 `_dupenv_s` 真正消除，未关告警） |
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
| 原子保存 | 通过 | 正常保存 / 另存为后覆盖均成功，无 `.tmp-*` 残留；目标被 `FileShare.Read` 占用时弹「保存失败」，原文件不变 |
| `MOTE_DROP` | 通过 | 拖 `.md` 直接打开目标、原文件不变；拖 56×34 PNG 落到同级 `assets/`，插入 `![](assets/probe.png)` |
| 中文输入 | 通过（提交路径） | SendInput Unicode 输入「输入法测试」→ 标题变脏、保存后 UTF-8 正确，`cjk` 10→15 |

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
3. **IME 组词过程**：本机未安装中文输入法（语言列表里只有 US 键盘），候选窗
   无法自动化；IME 最终提交走到的 Unicode 字符路径已实测通过。宿主未拦截
   `WM_IME_*`，组合键也只截 `Ctrl+V`，其余按键全部交给 WebView2。
4. **干净机验证**：无 VS/Qt 的机器解压即用、以及缺 WebView2 Runtime 时的提示，
   尚未在真实干净机跑过。
5. ~~**正式产物切换**~~（已完成，2026-11-14）：`package_windows_native.ps1` 的默认
   产物名改为 `Mote-Windows`，Windows 默认发布包即原生产物；Qt 脚本保留为回退，
   两边并存时给原生脚本传 `-OutName Mote-Windows-native`。

## 5. 诊断钩子说明

`MOTE_DROP` 与 mac 同名同义（页面就绪 900ms 后按一次真实拖放处理），唯一差异
是路径分隔符：mac 用 `:`，Windows 盘符自带冒号，改用 `;`。
