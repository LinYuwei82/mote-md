# Windows 验收指南：代码块复制按钮 + 导出 PDF

本文给 Windows 机器照着跑，覆盖两笔改动：

1. 代码块复制按钮：从框外右侧留白移回**代码块内部右上角**，语言徽标在顶部头栏左侧。
2. 导出 PDF：长文档不再被截断（macOS 侧改为按安全切点分段抓取再拼 A4 多页）。

## 0. 先分清：哪些结论来自 macOS，哪些必须 Windows 独立确认

macOS（分支 `mac/copybtn-pdf`，本指南提交前的最新一笔）已经实测通过的内容：

- 按钮位置：块内右上角，`top`/`right` 内缩约 0.35/0.45rem；单行、多行、30 行块均在边框内，按钮与语言徽标不重叠。
- 超长语言名：徽标截断在 7rem（约 115px），按钮不被挤出。
- 横向滚动：按钮 rect 不随 `scrollLeft` 变化。
- 交互：默认半透明、hover 显形、点击出现对勾并 1.2s 恢复；`mousedown` 不抢焦点、不进入编辑态、不改撤销栈。
- 复制内容：单行块逐字节等于 `const x = 1;`；30 行块 629 字节逐字节一致。
- 导出 PDF（macOS 实现）：401 段 12 页、800 段 23 页，段落无缺失/重复，接缝无半截行；A4、无页眉页脚；`.code-tools` 在导出时 `display:none`，纸面无按钮/徽标。

**以上都不能直接代表 Windows。** Windows 的差异：

- 导出 PDF 走 WebView2 `PrintToPdfAsync`，分页由 WebView2 自己做，不是 macOS 的 `createPDFWithConfiguration` + 分段抓取；`pdfBegin()` 返回的分段数据在 Windows 端不参与分页。
- 页面尺寸/边距/页眉页脚由 Windows 端打印设置决定（`src/webview_win.cpp`：A4、左右 0.71in、上下 0.79in、打印背景、无页眉页脚），需要实测确认。
- CSS/JS 是共享的（`resources/resources.qrc` 编进 exe），所以按钮布局与导出态隐藏逻辑理论一致，但必须重新构建确认 qrc 真的更新。
- 两端字体、图片解码、PDF 文本嵌入路径不同，中文与图片要单独确认。

## 1. 准备

### 1.1 拉分支

```bat
git fetch origin --prune
git checkout mac/copybtn-pdf
git pull --ff-only
git log --oneline -5
git status --short
```

判据：`git status` 为空；`git log` 能看到本指南对应提交及其前面的三笔（复制按钮、长文档导出、导出 PDF 初版）。记录 `git rev-parse HEAD`。

### 1.2 构建（必须干净构建，确认 qrc 重编）

