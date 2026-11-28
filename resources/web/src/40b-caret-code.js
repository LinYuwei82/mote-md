  function blockOf(node) {
    while (node && node !== root) {
      if (node.classList && node.classList.contains('block'))
        return node;
      node = node.parentNode;
    }
    return null;
  }

  function setCaret(el, offset) {
    // 折叠标记模式下，偏移必须按零宽原子取整，否则光标会落进 <i> 里
    if (INLINE_PROTO) {
      setSelectionRange(el, offset);
      return;
    }
    var range = document.createRange();
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var remaining = offset;
    var node = null;

    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        range.setStart(node, remaining);
        range.collapse(true);
        break;
      }
      remaining -= node.nodeValue.length;
    }
    if (!node) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 任意 DOM 位置 → 相对 root 的字符偏移（只数字符，不计元素）。位置不在
  // root 内时返回 -1。
  function offsetIn(rootEl, container, offset) {
    var range = document.createRange();
    range.selectNodeContents(rootEl);
    try {
      range.setEnd(container, offset);
    } catch (error) {
      return -1;
    }
    return range.toString().length;
  }

  // 当前选区在某个元素内的字符范围；选区不在该元素内时返回 null
  function rangeIn(rootEl) {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (range.startContainer !== rootEl && !rootEl.contains(range.startContainer))
      return null;
    if (range.endContainer !== rootEl && !rootEl.contains(range.endContainer))
      return null;
    var start = offsetIn(rootEl, range.startContainer, range.startOffset);
    var end = offsetIn(rootEl, range.endContainer, range.endOffset);
    if (start < 0 || end < 0)
      return null;
    return { start: start, end: Math.max(start, end) };
  }

  // 徽标可能被原生编辑整块删掉（整块选中后退格/删除时，WebKit 会把不可编辑的
  // span 一起移除）。此时补回一个徽标，否则语言就再也改不回来。
  function ensureLangBadge(el) {
    var badge = el.querySelector('.code-lang');
    if (badge)
      return badge;
    var pre = el.querySelector('pre.code-block');
    if (!pre)
      return null;
    badge = document.createElement('span');
    badge.className = 'code-lang';
    badge.setAttribute('contenteditable', 'false');
    badge.setAttribute('spellcheck', 'false');
    badge.setAttribute('role', 'button');
    badge.setAttribute('aria-haspopup', 'listbox');
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-label', '代码语言');
    badge.textContent = el.dataset.lang || '';
    badge.title = el.dataset.lang || '';
    var tools = pre.querySelector('.code-tools');
    if (tools)
      tools.insertBefore(badge, tools.firstChild);
    else
      pre.insertBefore(badge, pre.firstChild);
    return badge;
  }

  // 整段替换 <code> 的 innerHTML 会把 .code-scroll 的横向滚动位置冲回 0，长行
  // 已经滚到右边时视野会跳回行首。替换前后保存/恢复；没滚动过就不写回，省掉
  // 一次强制布局。
  function setCodeHtml(el, code, html) {
    var scroller = el.querySelector('.code-scroll');
    var left = scroller ? scroller.scrollLeft : 0;
    var top = scroller ? scroller.scrollTop : 0;
    code.innerHTML = html;
    if (scroller && (left || top)) {
      scroller.scrollLeft = left;
      scroller.scrollTop = top;
    }
  }

  // 重着色 + 按字符偏移复位光标。用 lang+正文当签名：已经画过的这版内容不再
  // 整段替换（徽标合并重着色、连续 input 都会撞到）。
  function drawCode(el) {
    var code = codeEl(el);
    if (!code)
      return null;
    var text = code.textContent;
    var sig = (el.dataset.lang || '') + '\n' + text;
    if (el._codeDrawn === sig)
      return code;
    var range = rangeIn(code);
    setCodeHtml(el, code, highlightCode(el, text, el.dataset.lang).join('\n'));
    el._codeDrawn = sig;
    if (range)
      setSelectionRange(code, range.start, range.end);
    return code;
  }

  // 改语言：同步 dataset.lang → 原文首行围栏，并立即按新语言重着色。
  // 重着色只重建 <code> 的行内 span（只变颜色，不变字号/行高/宽度），
  // 因此块几何不变；光标在正文里时按字符偏移恢复。
  function applyCodeLang(el, value) {
    // 语言标识不允许空白与反引号（会破坏首行围栏），直接剔除；
    // 保证「徽标显示 === dataset.lang === 围栏内容」三者一致。
    var lang = String(value === undefined || value === null ? '' : value)
      .replace(/[\s`]/g, '');
    var badge = el.querySelector('.code-lang');
    if (badge && badge.textContent !== lang) {
      badge.textContent = lang;
      badge.title = lang;
    }
    el.dataset.lang = lang;
    el.dataset.raw = codeRaw(el);
    el._codeStale = false;
    if (codeEl(el))
      drawCode(el);
    scheduleMermaid();
  }

  // 把代码正文重新着色：只重建 <code> 的行内 span（文本不变，字体/行高/宽度
  // 都不变），随后按字符偏移把光标放回原处。组合输入期间不调用。
  function syncCode(el, highlight) {
    var code = codeEl(el);
    if (!code)
      return;
    var text = code.textContent;
    el.dataset.raw = codeRaw(el, text);
    updateGutter(el, text);
    el._codeStale = false;
    if (highlight)
      drawCode(el);
  }

  // 在代码正文的选区处插入纯文本（回车、粘贴共用）。返回值表示是否处理成功；
  // 成功时同步原文/行号并保持光标在插入内容之后。
  function insertCodeText(el, text) {
    var code = codeEl(el);
    if (!code)
      return false;
    var range = rangeIn(code);
    var value = code.textContent;
    if (!range)
      range = { start: value.length, end: value.length };
    var next = value.slice(0, range.start) + text + value.slice(range.end);
    el.dataset.raw = codeRaw(el, next);
    updateGutter(el, next);
    el._codeStale = false;
    setCodeHtml(el, code, highlightCode(el, next, el.dataset.lang).join('\n'));
    el._codeDrawn = (el.dataset.lang || '') + '\n' + next;
    setSelectionRange(code, range.start + text.length);
    return true;
  }

  function caretOffset(el) {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return 0;
    // 代码块的光标偏移只按 <code> 里的正文计算，行号栏不能算进去
    var scope = isCodeBlock(el) ? codeEl(el) : el;
    if (!scope)
      return 0;
    var range = selection.getRangeAt(0);
    var prefix = range.cloneRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.endContainer, range.endOffset);
    } catch (error) {
      return 0;
    }
    return prefix.toString().length;
  }

  // caretOffset 对代码块给的是 <code> 内偏移，placeBlockCaret 收的却是块原文
  // 口径（dataset.raw，含围栏行）；要在两处之间存取光标（如查找栏开/关）必须
  // 先补齐围栏长度，否则回来时会被 placeBlockCaret 再减一次，光标往左偏。
  function rawCaretOffset(el) {
    return caretOffset(el) + (isCodeBlock(el) ? codePrefixLength(el) : 0);
  }

  function blockIndex(el) {
    return Array.prototype.indexOf.call(root.children, el);
  }

  // 字符偏移 → DOM 位置（用于撤销后恢复选区）。
  // 原型模式下列标记为零宽原子：落进标记内部时按左右边界取整，绝不把光标
  // 放进绝对定位的标记文本里（否则会出现看不见的光标 / 候选框错位）。
  function locateOffset(el, offset) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var remaining = Math.max(0, offset || 0);
    var node = null;
    var last = null;
    while ((node = walker.nextNode())) {
      if (INLINE_PROTO) {
        var mk = node.parentNode && node.parentNode.closest ? node.parentNode.closest('.mk') : null;
        if (mk) {
          var mkLen = node.nodeValue.length;
          var idx = Array.prototype.indexOf.call(mk.parentNode.childNodes, mk);
          if (remaining < mkLen)
            return remaining * 2 >= mkLen
              ? { node: mk.parentNode, offset: idx + 1 }
              : { node: mk.parentNode, offset: idx };
          remaining -= mkLen;
          last = { node: mk.parentNode, offset: idx + 1 };
          continue;
        }
      }
      last = { node: node, offset: node.nodeValue.length };
      if (remaining <= node.nodeValue.length)
        return { node: node, offset: remaining };
      remaining -= node.nodeValue.length;
    }
    if (last)
      return last;
    return { node: el, offset: 0 };
  }

  function setSelectionRange(el, start, end) {
    var from = locateOffset(el, start);
    var to = locateOffset(el, end === undefined ? start : end);
    var range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch (error) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 当前块内选区 → 整篇绝对偏移。失焦（没有活动编辑块）时 has 为 false
  function editingSelection() {
    var active = document.activeElement;
    var el = active ? blockOf(active) : null;
    var selection = window.getSelection();
    if (!el || !el.classList.contains('editing') || !selection.rangeCount)
      return { index: -1, start: 0, end: 0 };
    var code = isCodeBlock(el) ? codeEl(el) : null;
    var scope = code || el;
    var range = selection.getRangeAt(0);
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch (error) {
      prefix.selectNodeContents(scope);
    }
    // 代码块补上 "```lang\n" 前缀，才是与 dataset.raw 一致的块内偏移
    var start = prefix.toString().length + (code ? codePrefixLength(el) : 0);
    return { index: blockIndex(el), start: start, end: start + range.toString().length };
  }

  function absoluteOffsets(blocks, sel) {
    if (sel.index < 0)
      return { start: 0, end: 0, has: false };
    var base = blockStartOffset(blocks, collectGaps(), sel.index);
    return { start: base + sel.start, end: base + sel.end, has: true };
  }

  // 快照：wysiwyg 只保留块数组与块间空行（保住文首/文末空行），source 只保留
  // 纯文本。wysiwyg 的整篇文本由 layoutText 按需拼出，不额外存副本。
  function snapshotState() {
    if (mode === 'source') {
      var text = sourceEl.value;
      return {
        text: text, blocks: null, gaps: null, trail: trailingNewlineCount(text),
        start: sourceEl.selectionStart, end: sourceEl.selectionEnd,
        hasSel: document.activeElement === sourceEl
      };
    }
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var sel = editingSelection();
    var offsets = absoluteOffsets(blocks, sel);
    return {
      text: null,
      blocks: blocks, gaps: gaps, trail: trailingNewlines,
      start: offsets.start, end: offsets.end, hasSel: offsets.has
    };
  }

  function stateText(snap) {
    if (typeof snap.text === 'string')
      return snap.text;
    return layoutText(snap.blocks, snap.gaps, snap.trail);
  }

  function sameState(a, b) {
    // 同一模式的 wysiwyg 快照逐块比较即可，不必先把整篇拼成字符串
    if (a.blocks && b.blocks) {
      if (a.blocks.length !== b.blocks.length || a.trail !== b.trail)
        return false;
      for (var i = 0; i < a.blocks.length; i++)
        if (a.blocks[i] !== b.blocks[i])
          return false;
      // 块间空行也是文档内容：只改空行数量同样要落一个撤销步
      var gapsA = a.gaps || [];
      var gapsB = b.gaps || [];
      if (gapsA.length !== gapsB.length)
        return false;
      for (var g = 0; g < gapsA.length; g++)
        if (gapsA[g] !== gapsB[g])
          return false;
      return true;
    }
    return stateText(a) === stateText(b);
  }

  // 提交一个撤销步骤；文本未变化时只更新当前步的选区，避免进出编辑态
  // 或纯光标移动产生多余的历史记录
  function commitHistory() {
    // 批量转换期间（含焦点在块间移动触发的提交）不落历史，结尾统一提交一次
    if (suppressEvents || commitBatch > 0)
      return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    var snap = snapshotState();
    var current = history[historyIndex];
    if (current && sameState(current, snap)) {
      current.start = snap.start;
      current.end = snap.end;
      current.hasSel = snap.hasSel;
      scheduleDirty();
      return;
    }
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > MAX_HISTORY)
      history.splice(0, history.length - MAX_HISTORY);
    historyIndex = history.length - 1;
    scheduleDirty();
  }

  function scheduleCommit() {
    if (suppressEvents || composing || commitBatch > 0)
      return;
    if (commitTimer)
      clearTimeout(commitTimer);
    commitTimer = setTimeout(function () {
      commitTimer = null;
      commitHistory();
    }, COALESCE_MS);
  }

  // gaps 省略时全部按默认间隔（新建块之间的 2 个换行），供只关心文本的调用方使用
  function mountBlocks(blocks, gaps, trail, deferHi, skipNormalize) {
    var _t0 = window.MOTE_PERF ? performance.now() : 0;
    // 整篇重建后旧的绝对偏移全部失效，跨块选区必须先清掉
    clearCrossSelection();
    closeLangMenu();
    // 块菜单/手柄指向的旧节点即将全部脱离 DOM：撤销、重做、整篇载入都要收拢，
    // 否则菜单会悬空浮在重建后的文档上（动作虽有 parentNode 兜底不会误伤）
    closeBlockMenu();
    blockHandleTarget = null;
    if (blockHandle)
      blockHandle.style.display = 'none';
    root.innerHTML = '';
    var _t1 = window.MOTE_PERF ? performance.now() : 0;
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < blocks.length; i++) {
      var el = document.createElement('div');
      el.className = 'block';
      el.setAttribute('contenteditable', 'true');
      if (gaps)
        el.dataset.gap = String(gapBefore(gaps, i));
      renderBlock(el, blocks[i], deferHi);
      fragment.appendChild(el);
    }
    root.appendChild(fragment);
    var _t2 = window.MOTE_PERF ? performance.now() : 0;
    if (typeof trail === 'number')
      trailingNewlines = trail > 0 ? trail : 0;
    // 全部挂载完成、文档结构稳定后再归一化，避免逐个元素强制布局；
    // 新页首挂（skipNormalize）时浏览器本来就按含滚动条的高度排版，跳过这次补偿。
    if (!skipNormalize)
      normalizeCodeScrolls();
    var _t3 = window.MOTE_PERF ? performance.now() : 0;
    postWordCount();
    scheduleMermaid();
    flushDeferredCode();
    var _t4 = window.MOTE_PERF ? performance.now() : 0;
    if (window.MOTE_PERF) {
      post({type:'log', message:'PERF mountBlocks cleanup:' + (_t1-_t0).toFixed(1)
        + ' | mount:' + (_t2-_t1).toFixed(1) + ' | norm:' + (_t3-_t2).toFixed(1)
        + ' | wc:' + (_t4-_t3).toFixed(1) + ' | blocks:' + blocks.length});
    }
  }

  // 绝对偏移 → 所在块下标与块内偏移（undo/redo 恢复选区用）
  function locateBlock(blocks, gaps, absStart) {
    var base = 0;
    for (var i = 0; i < blocks.length; i++) {
      base += gapBefore(gaps, i);
      var stop = base + blocks[i].length;
      if (absStart <= stop || i === blocks.length - 1)
        return { index: i, start: Math.max(0, absStart - base) };
      base = stop;
    }
    return { index: blocks.length - 1, start: 0 };
  }

  function rebuildFromSnapshot(snap) {
    suppressEvents = true;
    var scrollY = window.scrollY;

    if (mode === 'source') {
      sourceEl.value = stateText(snap);
      trailingNewlines = snap.trail > 0 ? snap.trail : 0;
    } else {
      var layout = snap.blocks
        ? { blocks: snap.blocks.slice(), gaps: snap.gaps || [], trail: snap.trail }
        : splitSourceLayout(stateText(snap));
      var blocks = layout.blocks;
      mountBlocks(blocks, layout.gaps, layout.trail);

      if (snap.hasSel) {
        var base = 0;
        var index = -1;
        var start = 0;
        var end = 0;
        for (var i = 0; i < blocks.length; i++) {
          base += gapBefore(layout.gaps, i);
          var stop = base + blocks[i].length;
          if (snap.start <= stop || i === blocks.length - 1) {
            index = i;
            start = Math.max(0, snap.start - base);
            end = Math.max(start, Math.min(snap.end, stop) - base);
            break;
          }
          base = stop;
        }
        if (index >= 0 && root.children[index]) {
          var target = root.children[index];
          if (inPlaceEditable(target)) {
            renderBlock(target, blocks[index]);
            normalizeCodeScrolls(target);
            target.classList.add('editing');
            target.focus();
            placeBlockCaret(target, start, end);
          } else {
            target.classList.add('editing');
            target.textContent = blocks[index];
            target.focus();
            setSelectionRange(target, start, end);
          }
        }
      }
    }

    suppressEvents = false;
    if (mode === 'source' && snap.hasSel) {
      try {
        sourceEl.focus();
        sourceEl.setSelectionRange(snap.start, snap.end);
      } catch (error) { /* ignore */ }
    }
    window.scrollTo(0, scrollY);
    scheduleDirty();
    refreshToc();
    // 撤销/重做会整篇重建，旧的命中区间已经失效；查找条开着就重扫一遍
    if (findBar)
      scheduleFind();
  }

  function undo() {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
      commitHistory();
    }
    if (historyIndex <= 0) {
      post({ type: 'log', message: 'undo skipped index=' + historyIndex + ' size=' + history.length });
      return;
    }
    historyIndex--;
    post({ type: 'log', message: 'undo -> index=' + historyIndex + ' size=' + history.length });
    rebuildFromSnapshot(history[historyIndex]);
  }

  function redo() {
    if (historyIndex < 0 || historyIndex >= history.length - 1) {
      post({ type: 'log', message: 'redo skipped index=' + historyIndex + ' size=' + history.length });
      return;
    }
    historyIndex++;
    post({ type: 'log', message: 'redo -> index=' + historyIndex + ' size=' + history.length });
    rebuildFromSnapshot(history[historyIndex]);
  }

