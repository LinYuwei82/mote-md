# Windows 复测清单：`mac/clipboard-followups`

本清单用于在 Windows 机器上复测 `mac/clipboard-followups` 分支的两笔**共享层**改动。两笔都只改 `resources/web/editor.js`，Windows 与 macOS 共用同一份前端代码，因此 Windows 必须独立复测一遍。

| 提交 | 内容 |
|---|---|
| `a9f0aa9` | 复制保留行内代码的反引号（`cleanCopyFragment` 白名单加入 `mk-code`） |
| `35205c8` | 多行粘贴保留换行（`insertHTML` + `<br>`/`mk-nl`，空行拆块） |

这两笔不并入 0.3.1，计划随 0.3.2 发布。本清单只做复测与取证，不改代码。

---

## 1. 准备

### 1.1 取分支、确认提交

```bat
git fetch origin
git checkout mac/clipboard-followups
git log --oneline -3
```

期望：HEAD 为 `35205c8`，其上一条是 `a9f0aa9`。若有本地改动或分叉，先停下报告，不要强拉、不要 rebase。

### 1.2 用 MinGW 重新编译（不要用 MSVC）

```bat
set QTDIR=C:\Qt\6.11.1\mingw_64
set PATH=%QTDIR%\bin;C:\Qt\Tools\mingw1310_64\bin;%PATH%
set USE_MINGW=1
cd /d C:\dev\Mote
packaging\package_windows.bat
```

`USE_MINGW=1` 不能漏，否则脚本会去找 `nmake`。不要同时把 MSVC 与 MinGW 两套 Qt 的 `bin` 放进 PATH。

### 1.3 确认跑的是本分支的 `editor.js`

前端经 `resources/resources.qrc` 编进二进制（`Mote.pro` 第 37～40 行），**光重新运行旧 exe 不算复测**。确认方式：

```bat
dir build\qrc_resources.cpp
dir /T:W dist\Mote-Windows\Mote.exe
```