测试建议用干净影子构建，不要直接复用旧 `build\`：

```bat
tools\preflight.bat
```

脚本会清空 `%TEMP%\mote-preflight` 后重新 qmake + nmake/mingw32-make。若需要可分发产物，再按 `packaging\package_windows.bat` 构建（需 `QTDIR` 与 `WEBVIEW2_SDK`，产物在 `dist\`；本仓库当前不提交 dist）。

qrc 确认（做到其中两条即可，第 3 条最可靠）：

1. 构建目录里 `qrc_resources.cpp` 的修改时间晚于本次 `git checkout` 时间；
2. `build.log` 中没有资源相关 error；
3. 启动 exe 后代码块顶部能看到头栏（旧版本是框外右侧浮层），这是最可靠的 qrc 生效证据。

判据：`Mote.exe` 能启动、能打开 md；代码块头栏存在。失败留证：`build.log`、`qrc_resources.cpp` 时间戳、启动截图。

### 1.3 测试夹具

在任意可写目录建一个 `fixtures\`，准备：

- `ui.md`：单行、多行、超长语言名、超长一行、30 行代码块各一个；
- `img.md`：图片夹在两段文字之间，用来验证 PDF 图片与分页；
- 长文档：`long-62.md`、`long-200.md`、`long-401.md`、`long-800.md`。

PowerShell 生成长文档（在 fixtures 目录执行；401 段文档在第 401 块放一个代码块，其余为单行段落）：

```powershell
param([int]$n = 401)
$parts = for ($i = 1; $i -le $n; $i++) {
  if ($i -eq 401) { "```js`nlet alpha = 1;`nlet beta = 2;`n```" }
  else { "第$i 段：导出长文档回归用的段落，保持足够篇幅让渲染与分页更接近真实长篇。" }
}
$text = ($parts -join "`r`n`r`n") + "`r`n"
[IO.File]::WriteAllText((Join-Path (Get-Location) "long-$n.md"), $text, (New-Object Text.UTF8Encoding($false)))
```

```powershell
.\make-long.ps1 -n 62
.\make-long.ps1 -n 200
.\make-long.ps1 -n 401
.\make-long.ps1 -n 800
```

判据：`Select-String -Path long-401.md -Pattern '^第401 段'` 无命中、`let alpha` 有命中；800 段文档段落数 799 + 1 个代码块。

PDF 核对工具（任选）：

- Acrobat / Edge：看页数、纸张大小、文字能否选中搜索；
- 可选 `pdftotext`（Poppler）或 Python `pymupdf`，用于自动核对段落覆盖与接缝。

## 2. 代码块复制按钮

每项都记录：操作、判据、失败证据（截图/录屏/剪贴板十六进制）。

| # | 操作 | 判据 | 失败留证 |
|---|---|---|---|
| 2.1 单行块 | 打开 `ui.md`，看单行代码块 | 顶部有一条很窄的头栏；语言徽标在左，复制图标在块内右上角；按钮四边都不越过代码块边框；不压代码文字 | 截图（含边框四角） |
| 2.2 多行块 | 看 5 行代码块 | 同上；按钮仍在头栏右端，不随块高跑到中间或下方 | 截图 |
| 2.3 30 行块 | 看 30 行代码块 | 按钮固定在块内右上角，不随内容滚动/块高变化 | 截图 |
| 2.4 超长语言名 | 用 ```` ```typescript_with_a_really_long_language_name ```` | 徽标截断成省略号（约 7rem），按钮仍在右上角、不被挤出、不重叠 | 截图 + 徽标宽度 |
| 2.5 横向滚动 | 拖超长行的横向滚动条到中段 | 按钮位置不动（仍在块内右上角）；按钮不盖住可见文字；滚动条不被按钮压住 | 滚动前后两张截图 |
| 2.6 渲染态 | 单击其它块让代码块退出编辑态 | 徽标与按钮都可见（半透明），按钮可点 | 截图 |
| 2.7 编辑态 | 双击代码正文进入编辑 | 头栏与按钮位置不变；徽标完全显形；按钮仍可点 | 截图 |
| 2.8 hover | 鼠标移到复制图标上 | 按钮从半透明变为显形（出现边框/底色） | hover 截图 |
| 2.9 点击反馈 | 点击按钮 | 图标变对勾，约 1.2s 后恢复；页面不滚动、不弹窗 | 点击后 0.2s 内截图 |
| 2.10 复制一致性（单行） | 点击单行块按钮，PowerShell 执行 `Get-Clipboard -Raw` | 内容逐字节等于 `const x = 1;`，无行号、无语言名、无尾随空行 | `Get-Clipboard -Raw \| Format-Hex` 输出 |
| 2.11 复制一致性（多行） | 点击 30 行块按钮，粘贴到新文件 | 行数 30、每行内容与源码一致、无行号/语言名；与源块逐行比较无差异 | 粘贴文件 + `fc /b` 或哈希 |
| 2.12 不抢焦点 | 先把光标放在正文某段，点按钮 | 原光标位置不变、不进入代码编辑态、不出现选区 | 截图 + 光标位置说明 |
| 2.13 不改撤销栈 | 记录当前可撤销步数（连续 Ctrl+Z 试一次再 Ctrl+Y 恢复），点按钮后再 Ctrl+Z | 按钮点击不产生新的撤销步骤；撤销回到点击前那一步 | 录屏或步骤记录 |
| 2.14 长语言名 + 窄窗口 | 把窗口缩窄到约 700px 再测 2.4 | 按钮仍完整在块内；徽标先截断，按钮不被挤出 | 截图 |

