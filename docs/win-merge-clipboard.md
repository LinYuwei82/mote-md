# Windows 对接说明：合并 `win/paste-fallback` 与 `mac/clipboard-followups`

> 历史归档：命令与路径可能已过时，勿照做。
>
> 该合并已完成；文中 `src/webviewbase.cpp` 等 Qt 路径已删除，当前对应实现位于
> `shell/win/`（剪贴板命令在 `web_host_view.cpp`）与 `resources/web/editor.js`。
> 第 2 节的三条不变量仍然有效。

这份说明给 Windows 那台用。目的只有一个：把 `win/paste-fallback` 合进 `mac/clipboard-followups` 时，`resources/web/editor.js` 里 `clipboardPaste` 的块外分支只能保留一份实现，且必须同时满足两边的目标。

先读结论：

- 两条分支**只有一处**文本冲突，在 `resources/web/editor.js` 的 `clipboardPaste` 块外分支；
- 两边各自单独看都**不完整**，必须合成一份，不能「以谁为准」整段覆盖；
- 合并后只需要解这一处，其他段落保持 `mac/clipboard-followups` 的版本，不要用 Windows 旧版本覆盖回去。

| 分支 | 提交 | 内容 |
|---|---|---|
| `mac/clipboard-followups` | `a1ff0fc` | 块外粘贴撤销不再残留空块 |
| `win/paste-fallback` | `23b6711` | 块外空白区粘贴回退到补段落块 |
| `win/paste-fallback` | `baa9b22` | 文件列表剪贴板不再当文本粘贴（当时的 `src/webviewbase.cpp`，该文件已删除，与本次冲突无关） |

两条分支的共同祖先都是 `7170de7`，`baa9b22` 只改当时已删除的 `src/webviewbase.cpp`，可以干净合入；冲突只在 `23b6711` 与 `a1ff0fc` 之间。

---

## 1. 背景与冲突点

`clipboardPaste(text)` 是 Windows 才走的入口：当时 `src/webviewbase.cpp`（现为 `shell/win/web_host_view.cpp`）的 `clipboardCommand()` 读系统剪贴板，文本类内容通过 `evaluateJs("window.mote.clipboardPaste(...)")` 送进页面。macOS 不走这里，走的是 `document` 上的 `paste` 监听。

两块代码的分工不同，所以两边都得改：

- `a1ff0fc` 解决的是**撤销残留**：块外粘贴时旧代码先建空块、后落基线，基线快照里已经带着空块，一次 `Cmd+Z` 停在一个空段落上。修法是把 `commitHistory()` 提到建块之前，并让下游 `insertPastedText` 通过 `baselineDone` 跳过重复提交。
- `23b6711` 解决的是**点空白区没反应**：WebView2 下选区落在 `body`（不在 `#editor` 内），`caretParagraphBlock()` 取不到块、直接返回 null，于是只弹一句失败提示、正文没有任何变化。修法是加 `|| appendParagraphBlock()` 退回文末补块。

两边各写了一半，单独取任一边都会坏。

### 1.1 四点差异对照

| 维度 | `a1ff0fc`（editor.js 5363-5372） | `23b6711`（editor.js 5358-5363） |
|---|---|---|
| 撤销基线位置 | 建块**之前**显式 `commitHistory()` | 不提交，依赖 `insertPastedText` 内部提交 |
| 建块失败回退 | 只有 `caretParagraphBlock()`，失败即 `return false` + 状态栏提示 | `caretParagraphBlock() \|\| appendParagraphBlock()`，退回文末 |
| `baselineDone` 第三参 | `insertPastedText(text, neo, true)` | `insertPastedText(text, neo)`（该分支还是旧的两参签名） |
| 失败兜底提示 | 有：`!neo` 时提示「粘贴失败：先把光标放到正文里」 | 无（`appendParagraphBlock()` 不返回 null，不需要提示） |

