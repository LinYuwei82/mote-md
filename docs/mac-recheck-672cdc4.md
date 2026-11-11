# mac/clipboard-followups 四项复核要求（针对 672cdc4）

## 一、背景

1. `mac/clipboard-followups` 已推进到 `672cdc4`（合并 `origin/win/paste-fallback` 后的 merge commit）：

   ```
   672cdc4 Merge remote-tracking branch 'origin/win/paste-fallback' into mac/clipboard-followups
   baa9b22 编辑（共享层）：文件列表剪贴板不再当文本粘贴
   23b6711 编辑（共享层）：块外空白区粘贴回退到补段落块
   8e2ae92 文档：新增与 Windows 合并 clipboardPaste 的对接说明
   a1ff0fc 编辑（共享层）：块外粘贴撤销不再残留空块
   7170de7 界面：为 Qt 标准控件加载中文翻译，打包补 qtbase_zh_CN.qm
   ee8bc08 文档：新增 followups 两笔的 Windows 复测清单
   35205c8 编辑（共享层）：多行粘贴保留换行
   a9f0aa9 编辑（共享层）：复制保留行内代码的反引号
   ```

2. Windows 侧已在 `672cdc4` 上按 `docs/win-recheck-followups.md` 与 `docs/win-merge-clipboard.md` 第 5 节跑完 28 项：27 项通过、0 项失败、1 项（未保存对话框按钮文案）通过但待确认。证据留在 Windows 机器 `%TEMP%\mote_672cdc4_evidence\`，未入库。
3. 上述 28 项里有四项依赖 macOS 独有的控件文案或原生响应链，Windows 结果不能替代 Mac 实测，单列如下。每项都附 Windows 侧的实测结论作对照，**仅作参照，不作为 Mac 已通过的证据**。

---

## 二、准备

```bash
git fetch origin
git checkout mac/clipboard-followups
git log -1 --format='%H %s'   # 期望 672cdc4 Merge remote-tracking branch 'origin/win/paste-fallback' into mac/clipboard-followups
```

构建（任选其一）：

- `packaging/package_macos.sh`（仓库内的正式打包流程）；
- 或你自己的 Mac 构建流程（`qmake` + `make` / Qt Creator），只要能产出可运行的 Mote.app。

要求：**构建通过**，记录命令、完整输出尾部与产物路径（例如 `dist/Mote.app`）。构建失败即整轮失败，先修构建再谈功能。

建议全程以 `MOTE_KEYLOG=1` 启动，按键与页面桥接日志会打到 stderr，便于失败时取证。

---

## 三、四项复核

### 第一项：未保存修改对话框的按钮文案

**操作**

1. 打开任意 `.md`，在新文档里输入一个字符，使标题栏出现 `*`（有未保存修改）。
2. 关闭窗口（`Cmd+W` 或点窗口关闭按钮），触发「未保存的修改」对话框。
3. 记下正文文案与三个按钮的文案、排列顺序、默认按钮（本项只判文案，不判保存/丢弃/取消的实际行为）。
4. 用 `Esc` 或「取消」退出，避免丢改动。

**期望**

- 正文形如「“<文件名>”有尚未保存的修改，是否保存？」，文件名带引号。
- 三个按钮与 `src/webwindow.cpp` 里的枚举一一对应：`QMessageBox::Save` / `QMessageBox::Discard` / `QMessageBox::Cancel`。
- 文案来自 Qt 自带翻译（中文），不出现英文、半中半英或空按钮。

**判据**

| 结论 | 勾选 |
| --- | --- |
| 通过 | [ ] |
| 不通过 | [ ] |
| 不适用 | [ ] |

> **Windows 实测对照（不代表 macOS）**：头文件为 `src/webwindow.cpp` 的 `closeEvent`，枚举为 `QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel`，默认为 `Save`。Windows 实机用 UIA 读到的正文是「“r-dialog2.md”有尚未保存的修改，是否保存？」，三个按钮是**「保存 / 丢弃 / 取消」**（截图 `r-dialog2-unsaved.png`）。「丢弃」是 Qt 对 `QMessageBox::Discard` 的中文标准译法，与 `docs/win-recheck-followups.md` 里写的「保存／不保存／取消」不一致，属**文案预期差异，不是功能缺陷**。macOS 待确认：实际显示哪三个词、是否与 Windows 一致；若不一致，是由 Qt 翻译版本差异还是系统按钮角色（`QMessageBox` 在 macOS 上使用系统的按钮顺序与角色）导致。**尚未在 macOS 上确认，不预设结论。**

---

### 第二项：块间空白（W4 gap）点击与粘贴回落

**操作**

1. 新建一篇两段文档（`第一段。`、空行、`第二段。`）并打开。
2. 定位两块之间的竖直 gap，在其内取三个点点击：上块下沿 +2 px、gap 中点、下块上沿 -2 px。
3. 每次点击后用 `window.getSelection()` 读 `startContainer`，判断选区是否落在 `#editor` 内（即 `caretParagraphBlock()` 能否取到块）。
4. 在 gap 中点点击后粘贴一段纯文本，观察落点；再撤销一次。