复制一致性建议做法（避免换行符争议）：把按钮复制出的内容保存为 `clip.txt`，把代码块正文单独保存为 `expected.txt`（用同一编辑器、同一换行），再用 PowerShell：

```powershell
$h1 = (Get-FileHash clip.txt -Algorithm SHA256).Hash
$h2 = (Get-FileHash expected.txt -Algorithm SHA256).Hash
"$h1`n$h2"
```

判据：哈希一致；若仅换行符不同，记录实际差异并标为“换行符差异”，不能有字符/行数差异。

## 3. 导出 PDF

前置：Windows 上用 `Ctrl+P` 或「文件 → 导出 PDF…」；导出前先保存文档（无路径的新文档会先弹保存对话框）。

| # | 操作 | 判据 | 失败留证 |
|---|---|---|---|
| 3.1 A4 尺寸 | 导出 `ui.md`，Acrobat → 文件 → 属性 | 页面 8.27×11.69 in（595×842 pt），纵向 | 属性截图 |
| 3.2 边距 | 量正文到页边 | 左右约 0.71in（18mm），上下约 0.79in（20mm）；各页一致 | 页面截图 + 标尺 |
| 3.3 页眉页脚 | 看每页顶部/底部 | 无页眉、无页脚、无页码、无 URL/日期 | 首末页截图 |
| 3.4 代码外观 | 看代码块 | 语法高亮颜色保留；代码底色保留（不是白底）；等宽字体正常 | 页面截图 |
| 3.5 头栏清理 | 看代码块顶部 | **没有**语言徽标、没有复制按钮、没有头栏分隔线及其底色残留 | 放大截图 |
| 3.6 图片 | 导出 `img.md` | 图片完整、不跨页截断、不重复；相对路径按 md 所在目录解析 | 图片所在页截图 |
| 3.7 中文 | Ctrl+F 搜索正文中的中文句子 | 中文可搜索、可选中；无方框/乱码；字体不是位图 | 搜索截图 + 复制一段文字 |
| 3.8 长文档 401 段 | 导出 `long-401.md` | 页数合理（约 12–16 页）；首段与第 400 段都在；中间无整段缺失/重复；代码块三行完整；页首页尾无半截行 | PDF + 覆盖核对结果 |
| 3.9 长文档 800 段 | 导出 `long-800.md` | 页数合理（约 22–30 页）；第 799、800 段都在末页；无空白尾页；无整段缺失/重复 | PDF + 覆盖核对结果 |
| 3.10 未保存文档 | 新建文档、输入内容、直接导出 | 先弹保存对话框；取消则**不导出、不生成文件**；保存后继续导出，内容完整 | 录屏 + 目录列表 |
| 3.11 只读目录 | 导出到无写权限目录（如非管理员导出到 `C:\Program Files\MoteTest`） | 弹出标题为「导出失败」的对话框，正文为「无法写入 <路径>」；不崩溃；不留下 0 字节文件；界面恢复 | 错误对话框截图 + 目录列表 |
| 3.12 同名覆盖 | 对同一路径连续导出两次 | 第二次弹覆盖确认；确认后文件更新（时间/内容变化），不生成 `xxx (1).pdf` | 两次文件属性截图 |
| 3.13 导出后复原 | 导出前记录滚动位置、侧栏/行号栏/徽标/按钮状态 | 导出结束：外壳全部回来；滚动位置回到导出前；`body` 不再有导出态样式（页面无异常留白） | 导出前后截图 |
| 3.14 脏标记/撤销栈 | 使文档有未保存改动，先保存；记录标题无修改圆点；导出后再看 | 标题仍无修改圆点；Ctrl+Z 仍能撤销导出前的上一步；导出不新增撤销步骤 | 截图 + 步骤记录 |
| 3.15 源码模式禁用 | 按 Ctrl+E 进入源码模式，观察菜单并尝试 Ctrl+P | 菜单「导出 PDF…」灰显；Ctrl+P 不导出、不生成文件（动作已禁用，通常无任何反应；若仍触发，状态栏应提示「源码模式下不能导出 PDF，先退出源码模式」） | 截图 + 导出目录列表 |
| 3.16 长文档导出耗时/内存 | 任务管理器观察 401/800 段导出 | 不出现长时间无响应（>10s）或内存持续飙升；导出后内存回落 | 任务管理器截图/录屏 |

长文档自动核对（可选，需 `pip install pymupdf`）：

```python
import re, sys, pymupdf
pdf = sys.argv[1]
total = int(sys.argv[2])                       # 段号上限
exclude = {int(x) for x in sys.argv[3:]}       # 被代码块替换的段号
expected = set(range(1, total + 1)) - exclude
d = pymupdf.open(pdf)
seen = []
for p in d:
    seen += [int(x) for x in re.findall(r"第(\d+)\s*段", p.get_text())]