配套差异（不冲突但必须一起看）：`a1ff0fc` 把 `insertPastedText` 与 `insertMultilinePaste` 的签名都加了 `baselineDone`，并把各自函数体头部原来的 `commitHistory()` 改成 `if (!baselineDone) commitHistory();`。`23b6711` 这两处还是旧写法。

### 1.2 单独取任一边会坏成什么样

**只取 `a1ff0fc`（即当前分支原样，Windows 不回退建块）**

Windows 点最后一块下方的空白区粘贴：选区在 `body`，`caretParagraphBlock()` 返回 null → 状态栏「粘贴失败：先把光标放到正文里」，正文零变化。`23b6711` 修的就是这个，等于把 Windows 的 bug 原样留着。

**只取 `23b6711`（Windows 边整段覆盖过来）**

两处会同时坏：

1. 建块发生在任何 `commitHistory()` 之前，接上本分支带 `baselineDone` 的 `insertPastedText` 后，函数内部那句 `if (!baselineDone) commitHistory()` 又把**含空块**的状态写成了「粘贴前」的基线 → 一次 `Cmd+Z` 停在空块上，`a1ff0fc` 修掉的问题原样复发；
2. 如果把 `insertPastedText` 也回退成旧签名（各分支自带 `commitHistory()`），结果一样：基线仍然晚于建块。

所以这两笔不是「二选一」，是**必须合体**：建块前落基线（`a1ff0fc`）+ 建块失败退回文末（`23b6711`）+ 把 `true` 传给下游（`a1ff0fc`）+ 保留失败提示（`a1ff0fc`）。

---

## 2. 必须遵守的不变量

改这段之前先读这三条，后面任何人按直觉改回去都会重新引入缺陷。

1. **撤销基线必须早于建块。** `clipboardPaste` 的块外分支里，`commitHistory()` 必须写在 `caretParagraphBlock()` / `appendParagraphBlock()` 之前。基线快照一旦包含这次粘贴新建的空块，「撤销」就只能回到带空块的中间态。
2. **`insertPastedText` / `insertMultilinePaste` 的 `baselineDone` 守卫不要动。** 块外路径已经提交过基线，传 `true` 让下游跳过；块内路径不传，仍由下游自己提交。删掉守卫会让一次粘贴变成两个撤销步骤；删掉第三参会让基线重复提交。
3. **图片分支保持「不预建块」。** `document` 的 paste 监听里，图片只调 `postImageFile(picture, 'paste')`，落盘、插引用、提交历史都由 `insertImage(rel)` 自己完成（该函数首行就是 `commitHistory()`）。这里如果补一块再插图片，撤销后会多一个空段落。

**特别警告：不要为了「失败就不提交」把 `commitHistory()` 挪到 `if (!neo)` 之后。** 这是最容易被想当然改的一处：看起来「先确认建块成功再记历史」更省事，实际会把基线挪到建块之后，立刻退回 `a1ff0fc` 之前的老问题——块外粘贴撤销后残留空块。`appendParagraphBlock()` 目前不会失败，`!neo` 分支是给 `caretParagraphBlock()` 单独使用时的防御，不要因为它存在就重排顺序。

---

## 3. 合并后的目标代码

`resources/web/editor.js` 中 `clipboardPaste` 合并后应为（只列该函数，缩进为文件内的 4 空格基准）：

```js
    clipboardPaste: function (text) {
      if (mode === 'source')
        return false;
      text = String(text === undefined || text === null ? '' : text);
      if (!text) {
        post({ type: 'status', message: '剪贴板里没有可粘贴的文本' });
        return false;
      }
      var selection = window.getSelection();
      var node = selection && selection.rangeCount ? selection.anchorNode : null;
      var el = node ? blockOf(node) : null;
      if (el) {
        insertPastedText(text, el);
        return true;
      }
      // 块外空白区：WebView2 下选区在 body（不在 #editor 内），caretParagraphBlock
      // 取不到块，退回文末补一个段落块；两条建块路径共用同一个撤销基线。
      // 基线必须先于建块，否则空块会被算进“粘贴前”的快照，撤销后残留。
      commitHistory();
      var neo = caretParagraphBlock() || appendParagraphBlock();
      if (!neo) {
        post({ type: 'status', message: '粘贴失败：先把光标放到正文里' });
        return false;
      }
      insertPastedText(text, neo, true);
      return true;
    },
```