- `qrc_resources.cpp` 的修改时间应晚于 `git checkout` 的时间（脚本会先删 `build\`，正常必然重新生成）；
- 最硬的行为判据是第 2 节：若复制段落仍丢反引号，说明跑的是旧前端。

---

## 2. 反引号（`a9f0aa9`）

准备一段包含行内代码的正文，例如：

```markdown
运行 `npm test` 之后再提交，见 [链接](https://example.com)。
```

### 2.1 纯文本是否带反引号

1. 在 Mote 里选中整段（建议从段首选到句号，确保包含两端的反引号标记）；
2. `Ctrl+C`；
3. 取证：

```powershell
Get-Clipboard -Raw
Get-Clipboard -Format Text
```

期望：输出为 `运行 \`npm test\` 之后再提交，见 [链接](https://example.com)。`

判定：纯文本里**有**成对反引号，且链接仍是 `[文字](url)`。任何一端反引号缺失即判不通过。

补充取证：粘到记事本（纯文本）再另存 `.txt`，用编辑器确认字符原样，尾部无零宽字符（`Format-Hex` 搜 `E2 80 8B` 应为 0 处）。

### 2.2 粘回 Mote 后是否还原为行内代码

1. 光标放到块外空白区或另一个段落，`Ctrl+V`；
2. 点击别处让该块失焦；
3. 观察 `npm test` 是否回到等宽 + 浅底的行内代码样式，且**不显示**反引号。

判定：样式还原且反引号不可见 = 通过；显示成裸反引号文字、或只是普通文字 = 不通过。

### 2.3 富文本一路没有可见反引号

1. 重新复制同一段；
2. 粘到 Word（或写字板）与记事本各一次；
3. 期望：Word 里 `npm test` 是等宽代码样式、`链接` 是超链接，正文中没有任何反引号字符；记事本里是 2.1 的 Markdown 源码口径。

判定：Word 无可见反引号 = 通过（`text/html` 一路由 `sanitizeCopyHtml` 剥离标记，不应带出反引号）。记事本按 2.1 判。

---

## 3. 多行粘贴（`35205c8`）

三种情形分别准备剪贴板文本。取证统一用「`Ctrl+S` 后看文件原文」：

```bat
type doc.md
```

### 3.1 两行列表

剪贴板内容（PowerShell）：

```powershell
Set-Clipboard "- 甲项`n- 乙项"
```

1. 光标点到最后一块下方空白区，`Ctrl+V`；
2. 点击别处失焦，期望渲染为**两个圆点列表项**，不是一个段落里的两行文字；
3. `Ctrl+S`，`type doc.md` 期望两行独立：

```
- 甲项
- 乙项
```

### 3.2 两行普通文本

```powershell
Set-Clipboard "第一行`n第二行"
```

期望：失焦后是一个段落内的软换行（两行文字、段间距不增大）；落盘为：

```
第一行
第二行
```

即两行之间**只有一个**换行，没有空行。

### 3.3 空行分隔三段

```powershell
Set-Clipboard "甲段`n`n乙段`n`n丙段"
```

期望：渲染为三个独立段落；落盘为三段之间各有一个空行：

```
甲段

乙段

丙段
```

### 3.4 重开与撤销

- `Ctrl+W` 关闭后重新打开同一文件，三种情形的结构都应保持（列表两项、软换行、三个段落），字数与保存时一致；
- 对 3.3 重新粘贴一次后按一次 `Ctrl+Z`，期望整段（三段）一次性消失，回到粘贴前状态；若只回退了一部分，记为不通过并保留截图。

判定：3.1～3.3 的渲染与 `type` 输出都符合期望，且 3.4 的重开一致、一次撤销即可整段回退 = 通过。

---

## 4. Windows 专属粘贴路径

### 4.1 路径与 macOS 的差别（复测前必读）

Windows 的粘贴**不是** WebView2 原生粘贴，而是宿主自己读剪贴板后回灌页面，见 `src/webviewbase.cpp` 的 `WebViewBase::clipboardCommand`：

1. `copy` / `cut`：调用页面 `window.mote.clipboardCopy(false/true)`，由页面算出纯文本 + HTML 后经 `clipboardWrite` 写回系统剪贴板（第 203～210 行）；
2. `paste`：先取 `QGuiApplication::clipboard()->mimeData()`（第 214 行），**先判 `hasImage()`**（第 220 行），命中就走图片落盘并 `return`，不会再看文本；
3. 没有图片时才取 `data->text()`（第 233 行），空文本提示「剪贴板里没有可粘贴的文本」；否则调用页面 `window.mote.clipboardPaste(text)`（第 238 行），最终落到 `insertPastedText`，本次的换行处理就在这里。

据此有两个 Windows 特有风险点，必须单独验证。

### 4.2 桥接路径的换行不能丢

Windows 剪贴板文本常带 `\r\n`（`Get-Clipboard` 也会返回 CRLF）。页面侧 `insertMultilinePaste` 先做 `\r\n` → `\n` 归一，再做分行/拆块。

1. 用 `Set-Clipboard` 写入两行文本，再 `Get-Clipboard -Raw` 确认是 CRLF；
2. 粘进 Mote，按 3.2 的判据检查；
3. 播放第 3 节三种情形，确认桥接路径下换行没有被吞、也没有多出空行。

判定：CRLF 输入与 LF 输入结果一致 = 通过。若 CRLF 下压平或多出空行，说明归一化未生效，属 `editor.js`（共享层）问题。

### 4.3 文本粘贴不被图片分支抢走

`hasImage()` 在 `text()` 之前，需要确认普通文本复制没有同时携带位图而被误判。

1. 从 Mote 复制一段纯文字 → 粘贴，期望走文本路径；
2. 从 Word/浏览器复制一段**带图片的富文本** → 在 Mote 里粘贴，记录实际结果（预期走图片分支、只插图片；若与页面原生分支不一致，作为现象记录，不一定判不通过）；
3. 复制文件资源管理器里的文件（剪贴板为文件列表、无文本）→ 粘贴，期望提示「剪贴板里没有可粘贴的文本」，不崩溃。

判定：纯文本复制粘贴稳定走文本路径、不插出图片 = 通过；1 与 3 出现异常即不通过。

### 4.4 既有分支回归（代码未改，仅确认没被带坏）

- **图片粘贴**：截图后 `Ctrl+V`，期望落盘 `assets\paste-<日期>-<时间>.png`、正文插入 `![](assets/paste-...png)`、状态栏「已保存图片：assets/...」；
- **代码块内粘贴**：在代码块里粘贴一行代码，期望留在原代码块内、不拆块、语言徽标与高亮正常；
- **表格内粘贴**：在表格单元格里粘贴单行文本，期望留在单元格内、表格结构不变；
- 未保存文档粘图片：期望提示「图片未插入：当前文档还没有保存位置，请先保存 .md 文件」，且不写任何文件。

判定：四项均符合期望 = 通过。

---

## 5. 判据与失败取证

| 项 | 通过标准 | 失败时要留 |
|---|---|---|
| 2.1 纯文本反引号 | `Get-Clipboard` 有成对反引号，链接语法完整 | `Get-Clipboard -Raw` 原文、`Get-Clipboard -Format Text` 输出 |
| 2.2 粘回还原 | 失焦后是行内代码样式，无反引号可见 | 失焦前后截图各一张 |
| 2.3 富文本 | Word 无可见反引号、代码样式与链接正常 | Word 截图、`Get-Clipboard -Format Html` 片段 |
| 3.1～3.3 多行 | 渲染结构正确，`type doc.md` 与期望逐行一致 | `doc.md` 原文（`type` 输出或 `Format-Hex`）、粘贴前后截图 |
| 3.4 重开/撤销 | 重开一致；一次 `Ctrl+Z` 整段回退 | 重开截图、撤销后截图、操作步骤与次数 |
| 4.2 CRLF | 与 LF 结果一致 | `Get-Clipboard -Raw` 的十六进制（确认 `0D 0A`）、落盘原文 |
| 4.3 图片优先级 | 纯文本稳定走文本路径 | 剪贴板格式清单（`Get-Clipboard` 各格式）、现象描述 |
| 4.4 回归 | 图片/代码块/表格/未保存提示四项正常 | 对应截图与状态栏文字 |

通用要求：

- 每个失败项要写清**能否稳定复现**（重复 3 次的结果）、**首次出现的位置**（第几次粘贴、哪个块类型）；
- 涉及落盘的，附 `doc.md` 的原文（不要只截图，换行肉眼难辨）；
- 涉及剪贴板的，附 `Get-Clipboard -Raw` 原文；
- 截图命名建议 `win-<项号>-<现象>.png`，与文档一起放在复测目录。

---

## 6. 结论模板与修改归属

复测完成后按下面格式回报，可直接贴进 PR 或交接文档：

```markdown
### Windows 复测结论（mac/clipboard-followups @ 35205c8）

- 编译：MinGW（Qt 6.11.1 mingw_64），package_windows.bat 重新打包，qrc 已重编
- 反引号（a9f0aa9）：通过 / 不通过 —— 证据：<剪贴板原文、截图路径>
- 多行粘贴（35205c8）：通过 / 不通过 —— 证据：<doc.md 原文、截图路径>
- Windows 桥接路径（CRLF、图片优先级）：通过 / 不通过 —— 证据：<...>
- 回归（图片/代码块/表格/未保存提示）：通过 / 不通过 —— 证据：<...>
- 未覆盖或存疑：<...>
```

若 Windows 侧发现问题，改动归属按 `docs/COLLAB.md` 的分层规矩判断：

- **共享层 `resources/web/editor.js`**：反引号、换行解析、渲染、复制 HTML 等前端行为问题，改这里，提交信息须写「共享层」；
- **`src/webviewbase.cpp`**：宿主读剪贴板的顺序（`hasImage()` 与 `text()` 的先后）、`data->text()` 的取值与编码、状态栏提示等桥接层问题，改这里；该文件为共享基类，同样按共享层标注；
- **Windows 专属文件**（`src/webview_win.cpp`、`resources/win/app.rc`、`packaging\package_windows.bat`、`packaging\mote.iss`）：仅限 Windows 特有的快捷键映射、资源、打包流程问题。

改动仍按「一个问题一笔提交」执行，不把多个问题混进同一笔。