print("pages", d.page_count, "found", len(seen), "unique", len(set(seen)))
print("missing", sorted(expected - set(seen))[:20])
print("extra", sorted(set(seen) - expected)[:20])
print("dups", len(seen) - len(set(seen)))
```

调用：`python check.py long-401.pdf 401 401`、`python check.py long-800.pdf 800 401`。

判据：`missing` 与 `extra` 都为空、`dups` 为 0、`pages` 在合理范围。两份额外文档都是 400/799 个编号段落 + 1 个代码块（生成脚本把第 401 段替换成代码块）。

## 4. 失败时统一留什么证据

每次失败至少留下：

1. 复现步骤（第几项、文档路径、窗口大小、是否滚动）；
2. 截图或 10–20s 录屏（按钮位置问题要包含代码块四角与鼠标位置）；
3. 产物：导出的 PDF、剪贴板文本（`Get-Clipboard -Raw > clip.txt` 与 `Format-Hex`）；
4. 环境：`winver`、WebView2 Runtime 版本（Edge → 设置 → 关于 或注册表 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`）、Qt 版本、`git rev-parse HEAD`；
5. 日志：构建日志 `%TEMP%\mote-preflight\build.log`；若用 `MOTE_KEYLOG=1` 启动，附 stderr 输出（会打印 `QT pdf path=…` / `QT action exportPdf`）。

## 5. 结论模板

```
Windows 验收结论
- 分支/提交：mac/copybtn-pdf @ <sha>
- 环境：Windows <版本> / WebView2 <版本> / Qt <版本> / 构建方式：<preflight 或 package_windows>
- 代码块复制按钮：PASS / FAIL（失败项：2.x、2.y）
  - 位置：块内右上角；单行/多行/30 行：<通过情况>
  - 超长语言名：<截断宽度、按钮是否被挤>
  - 横向滚动：<按钮是否固定>
  - 渲染态/编辑态：<通过情况>
  - hover/点击对勾：<通过情况>
  - 复制逐字节：单行 <哈希/结果>；30 行 <哈希/结果>
  - 不抢焦点/不进编辑/不改撤销栈：<结果>
- 导出 PDF：PASS / FAIL（失败项：3.x、3.y）
  - A4/边距/无页眉页脚：<实测值>
  - 高亮/底色/图片/中文：<结果>
  - 头栏与按钮清理：<结果>
  - 401 段：<页数、missing、dups>；800 段：<页数、missing、dups>
  - 未保存先保存 / 只读目录报错 / 同名覆盖：<结果>
  - 导出后复原、脏标记、撤销栈：<结果>
  - 源码模式禁用：<结果>
  - 耗时/内存：<观测值>
- 证据路径：<截图/PDF/日志目录>
- 仍需 Windows 侧注意：<字体差异、WebView2 版本、边距实测偏差等>
```

## 6. 已知平台差异（避免误判）

- macOS 的 PDF 截断修复在 `src/macwebview.mm`，Windows 不执行这段代码；Windows 分页完全由 `PrintToPdfAsync` 决定。若 Windows 长文档出现截断，属于 Windows 端独立问题，需要单独修，不要用 macOS 的实测页数当标准。
- macOS 实测边距是 51pt / 56.7pt；Windows 打印设置是 0.71in / 0.79in，二者换算后接近但不保证逐点一致，以 Windows 实测为准。
- `pdfEnd()` 现在两端都会恢复导出前滚动位置；若 Windows 上出现滚动跳变，记录导出前/后的 `scrollY` 与窗口大小。
- 复制按钮与头栏是共享 CSS/JS；如果 Windows 上仍看到框外浮层，优先怀疑 qrc 没有重编（旧 `qrc_resources.cpp` 被复用）。
