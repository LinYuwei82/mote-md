  function dropCrossLayer() {
    if (crossLayer && crossLayer.parentNode)
      crossLayer.parentNode.removeChild(crossLayer);
    crossLayer = null;
  }

  function ensureCrossLayer() {
    if (!crossLayer) {
      crossLayer = document.createElement('div');
      crossLayer.id = 'cross-layer';
      crossLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(crossLayer);
    }
    return crossLayer;
  }

  // 状态变化才回报：macOS 菜单的复制/剪切在折叠选区下会被 WebKit 判成「不可
  // 复制」，需要外壳改走 EditorController::clipboardCommand 这条回路。
  function announceCross() {
    var active = !!crossSel;
    if (active === crossAnnounced)
      return;
    crossAnnounced = active;
    post({ type: 'crossSelection', active: active });
  }

  function clearCrossSelection() {
    if (!crossSel)
      return;
    crossSel = null;
    dropCrossLayer();
    announceCross();
  }

  // 第 index 块在整篇里的字符长度与起点（与撤销栈同一口径）
  function blockAbsoluteSpan(blocks, gaps, index) {
    var base = blockStartOffset(blocks, gaps, index);
    return { base: base, stop: base + blocks[index].length };
  }

  // 区间里是否真的有块正文：块间空白处投点得到的「只跨过空行」区间画不出任何
  // 高亮，扩展时要跳过这种落点，继续往下一可视行找。
  function crossRangeCoversText(from, to) {
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var base = 0;
    for (var i = 0; i < blocks.length && base < to; i++) {
      var span = blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      if (span.stop > span.base
          && Math.min(to, span.stop) > Math.max(from, span.base))
        return true;
      base = span.stop;
    }
    return false;
  }

  function absoluteOf(el, node, offset) {
    var list = blockList();
    var index = list.indexOf(el);
    if (index < 0)
      return null;
    var blocks = collectBlocks();
    var gaps = collectGaps();
    return blockStartOffset(blocks, gaps, index) + rawOffsetAtPoint(el, node, offset);
  }

  // 块内某个 DOM 点 → 块内 raw 偏移（代码块补上围栏前缀）
  function rawOffsetAtPoint(el, node, offset) {
    var scope = navScope(el) || el;
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(node, offset);
    } catch (error) {
      return 0;
    }
    return prefix.toString().length + (isCodeBlock(el) ? codePrefixLength(el) : 0);
  }

  // 块内 raw 区间 → Range。分隔线没有可量测的文字，原型里不画它的高亮。
  function crossBlockRange(el, start, end) {
    if (!el || el.classList.contains('hr'))
      return null;
    var scope = navScope(el);
    if (!scope)
      return null;
    var prefix = isCodeBlock(el) ? codePrefixLength(el) : 0;
    var limit = scope.textContent.length;
    var from = Math.max(0, Math.min(start - prefix, limit));
    var to = Math.max(0, Math.min(end - prefix, limit));
    if (to <= from)
      return null;
    var a = locateOffset(scope, from);
    var b = locateOffset(scope, to);
    var range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (error) {
      return null;
    }
    return range;
  }

  // 逐块切开绝对区间取客户矩形，画成覆盖层色块（不插入任何正文节点）
  function paintCrossSelection() {
    if (!crossSel) {
      dropCrossLayer();
      return;
    }
    var from = Math.min(crossSel.anchor, crossSel.focus);
    var to = Math.max(crossSel.anchor, crossSel.focus);
    if (from === to) {
      dropCrossLayer();
      return;
    }
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var list = blockList();
    var layer = ensureCrossLayer();
    while (layer.firstChild)
      layer.removeChild(layer.firstChild);
    var base = 0;
    for (var i = 0; i < blocks.length && base < to; i++) {
      var span = blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      var lo = Math.max(from, span.base);
      var hi = Math.min(to, span.stop);
      if (hi > lo) {
        var range = crossBlockRange(list[i], lo - span.base, hi - span.base);
        var rects = range ? range.getClientRects() : [];
        for (var r = 0; r < rects.length; r++) {
          if (rects[r].width <= 0.5 || rects[r].height <= 0.5)
            continue;
          var box = document.createElement('div');
          box.className = 'cross-hit';
          box.style.left = (rects[r].left + window.scrollX) + 'px';
          box.style.top = (rects[r].top + window.scrollY) + 'px';
          box.style.width = rects[r].width + 'px';
          box.style.height = rects[r].height + 'px';
          layer.appendChild(box);
        }
      }
      base = span.stop;
    }
  }

  // 投点是否落在可编辑正文里：行号栏、语言徽标与工具条都不是正文
  function crossHitNodeOk(el, node) {
    if (!node || !pointInNavScope(el, node))
      return false;
    var host = node.nodeType === 1 ? node : node.parentNode;
    if (host && host.closest && host.closest('.gutter, .code-lang, .code-tools'))
      return false;
    return true;
  }

  function blockAtAbsolute(abs) {
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var at = locateBlock(blocks, gaps, abs);
    return { el: blockList()[at.index] || null, index: at.index, start: at.start };
  }

  // 量某个 DOM 点旁边那个字符的矩形（WebKit 的折叠 Range 常是 0×0）。
  // 用来判断投点是否真的换了一可视行，而不是同一行内横向漂移。
  function pointCharRect(node, offset, forward) {
    if (!node || node.nodeType !== 3 || !node.nodeValue.length)
      return null;
    var index = forward
      ? Math.min(offset, node.nodeValue.length - 1)
      : Math.max(0, offset - 1);
    var range = document.createRange();
    try {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
    } catch (error) {
      return null;
    }
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].height > 0.5)
        return rects[i];
    }
    return null;
  }

  // 从焦点光标往 up/down 走一可视行。优先按目标列投点（caretRangeFromPoint），
  // 投不到（块间空白比一行宽、目标在视口外）时退到相邻块的首/末行。
  function moveCrossFocus(up) {
    if (!crossSel)
      return false;
    var at = blockAtAbsolute(crossSel.focus);
    var el = at.el;
    if (!el)
      return false;
    var caret = caretRectOfSelection();
    var line = caret || contentEdgeRect(el, up);
    if (!line)
      return false;
    var height = line.height || 20;
    var x = typeof crossSel.goalX === 'number' ? crossSel.goalX : line.left;
    var startY = up ? line.top : line.bottom;
    // 块上下有内边距/外边距（代码块尤其高）：投点要够远才能落到下一块的正文行
    var limit = Math.max(32, height * 5);
    var hit = null;
    if (document.caretRangeFromPoint) {
      for (var d = 1; d <= limit; d += 2) {
        var probe = document.caretRangeFromPoint(x, up ? startY - d : startY + d);
        if (!probe)
          continue;
        var node = probe.startContainer;
        var target = blockOf(node);
        if (!target || !crossHitNodeOk(target, node))
          continue;
        var abs = absoluteOf(target, node, probe.startOffset);
        // 只认「按方向真正前进」的落点：块内边距里投点会得到更靠后的坐标，
        // 反向落点会让选区原地打转
        if (abs === null || (up ? abs >= crossSel.focus : abs <= crossSel.focus))
          continue;
        // 同一可视行内的投点只是横向漂移（行尾/行首），不算换行
        var charRect = pointCharRect(node, probe.startOffset, !up);
        if (charRect && (up ? charRect.bottom > line.top + 1 : charRect.top < line.bottom - 1))
          continue;
        // 块间空白处的投点只会得到「跨过空行」的区间，画不出高亮：继续往下找
        if (!crossRangeCoversText(crossSel.focus, abs))
          continue;
        hit = { el: target, range: probe, abs: abs };
        break;
      }
    }
    if (!hit) {
      var next = up ? el.previousElementSibling : el.nextElementSibling;
      while (next && !(next.classList && next.classList.contains('block')))
        next = up ? next.previousElementSibling : next.nextElementSibling;
      if (!next)
        return false;
      next.focus();   // 视口外时由焦点滚动带进视野
      placeCaretInBlock(next, up, x);
      var selection = window.getSelection();
      if (!selection.rangeCount)
        return false;
      var settled = selection.getRangeAt(0);
      var settledAbs = absoluteOf(next, settled.startContainer, settled.startOffset);
      if (settledAbs === null)
        return false;
      hit = { el: next, range: settled.cloneRange(), abs: settledAbs };
    }
    if (document.activeElement !== hit.el)
      hit.el.focus();
    var range = window.getSelection();
    range.removeAllRanges();
    range.addRange(hit.range);
    crossSel.focus = hit.abs;
    return true;
  }

  // Shift+↑/↓：块首/块尾才升级成跨块选区；升级后一直由这里接管，直到清除
  function extendCrossSelection(el, up) {
    if (mode !== 'wysiwyg' || !el.classList.contains('editing'))
      return false;
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return false;
    var range = selection.getRangeAt(0);
    if (!crossSel) {
      var caret = caretRectOfSelection();
      if (!caretAtBlockEdge(el, up, caret))
        return false;
      var index = blockList().indexOf(el);
      if (index < 0)
        return false;
      var blocks = collectBlocks();
      var gaps = collectGaps();
      var base = blockStartOffset(blocks, gaps, index);
      var anchorAbs, focusAbs;
      if (range.collapsed) {
        anchorAbs = focusAbs = base + rawOffsetAtPoint(el, range.startContainer, range.startOffset);
      } else {
        // 原生单块选区升格：锚点取 anchor 端，焦点取 focus 端；随后把原生选区
        // 收成焦点处的折叠光标，高亮整段交给覆盖层
        anchorAbs = base + rawOffsetAtPoint(el, selection.anchorNode, selection.anchorOffset);
        focusAbs = base + rawOffsetAtPoint(el, selection.focusNode, selection.focusOffset);
        var collapsed = document.createRange();
        try {
          collapsed.setStart(selection.focusNode, selection.focusOffset);
          collapsed.collapse(true);
          selection.removeAllRanges();
          selection.addRange(collapsed);
        } catch (error) { /* ignore */ }
        caret = caretRectOfSelection();
      }
      crossSel = {
        anchor: anchorAbs,
        focus: focusAbs,
        goalX: caret ? caret.left : null
      };
    }
    moveCrossFocus(up);
    if (crossSel.anchor === crossSel.focus)
      clearCrossSelection();
    else
      paintCrossSelection();
    announceCross();
    return true;
  }

  // 可编辑长度：代码块的围栏前缀与收尾围栏都不可编辑，只算正文
  function crossEditableLength(el, raw) {
    if (!el || !isCodeBlock(el))
      return raw.length;
    var code = codeEl(el);
    return codePrefixLength(el) + (code ? code.textContent.length : 0);
  }

  // 整篇绝对偏移按字符左右步进。块内逐字走；越过块间空行时直接落到相邻块的
  // 端点上——空行本身画不出高亮，停在空行里等同于原地不动。代码块两端还要
  // 跳过不可编辑的围栏，否则光标会在围栏里空走好几下。
  function crossStepTarget(abs, dir) {
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var list = blockList();
    var base = 0;
    for (var i = 0; i < blocks.length; i++) {
      var gap = gapBefore(gaps, i);
      base += gap;
      var stop = base + blocks[i].length;
      var visible = crossEditableLength(list[i], blocks[i]);
      if (abs < base) {
        // 落在块前空行：向左归到上一块末尾，向右归到本块开头
        if (dir < 0)
          return i > 0 ? crossPrevEnd(blocks, gaps, list, i) : null;
        return base;
      }
      if (abs > stop) {
        base = stop;
        continue;
      }
      // 表格整块交给按格步进：| 标记与对齐行都不可编辑
      if (list[i] && list[i].classList.contains('table')) {
        var tableTarget = crossStepInTable(list[i], abs, dir);
        if (tableTarget !== null)
          return tableTarget;
        return dir < 0 ? crossPrevEnd(blocks, gaps, list, i)
          : (i + 1 < blocks.length ? stop + gapBefore(gaps, i + 1) : null);
      }
      if (dir < 0) {
        // 围栏前缀不可编辑：停在正文行首时直接跨到上一块末尾
        if (isCodeBlock(list[i]) && abs <= base + codePrefixLength(list[i]))
          return i > 0 ? crossPrevEnd(blocks, gaps, list, i) : null;
        // 收尾围栏不可编辑：归到正文末尾
        if (abs > base + visible)
          return base + visible;
        if (abs > base)
          return abs - 1;
        if (i === 0)
          return null;
        // 行首：退到上一块末尾；块间没有空行时两个端点重合，再退一个字
        return gap > 0 ? crossPrevEnd(blocks, gaps, list, i) : abs - 1;
      }
      if (abs < base + visible)
        return abs + 1;
      if (i + 1 >= blocks.length)
        return null;
      var nextGap = gapBefore(gaps, i + 1);
      return nextGap > 0 ? stop + nextGap : abs + 1;
    }
    return null;
  }

  // 第 index 块之前那一块的可编辑末尾
  function crossPrevEnd(blocks, gaps, list, index) {
    var prev = index - 1;
    if (prev < 0)
      return null;
    var start = blockStartOffset(blocks, gaps, prev);
    return start + crossEditableLength(list[prev], blocks[prev]);
  }

  // 表格块的可编辑核心：首格可见起点 / 末格可见终点（块内 raw 偏移）。块首的
  // | 标记与隐藏的对齐行都不可编辑，光标不能停在它们里面
  function tableCoreOffsets(el) {
    var cells = tableCellList(el);
    var first = null;
    var last = null;
    for (var i = 0; i < cells.length; i++) {
      var nodes = editableTextNodes(cells[i]);
      if (!nodes.length)
        continue;
      if (!first)
        first = nodes[0];
      last = nodes[nodes.length - 1];
    }
    if (!first)
      return null;
    return {
      start: rawOffsetAtPoint(el, first, 0),
      end: rawOffsetAtPoint(el, last, last.nodeValue.length)
    };
  }

  // 表格块里每格可见文本在整篇里的连续区间（空格子不参与）
  function tableVisibleSpans(el) {
    var cells = tableCellList(el);
    var spans = [];
    for (var i = 0; i < cells.length; i++) {
      var nodes = editableTextNodes(cells[i]);
      if (!nodes.length)
        continue;
      var total = 0;
      for (var n = 0; n < nodes.length; n++)
        total += nodes[n].nodeValue.length;
      if (!total)
        continue;
      var start = absoluteOf(el, nodes[0], 0);
      var end = absoluteOf(el, nodes[nodes.length - 1], nodes[nodes.length - 1].nodeValue.length);
      if (start === null || end === null)
        continue;
      spans.push({ start: start, end: end });
    }
    return spans;
  }

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