**期望**

- 若光标能落进 gap 并命中某个块，按 `caretParagraphBlock()` 的既有规则在该块处插入。
- 若取不到块，按规范降级到文末新建段落块；一次撤销即回到原状，不残留空块。
- 两个分支都不算失败；只有「落点错乱、重复插入、撤销不干净、留下空块」才判不通过。

**判据**

| 结论 | 勾选 |
| --- | --- |
| 通过 | [ ] |
| 不通过 | [ ] |
| 不适用 | [ ] |

> **Windows 实测对照（不代表 macOS）**：gap 实测 14 px；三点点击均为 `inRoot=false`、`anchor=#text`，锚点父节点为 `#editor` 之外的 `DIV`——即 WebView2 把光标落在编辑器根之外的页面空白，`caretParagraphBlock()` 取不到块，走的是**降级分支**：粘贴后块数 3，新段落在文末；一次撤销后块数回到 2、文本恢复「第一段。|第二段。」，无残留空块（截图 `w4b-fallback.png`）。**Windows 未走到 gap 命中取块的分支**，因此 macOS 若能把光标落进块内并在原位插入，属更优行为，需如实记录命中情况，不要因为与 Windows 不同就判失败。

---

### 第三项：源码模式粘贴

**操作**

1. 打开已有内容的文档，`Cmd+E` 切到源码模式，确认源码 `textarea` 可见。
2. **用真实鼠标**点进源码 `textarea` 使其获得焦点（不要只用快捷键或脚本注入焦点，否则测不到原生响应链）。
3. 剪贴板放两行文本，`Cmd+V`。
4. 再 `Cmd+Z` 一次。
5. 对照：切回渲染态，用真实鼠标点进正文，`Cmd+V` 同一段文本。

**期望**

- 源码态粘贴走 WebKit 原生 `paste:` 响应链，文本**只插入一次**，落在光标处。
- 一次 `Cmd+Z` 回到粘贴前文本。
- 渲染态粘贴同样只插入一次，不出现「原生粘贴 + 页面桥粘贴」双插入。
- 源码态不出现页面自建的剪贴板提示（`clipboardPaste` 在 `mode === 'source'` 时直接返回 false）。

**判据**

| 结论 | 勾选 |
| --- | --- |
| 通过 | [ ] |
| 不通过 | [ ] |
| 不适用 | [ ] |

