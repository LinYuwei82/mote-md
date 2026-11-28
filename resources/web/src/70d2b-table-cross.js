  // 表格块内的横向步进：格内逐字；跨格落到相邻格的首/末可见字符，绝不落进
  // | 标记或对齐行。返回 null 表示这个方向已经到表格两端，该跨出整块
  function crossStepInTable(el, abs, dir) {
    var spans = tableVisibleSpans(el);
    if (!spans.length)
      return null;
    if (abs < spans[0].start)
      return dir > 0 ? spans[0].start : null;
    if (abs > spans[spans.length - 1].end)
      return dir < 0 ? spans[spans.length - 1].end : null;
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      if (abs < span.start)
        return dir > 0 ? span.start : spans[i - 1].end;
      if (abs <= span.end) {
        if (dir < 0)
          return abs > span.start ? abs - 1 : (i > 0 ? spans[i - 1].end : null);
        return abs < span.end ? abs + 1 : (i + 1 < spans.length ? spans[i + 1].start : null);
      }
    }
    return null;
  }

  // 表格块里 raw 偏移 → 单元格可见文本里的点（不能停在 | 标记上）
  function tableCaretAt(el, offset) {
    var cells = tableCellList(el);
    for (var i = 0; i < cells.length; i++) {
      var nodes = editableTextNodes(cells[i]);
      for (var n = 0; n < nodes.length; n++) {
        var start = rawOffsetAtPoint(el, nodes[n], 0);
        var len = nodes[n].nodeValue.length;
        if (offset <= start + len)
          return { node: nodes[n], offset: Math.max(0, offset - start) };
      }
    }
    return null;
  }

  // 把折叠光标落到整篇绝对偏移处，返回实际落点（切块时会先 focus 触发
  // enterEdit 与滚动；表格要收进单元格可见文本，代码块要跳过围栏）
  function focusCrossAt(abs) {
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var list = blockList();
    var at = locateBlock(blocks, gaps, abs);
    var el = list[at.index];
    if (!el)
      return null;
    if (document.activeElement !== el)
      el.focus();
    var offset = Math.max(0, Math.min(at.start, blocks[at.index].length));
    if (el.classList.contains('table')) {
      var caret = tableCaretAt(el, offset);
      if (caret) {
        var range = document.createRange();
        try {
          range.setStart(caret.node, caret.offset);
          range.collapse(true);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          var placed = absoluteOf(el, caret.node, caret.offset);
          if (placed !== null)
            return placed;
        } catch (error) { /* 退回块内统一落点 */ }
      }
    }
    placeBlockCaret(el, offset);
    var live = window.getSelection();
    if (!live.rangeCount)
      return null;
    var settled = live.getRangeAt(0);
    var result = absoluteOf(el, settled.startContainer, settled.startOffset);
    return result === null ? blockStartOffset(blocks, gaps, at.index) + offset : result;
  }

  // Shift+←/→：块首/块尾才升级成跨块选区；升级后由这里逐字接管，块内横向
  // 选区仍交回原生
  function extendCrossSelectionHorizontal(el, left) {
    if (mode !== 'wysiwyg' || !el.classList.contains('editing'))
      return false;
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return false;
    var range = selection.getRangeAt(0);
    var anchorAbs = null;
    var focusAbs = null;
    var collapseNative = null;
    if (!crossSel) {
      var blocks = collectBlocks();
      var gaps = collectGaps();
      var list = blockList();
      // 看移动端（焦点）是否已经顶到块首/块尾；原生单块选区在这里一并升格
      var focusEl = blockOf(selection.focusNode) || el;
      var index = list.indexOf(focusEl);
      if (index < 0)
        return false;
      var off = rawOffsetAtPoint(focusEl, selection.focusNode, selection.focusOffset);
      // 代码块的可视行首/行尾在围栏之内、表格的首/末可见字符在 | 标记之后，
      // 这几个位置同样算作块首/块尾
      var visibleStart = 0;
      var visibleEnd = blocks[index].length;
      if (isCodeBlock(focusEl)) {
        visibleStart = codePrefixLength(focusEl);
        visibleEnd = crossEditableLength(focusEl, blocks[index]);
      } else if (focusEl.classList.contains('table')) {
        var core = tableCoreOffsets(focusEl);
        if (core) {
          visibleStart = core.start;
          visibleEnd = core.end;
        }
      }
      if (left ? off > visibleStart : off < visibleEnd)
        return false;
      focusAbs = blockStartOffset(blocks, gaps, index) + off;
      if (range.collapsed) {
        anchorAbs = focusAbs;
      } else {
        var anchorEl = blockOf(selection.anchorNode);
        var anchorIndex = anchorEl ? list.indexOf(anchorEl) : -1;
        if (anchorIndex < 0)
          return false;
        anchorAbs = blockStartOffset(blocks, gaps, anchorIndex)
          + rawOffsetAtPoint(anchorEl, selection.anchorNode, selection.anchorOffset);
        // 确定要接管后才把原生选区收成焦点处的折叠光标，高亮交给覆盖层；
        // 先收起会在边界上白白丢掉用户已有的选区
        collapseNative = document.createRange();
        try {
          collapseNative.setStart(selection.focusNode, selection.focusOffset);
          collapseNative.collapse(true);
        } catch (error) {
          collapseNative = null;
          return false;
        }
      }
    }
    var from = crossSel ? crossSel.focus : focusAbs;
    var to = crossStepTarget(from, left ? -1 : 1);
    if (to === null)
      return false;
    if (collapseNative) {
      selection.removeAllRanges();
      selection.addRange(collapseNative);
    }
    var placed = focusCrossAt(to);
    if (placed === null)
      return false;
    if (!crossSel)
      crossSel = { anchor: anchorAbs, focus: focusAbs, goalX: null };
    crossSel.focus = placed;
    // 横向移动后原来的目标列已经没意义，上下扩展时按新光标重新取
    crossSel.goalX = null;
    if (crossSel.anchor === crossSel.focus)
      clearCrossSelection();
    else
      paintCrossSelection();
    announceCross();
    return true;
  }

  function crossBounds() {
    if (!crossSel)
      return null;
    return {
      from: Math.min(crossSel.anchor, crossSel.focus),
      to: Math.max(crossSel.anchor, crossSel.focus)
    };
  }

  // 跨块选区的纯文本：逐块裁剪后按块拼接，口径与原生复制一致
  function crossSelectionPlainText() {
    var bounds = crossBounds();
    if (!bounds || bounds.from === bounds.to)
      return '';
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var list = blockList();
    var parts = [];
    var base = 0;
    for (var i = 0; i < blocks.length && base < bounds.to; i++) {
      var span = blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      var lo = Math.max(bounds.from, span.base);
      var hi = Math.min(bounds.to, span.stop);
      if (hi <= lo || !list[i] || list[i].classList.contains('hr')) {
        base = span.stop;
        continue;
      }
      // 表格直接取原文切片：| 与对齐行都在 raw 里，按 DOM 片段复制会把它们
      // 当零宽标记剔掉，粘回去就不再是表格
      if (list[i].classList.contains('table')) {
        parts.push(blocks[i].slice(lo - span.base, hi - span.base));
        base = span.stop;
        continue;
      }
      var range = crossBlockRange(list[i], lo - span.base, hi - span.base);
      parts.push(range ? cleanCopyFragment(range.cloneContents()) : '');
      base = span.stop;
    }
    return parts.join('\n');
  }

  // 表格单元格可见文本的整篇绝对区间；空格子没有可量测的文字，返回 null
  function tableCellAbsSpan(el, cell) {
    var nodes = editableTextNodes(cell);
    if (!nodes.length)
      return null;
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    var start = absoluteOf(el, first, 0);
    var end = absoluteOf(el, last, last.nodeValue.length);
    if (start === null || end === null)
      return null;
    return { start: start, end: end };
  }

  // 单元格里截取 [from, to)（单元格内可见文本口径）的克隆片段
  function cellClipContents(cell, from, to) {
    var nodes = editableTextNodes(cell);
    var acc = 0;
    var startNode = null, startOffset = 0, endNode = null, endOffset = 0;
    for (var i = 0; i < nodes.length && to > acc; i++) {
      var len = nodes[i].nodeValue.length;
      if (!startNode && from < acc + len) {
        startNode = nodes[i];
        startOffset = Math.max(0, from - acc);
      }
      if (to <= acc + len) {
        endNode = nodes[i];
        endOffset = Math.max(0, to - acc);
        break;
      }
      acc += len;
    }
    if (!startNode || !endNode)
      return null;
    var range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    } catch (error) {
      return null;
    }
    return range.cloneContents();
  }