只有块外分支（`if (el)` 之后到 `return true;`）是合并点，其余各行两边一致，冲突标记可能包住整个函数，解冲突时以上面的写法为准。

**除本函数外，`editor.js` 一律保留 `mac/clipboard-followups` 的版本**，特别注意不要被 Windows 旧版本覆盖回去的四处：

- `insertPastedText(text, el, baselineDone)`：签名带第三参，函数体头部是 `if (!baselineDone) commitHistory();`；
- `insertMultilinePaste(el, text, baselineDone)`：同上，且循环里补块不各自提交；
- `document` 上的 `paste` 监听（块外文本先 `commitHistory()` 再建块、图片分支不预建块）；
- `insertImage(rel)` 首行的 `commitHistory()`。

`src/webviewbase.cpp` 的 `baa9b22` 改动（`hasUrls()` 提前返回）直接合入，不做修改；图片分支在它之前处理，不受影响。

---

## 4. 落地顺序

推荐：

1. Windows 先把 `win/paste-fallback` 推完（`23b6711` + `baa9b22`），确认远端就是这两个提交；
2. 本分支 `git merge origin/win/paste-fallback`，只解 `clipboardPaste` 一处；
3. 解完跑第 5 节全部用例，再推（推之前不要 amend 已发布提交）。

不建议：

- **不建议 cherry-pick** 那两笔过来再解冲突。cherry-pick 产生同内容不同 hash 的重复提交，两条分支历史分叉更明显，review 也要重看一遍；合并只解一处冲突，代价更小、语义更清楚。
- **不建议先合 `main` 再回头合这条分支**。`main` 上没有这两处改动，先合只会让分支历史多一层无意义合并，冲突不会因此减少。
- **不要对已发布分支 rebase 或强推**。`mac/clipboard-followups` 已推送到远端并用于 PR，重写历史会让远端与本地分叉。

如果 Windows 暂时推不了，可以停在「文档已就绪 + 等对方推送」，不要在本分支上手动抄一份 `23b6711` 的代码又保留原提交，否则后面合并必然再冲突一次。

---

## 5. 复测清单

合并后必须两边都跑：Windows 跑 W1-W6，Mac 跑 W1-W3 回归（Mac 走 `document` paste 监听，W4-W6 的入口不同，不作为合并判据）。

每条都记录：粘贴前块数 → 粘贴后块数 → 撤销后块数 → `Ctrl+S` / `Cmd+S` 后落盘文件尾部。

### 5.1 Windows：W1-W6

| 编号 | 用例 | 操作 | 判定标准 |
|---|---|---|---|
| W1 | 块外单段 | 点最后一块下方空白，`Ctrl+V` 粘一段单行文本 | 正文末尾新增 1 段且内容正确；块数 +1；一次 `Ctrl+Z` 后块数回到粘贴前，无空段落；`Ctrl+S` 后文件尾部只有一个换行 |
| W2 | 空行三段 | 同一位置粘「甲段 / 空行 / 乙段 / 空行 / 丙段」 | 变成 3 个段落块（空行分隔），块数 +3；一次 `Ctrl+Z` 全部回退、块数复原；落盘无多余空行 |
| W3 | 图片 | 复制一张图片（截图或图片文件走 `hasImage()` 的路径），块外粘贴 | `assets/` 只多 1 个文件，正文只多 1 条 `![](...)` 引用；块数 +1（图片块本身）；一次 `Ctrl+Z` 后块数与引用都消失，无空段落；`Ctrl+Shift+Z` 重做不重复插入 |
| W4 | gap 建块 | 在**两个块之间**的空白（不是文末）点击后粘贴 | 新增段落落在该 gap 处（`caretParagraphBlock` 命中）；块数 +1；一次 `Ctrl+Z` 干净回退；若该位置取不到块，应落到文末而不是报失败 |
| W5 | 资源管理器复制文件 | 资源管理器里 `Ctrl+C` 复制一个文件，正文块外 `Ctrl+V` | 状态栏提示「剪贴板里没有可粘贴的文本」；正文零变化、块数不变；剪贴板内容不被当成路径插入；此时 `Ctrl+Z` 不产生任何回退 |
| W6 | 表格 / 代码块 / 源码态回归 | 分别在表格单元格内、代码块内、源码态粘贴多行文本 | 表格：单元格内容更新、表格结构不被拆坏；代码块：多行走代码块分支、不触发块外补块；源码态：按源码编辑处理，不出现双份插入；三者各自一次 `Ctrl+Z` 回到粘贴前，无空块 |