> **Windows 实测对照（不代表 macOS）**：先真实鼠标聚焦再 `Ctrl+V` 时，源码文本由 `开始。\n` 变为 `真实甲\n真实乙开始。\n`（`paste=1`、`keydown=1`，一次插入），一次 `Ctrl+Z` 回到 `开始。\n`；对照渲染态真实粘贴只出现一次（`开渲染真实粘贴始。`），无双重插入。注意：**仅用合成按键、不先真实聚焦**时，Windows 上源码态 `Ctrl+V` 会被 Qt 吞掉（`MOTE_KEYLOG` 里只有 `QT keypress key=0x56`，无 shortcut 命中、无 WebView2 加速键转发），原因是 `applyViewState` 在 `Q_OS_WIN` 下禁用了剪切/复制/粘贴三个 QAction；那是测试手法的假象，不是缺陷。macOS 不做该禁用，需确认源码态走的是原生 `paste:` 而不是 Qt QAction。

---

### 第四项：Word 粘贴时行内代码字体回退

**操作**

1. 复制一段含行内代码的正文，例如「运行 `npm test` 之后再提交，见 [链接](https://example.com)。」。
2. 粘贴到 Word 新文档，观察行内代码部分的字体。
3. 用 Word 的「字体」框或宏/脚本读取该处字体名（Windows 侧用 COM 读 `Range.Font.Name`）。
4. 同时查看剪贴板 `HTML Format`（CF_HTML）：`<code>` 上是否带 `font-family`。

**期望**

- 行内代码在 Word 里保持等宽字体（`Consolas`、`Menlo` 等），不回退为正文中文字体。
- 若没有等宽效果，需记录这是否为两端共同现象（macOS 粘到 Pages / TextEdit 时是否同样回退），再决定是否在共享层 `editor.js` 生成复制 HTML 时给 `<code>` 内联 `font-family`。

**判据**

| 结论 | 勾选 |
| --- | --- |
| 通过 | [ ] |
| 不通过 | [ ] |
| 不适用 | [ ] |

> **Windows 实测对照（不代表 macOS）**：粘到 Word（Office 16）后 `backticks=0`，正文为「运行 npm test 之后再提交，见 链接。」；COM 读到 `npm` 的字体为**宋体**。同一次复制导出的 CF_HTML 为 `<p style="... font-family: -apple-system, &quot;PingFang SC&quot;, ...">运行 <code>npm test</code> ...</p>`，**`<code>` 上没有 `font-family`**，等宽字体未带入，Word 用正文中文字体渲染。反引号已按预期隐藏。**是否为两端共同现象尚未验证**；是否要在共享层补 `font-family` 也尚未决定。

---

## 四、失败时怎么记

每项不通过都要留下：

1. **现象**：哪一步、哪个目标、哪一段出错（粘贴结果尽量附原文）。
2. **截图**：Mote 中的对话框 / 选区 / 状态栏提示（第一项必须附对话框整图，能看清三个按钮）。
3. **Console 输出**：Console.app 里 Mote 的报错行。
4. **日志**：`MOTE_KEYLOG=1` 启动时 stderr 中相关片段（`NATIVE -> JS clipboard paste`、快捷键分发、`QT keypress` / 加速键转发、保存）。

处理原则：**先在 `mac/clipboard-followups` 上修**，不要直接合并到 `main`；修完重跑对应项并在 PR 里记录失败现象与修复提交。

---

## 五、结论怎么写

- **四项全过**：在 PR 描述里贴出四项结论（建议附截图），并注明：`mac/clipboard-followups` 除 Mac 侧提交外，还包含 Windows 机器提交的共享层提交（`23b6711`、`baa9b22`，以及 `a1ff0fc`），按 `docs/DECISIONS.md`「四、分支命名与归属」处理，不改写历史。
- **有失败**：PR 描述里写明失败项、现象与修复提交，修复并重跑通过后再合并。
- **第一项或第四项属文案 / 体验差异、不阻塞合并时**，也要在 PR 里写清处理结论（改、不改、留待下个版本），不要默认沉默。

---

> 本文件由 Windows 侧编写，仅作交接说明，**不代表 Mac 侧已经验证**。实际结论以 macOS 机器上的复跑结果为准。