补充判据（W1-W4 通用）：一次粘贴只产生**一个**撤销步骤；撤销后再 `Ctrl+Shift+Z` 重做，内容与块数应与第一次粘贴后一致。

### 5.2 Mac：W1-W3 回归

| 编号 | 用例 | 判定标准 |
|---|---|---|
| W1 | 块外单段（`Cmd+V`） | 块数 +1，一次 `Cmd+Z` 干净回退，落盘尾部单换行 |
| W2 | 空行三段 | 3 个段落块，一次 `Cmd+Z` 全部回退 |
| W3 | 图片 | `assets/` 只 +1，引用只 +1，一次 `Cmd+Z` 无残留空块 |

Mac 这三条在 `a1ff0fc` 上已经实测通过，合并后再跑一遍是为了确认 `editor.js` 没有被整体覆盖回旧版本（跑法：块外粘贴后若撤销仍残留空块，说明 `insertPastedText` 的 `baselineDone` 守卫丢了）。

---

## 6. `caretParagraphBlock()` 失败的真实触发条件

函数不长，失败只有两条出口（`resources/web/editor.js` 3272-3287）：

```js
  function caretParagraphBlock() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (range.startContainer !== root && !root.contains(range.startContainer))
      return null;
    ...
  }
```

1. `rangeCount === 0`：没有选区。例如刚切换视图、焦点在工具栏按钮上、或宿主刚 `evaluateJs` 时页面还没把焦点还给正文。
2. `range.startContainer` 不在 `#editor`（`root`）内：光标停在 `body` 上。

第 2 条就是 Windows 的典型场景：点最后一块下方的空白区，WebView2 把插入点放在 `body`，`#editor` 内没有任何锚点。macOS 的 WKWebView 在这类点击后通常仍把选区锚在 `#editor` 的最后一个块上，所以这个分支在 Mac 上很少触发——这也解释了为什么 `23b6711` 只在 Windows 表现为「点空白区粘贴没反应」。

因此块外分支必须写成 `caretParagraphBlock() || appendParagraphBlock()`：

- 能取到块（gap 点击、`#editor` 内任意位置）→ 就地建块，粘贴落在点击处；
- 取不到块（文末空白、`body` 选区）→ 退回文末补一个段落块，粘贴仍能落进正文。

两条路径都在 `commitHistory()` 之后执行，共用同一个撤销基线，所以无论是哪条，一次 `Ctrl+Z` 都只回退这一次粘贴，不会留下空块。`!neo` 的提示只作为最后兜底保留：`appendParagraphBlock()` 当前无条件 `root.appendChild` 并返回节点，不会返回 null。

---

## 附：合并后自查

- [ ] `git diff` 里 `editor.js` 只有 `clipboardPaste` 块外分支一处变化；
- [ ] `insertPastedText` / `insertMultilinePaste` 仍是三参签名，头部仍是 `if (!baselineDone) commitHistory();`；
- [ ] `clipboardPaste` 里 `commitHistory()` 在建块语句之前；
- [ ] `document` paste 监听与 `insertImage` 未被改动；
- [ ] W1-W6 全过，Mac W1-W3 回归通过。
