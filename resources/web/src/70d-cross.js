  var Cross = (function crossModule() {
  var crossSel = null;        // { anchor, focus, goalX }，整篇绝对字符偏移
  var crossLayer = null;      // 覆盖层（position:absolute，挂在 body）
  var crossAnnounced = false; // 与外壳同步的「是否有跨块选区」状态
  var dragCross = null;       // { anchor, el, x, y, goalX }
  var dragScrollTimer = 0;
  var CrossRange = (function crossRangeModule() {
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
    Util.post({ type: 'crossSelection', active: active });
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
    var base = DocumentModel.blockStartOffset(blocks, gaps, index);
    return { base: base, stop: base + blocks[index].length };
  }

  // 区间里是否真的有块正文：块间空白处投点得到的「只跨过空行」区间画不出任何
  // 高亮，扩展时要跳过这种落点，继续往下一可视行找。
  function crossRangeCoversText(from, to) {
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
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
    var list = BlockParse.blockList();
    var index = list.indexOf(el);
    if (index < 0)
      return null;
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    return DocumentModel.blockStartOffset(blocks, gaps, index) + rawOffsetAtPoint(el, node, offset);
  }

  // 块内某个 DOM 点 → 块内 raw 偏移（代码块补上围栏前缀）
  function rawOffsetAtPoint(el, node, offset) {
    var scope = Navigation.navScope(el) || el;
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(node, offset);
    } catch (error) {
      return 0;
    }
    return prefix.toString().length + (LayoutCode.isCodeBlock(el) ? LayoutCode.codePrefixLength(el) : 0);
  }

  // 块内 raw 区间 → Range。分隔线没有可量测的文字，原型里不画它的高亮。
  function crossBlockRange(el, start, end) {
    if (!el || el.classList.contains('hr'))
      return null;
    var scope = Navigation.navScope(el);
    if (!scope)
      return null;
    var prefix = LayoutCode.isCodeBlock(el) ? LayoutCode.codePrefixLength(el) : 0;
    var limit = scope.textContent.length;
    var from = Math.max(0, Math.min(start - prefix, limit));
    var to = Math.max(0, Math.min(end - prefix, limit));
    if (to <= from)
      return null;
    var a = CaretOffset.locateOffset(scope, from);
    var b = CaretOffset.locateOffset(scope, to);
    var range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (error) {
      return null;
    }
    return range;
  }

  return {
    dropCrossLayer: dropCrossLayer,
    ensureCrossLayer: ensureCrossLayer,
    announceCross: announceCross,
    clearCrossSelection: clearCrossSelection,
    blockAbsoluteSpan: blockAbsoluteSpan,
    crossRangeCoversText: crossRangeCoversText,
    absoluteOf: absoluteOf,
    rawOffsetAtPoint: rawOffsetAtPoint,
    crossBlockRange: crossBlockRange
  };
  })();

  var CrossPaint = (function crossPaintModule() {
  // 逐块切开绝对区间取客户矩形，画成覆盖层色块（不插入任何正文节点）
  function paintCrossSelection() {
    if (!crossSel) {
      CrossRange.dropCrossLayer();
      return;
    }
    var from = Math.min(crossSel.anchor, crossSel.focus);
    var to = Math.max(crossSel.anchor, crossSel.focus);
    if (from === to) {
      CrossRange.dropCrossLayer();
      return;
    }
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var list = BlockParse.blockList();
    var layer = CrossRange.ensureCrossLayer();
    while (layer.firstChild)
      layer.removeChild(layer.firstChild);
    var base = 0;
    for (var i = 0; i < blocks.length && base < to; i++) {
      var span = CrossRange.blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      var lo = Math.max(from, span.base);
      var hi = Math.min(to, span.stop);
      if (hi > lo) {
        var range = CrossRange.crossBlockRange(list[i], lo - span.base, hi - span.base);
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
    if (!node || !Navigation.pointInNavScope(el, node))
      return false;
    var host = node.nodeType === 1 ? node : node.parentNode;
    if (host && host.closest && host.closest('.gutter, .code-lang, .code-tools'))
      return false;
    return true;
  }

  function blockAtAbsolute(abs) {
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var at = EditingSnapshot.locateBlock(blocks, gaps, abs);
    return { el: BlockParse.blockList()[at.index] || null, index: at.index, start: at.start };
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
    var caret = Navigation.caretRectOfSelection();
    var line = caret || Navigation.contentEdgeRect(el, up);
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
        var target = CaretCode.blockOf(node);
        if (!target || !crossHitNodeOk(target, node))
          continue;
        var abs = CrossRange.absoluteOf(target, node, probe.startOffset);
        // 只认「按方向真正前进」的落点：块内边距里投点会得到更靠后的坐标，
        // 反向落点会让选区原地打转
        if (abs === null || (up ? abs >= crossSel.focus : abs <= crossSel.focus))
          continue;
        // 同一可视行内的投点只是横向漂移（行尾/行首），不算换行
        var charRect = pointCharRect(node, probe.startOffset, !up);
        if (charRect && (up ? charRect.bottom > line.top + 1 : charRect.top < line.bottom - 1))
          continue;
        // 块间空白处的投点只会得到「跨过空行」的区间，画不出高亮：继续往下找
        if (!CrossRange.crossRangeCoversText(crossSel.focus, abs))
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
      Navigation.placeCaretInBlock(next, up, x);
      var selection = window.getSelection();
      if (!selection.rangeCount)
        return false;
      var settled = selection.getRangeAt(0);
      var settledAbs = CrossRange.absoluteOf(next, settled.startContainer, settled.startOffset);
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
      var caret = Navigation.caretRectOfSelection();
      if (!Navigation.caretAtBlockEdge(el, up, caret))
        return false;
      var index = BlockParse.blockList().indexOf(el);
      if (index < 0)
        return false;
      var blocks = DocumentModel.collectBlocks();
      var gaps = DocumentModel.collectGaps();
      var base = DocumentModel.blockStartOffset(blocks, gaps, index);
      var anchorAbs, focusAbs;
      if (range.collapsed) {
        anchorAbs = focusAbs = base + CrossRange.rawOffsetAtPoint(el, range.startContainer, range.startOffset);
      } else {
        // 原生单块选区升格：锚点取 anchor 端，焦点取 focus 端；随后把原生选区
        // 收成焦点处的折叠光标，高亮整段交给覆盖层
        anchorAbs = base + CrossRange.rawOffsetAtPoint(el, selection.anchorNode, selection.anchorOffset);
        focusAbs = base + CrossRange.rawOffsetAtPoint(el, selection.focusNode, selection.focusOffset);
        var collapsed = document.createRange();
        try {
          collapsed.setStart(selection.focusNode, selection.focusOffset);
          collapsed.collapse(true);
          selection.removeAllRanges();
          selection.addRange(collapsed);
        } catch (error) { /* ignore */ }
        caret = Navigation.caretRectOfSelection();
      }
      crossSel = {
        anchor: anchorAbs,
        focus: focusAbs,
        goalX: caret ? caret.left : null
      };
    }
    moveCrossFocus(up);
    if (crossSel.anchor === crossSel.focus)
      CrossRange.clearCrossSelection();
    else
      paintCrossSelection();
    CrossRange.announceCross();
    return true;
  }

  return {
    paintCrossSelection: paintCrossSelection,
    crossHitNodeOk: crossHitNodeOk,
    extendCrossSelection: extendCrossSelection
  };
  })();

  var CrossStep = (function crossStepModule() {
  // 可编辑长度：代码块的围栏前缀与收尾围栏都不可编辑，只算正文
  function crossEditableLength(el, raw) {
    if (!el || !LayoutCode.isCodeBlock(el))
      return raw.length;
    var code = LayoutCode.codeEl(el);
    return LayoutCode.codePrefixLength(el) + (code ? code.textContent.length : 0);
  }

  // 整篇绝对偏移按字符左右步进。块内逐字走；越过块间空行时直接落到相邻块的
  // 端点上——空行本身画不出高亮，停在空行里等同于原地不动。代码块两端还要
  // 跳过不可编辑的围栏，否则光标会在围栏里空走好几下。
  function crossStepTarget(abs, dir) {
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var list = BlockParse.blockList();
    var base = 0;
    for (var i = 0; i < blocks.length; i++) {
      var gap = DocumentModel.gapBefore(gaps, i);
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
        var tableTarget = TableCross.crossStepInTable(list[i], abs, dir);
        if (tableTarget !== null)
          return tableTarget;
        return dir < 0 ? crossPrevEnd(blocks, gaps, list, i)
          : (i + 1 < blocks.length ? stop + DocumentModel.gapBefore(gaps, i + 1) : null);
      }
      if (dir < 0) {
        // 围栏前缀不可编辑：停在正文行首时直接跨到上一块末尾
        if (LayoutCode.isCodeBlock(list[i]) && abs <= base + LayoutCode.codePrefixLength(list[i]))
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
      var nextGap = DocumentModel.gapBefore(gaps, i + 1);
      return nextGap > 0 ? stop + nextGap : abs + 1;
    }
    return null;
  }

  // 第 index 块之前那一块的可编辑末尾
  function crossPrevEnd(blocks, gaps, list, index) {
    var prev = index - 1;
    if (prev < 0)
      return null;
    var start = DocumentModel.blockStartOffset(blocks, gaps, prev);
    return start + crossEditableLength(list[prev], blocks[prev]);
  }

  // 表格块的可编辑核心：首格可见起点 / 末格可见终点（块内 raw 偏移）。块首的
  // | 标记与隐藏的对齐行都不可编辑，光标不能停在它们里面
  function tableCoreOffsets(el) {
    var cells = RenderBlocks.tableCellList(el);
    var first = null;
    var last = null;
    for (var i = 0; i < cells.length; i++) {
      var nodes = MarkerCaret.editableTextNodes(cells[i]);
      if (!nodes.length)
        continue;
      if (!first)
        first = nodes[0];
      last = nodes[nodes.length - 1];
    }
    if (!first)
      return null;
    return {
      start: CrossRange.rawOffsetAtPoint(el, first, 0),
      end: CrossRange.rawOffsetAtPoint(el, last, last.nodeValue.length)
    };
  }

  // 表格块里每格可见文本在整篇里的连续区间（空格子不参与）
  function tableVisibleSpans(el) {
    var cells = RenderBlocks.tableCellList(el);
    var spans = [];
    for (var i = 0; i < cells.length; i++) {
      var nodes = MarkerCaret.editableTextNodes(cells[i]);
      if (!nodes.length)
        continue;
      var total = 0;
      for (var n = 0; n < nodes.length; n++)
        total += nodes[n].nodeValue.length;
      if (!total)
        continue;
      var start = CrossRange.absoluteOf(el, nodes[0], 0);
      var end = CrossRange.absoluteOf(el, nodes[nodes.length - 1], nodes[nodes.length - 1].nodeValue.length);
      if (start === null || end === null)
        continue;
      spans.push({ start: start, end: end });
    }
    return spans;
  }

  return {
    crossEditableLength: crossEditableLength,
    crossStepTarget: crossStepTarget,
    tableCoreOffsets: tableCoreOffsets,
    tableVisibleSpans: tableVisibleSpans
  };
  })();

  var TableCross = (function tableCrossModule() {
  // 表格块内的横向步进：格内逐字；跨格落到相邻格的首/末可见字符，绝不落进
  // | 标记或对齐行。返回 null 表示这个方向已经到表格两端，该跨出整块
  function crossStepInTable(el, abs, dir) {
    var spans = CrossStep.tableVisibleSpans(el);
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
    var cells = RenderBlocks.tableCellList(el);
    for (var i = 0; i < cells.length; i++) {
      var nodes = MarkerCaret.editableTextNodes(cells[i]);
      for (var n = 0; n < nodes.length; n++) {
        var start = CrossRange.rawOffsetAtPoint(el, nodes[n], 0);
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
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var list = BlockParse.blockList();
    var at = EditingSnapshot.locateBlock(blocks, gaps, abs);
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
          var placed = CrossRange.absoluteOf(el, caret.node, caret.offset);
          if (placed !== null)
            return placed;
        } catch (error) { /* 退回块内统一落点 */ }
      }
    }
    CaretEdit.placeBlockCaret(el, offset);
    var live = window.getSelection();
    if (!live.rangeCount)
      return null;
    var settled = live.getRangeAt(0);
    var result = CrossRange.absoluteOf(el, settled.startContainer, settled.startOffset);
    return result === null ? DocumentModel.blockStartOffset(blocks, gaps, at.index) + offset : result;
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
      var blocks = DocumentModel.collectBlocks();
      var gaps = DocumentModel.collectGaps();
      var list = BlockParse.blockList();
      // 看移动端（焦点）是否已经顶到块首/块尾；原生单块选区在这里一并升格
      var focusEl = CaretCode.blockOf(selection.focusNode) || el;
      var index = list.indexOf(focusEl);
      if (index < 0)
        return false;
      var off = CrossRange.rawOffsetAtPoint(focusEl, selection.focusNode, selection.focusOffset);
      // 代码块的可视行首/行尾在围栏之内、表格的首/末可见字符在 | 标记之后，
      // 这几个位置同样算作块首/块尾
      var visibleStart = 0;
      var visibleEnd = blocks[index].length;
      if (LayoutCode.isCodeBlock(focusEl)) {
        visibleStart = LayoutCode.codePrefixLength(focusEl);
        visibleEnd = CrossStep.crossEditableLength(focusEl, blocks[index]);
      } else if (focusEl.classList.contains('table')) {
        var core = CrossStep.tableCoreOffsets(focusEl);
        if (core) {
          visibleStart = core.start;
          visibleEnd = core.end;
        }
      }
      if (left ? off > visibleStart : off < visibleEnd)
        return false;
      focusAbs = DocumentModel.blockStartOffset(blocks, gaps, index) + off;
      if (range.collapsed) {
        anchorAbs = focusAbs;
      } else {
        var anchorEl = CaretCode.blockOf(selection.anchorNode);
        var anchorIndex = anchorEl ? list.indexOf(anchorEl) : -1;
        if (anchorIndex < 0)
          return false;
        anchorAbs = DocumentModel.blockStartOffset(blocks, gaps, anchorIndex)
          + CrossRange.rawOffsetAtPoint(anchorEl, selection.anchorNode, selection.anchorOffset);
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
    var to = CrossStep.crossStepTarget(from, left ? -1 : 1);
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
      CrossRange.clearCrossSelection();
    else
      CrossPaint.paintCrossSelection();
    CrossRange.announceCross();
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
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var list = BlockParse.blockList();
    var parts = [];
    var base = 0;
    for (var i = 0; i < blocks.length && base < bounds.to; i++) {
      var span = CrossRange.blockAbsoluteSpan(blocks, gaps, i);
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
      var range = CrossRange.crossBlockRange(list[i], lo - span.base, hi - span.base);
      parts.push(range ? ClipboardPaste.cleanCopyFragment(range.cloneContents()) : '');
      base = span.stop;
    }
    return parts.join('\n');
  }

  // 表格单元格可见文本的整篇绝对区间；空格子没有可量测的文字，返回 null
  function tableCellAbsSpan(el, cell) {
    var nodes = MarkerCaret.editableTextNodes(cell);
    if (!nodes.length)
      return null;
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    var start = CrossRange.absoluteOf(el, first, 0);
    var end = CrossRange.absoluteOf(el, last, last.nodeValue.length);
    if (start === null || end === null)
      return null;
    return { start: start, end: end };
  }

  // 单元格里截取 [from, to)（单元格内可见文本口径）的克隆片段
  function cellClipContents(cell, from, to) {
    var nodes = MarkerCaret.editableTextNodes(cell);
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

  return {
    crossStepInTable: crossStepInTable,
    extendCrossSelectionHorizontal: extendCrossSelectionHorizontal,
    crossBounds: crossBounds,
    crossSelectionPlainText: crossSelectionPlainText,
    tableCellAbsSpan: tableCellAbsSpan,
    cellClipContents: cellClipContents
  };
  })();

  var CrossHtmlReplace = (function crossHtmlReplaceModule() {
  // 表格块在跨块选区里的 HTML：整表克隆后按区间裁行裁格，保留 <table> 结构。
  // 对齐行是编辑器内部的隐藏标记（原文里才有意义），HTML 里去掉。
  function crossTableHtml(el, from, to) {
    var source = el.querySelector('table');
    if (!source)
      return null;
    var clone = source.cloneNode(true);
    var rows = source.querySelectorAll('tr');
    var copies = clone.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var copy = copies[r];
      if (!copy)
        continue;
      if (row.classList.contains('tbl-align')) {
        copy.parentNode.removeChild(copy);
        continue;
      }
      var cells = row.children;
      var cellCopies = copy.children;
      var kept = false;
      for (var c = 0; c < cells.length; c++) {
        var copyCell = cellCopies[c];
        if (!copyCell)
          continue;
        var span = TableCross.tableCellAbsSpan(el, cells[c]);
        if (!span)
          continue;
        var lo = Math.max(from, span.start);
        var hi = Math.min(to, span.end);
        if (hi <= lo) {
          copyCell.parentNode.removeChild(copyCell);
          continue;
        }
        kept = true;
        if (lo > span.start || hi < span.end) {
          var clipped = TableCross.cellClipContents(cells[c], lo - span.start, hi - span.start);
          while (copyCell.firstChild)
            copyCell.removeChild(copyCell.firstChild);
          if (clipped)
            copyCell.appendChild(clipped);
        }
      }
      if (!kept)
        copy.parentNode.removeChild(copy);
    }
    return clone;
  }

  // 跨块选区的 HTML：与纯文本同一区间口径，逐块裁剪，保留标题/列表/代码块
  // 的语义；表格按行列裁剪后仍是 <table>。已选区间之外的"未选中"内容不进来。
  function crossSelectionHtml() {
    var bounds = TableCross.crossBounds();
    if (!bounds || bounds.from === bounds.to)
      return '';
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var list = BlockParse.blockList();
    var holder = document.createElement('div');
    var base = 0;
    for (var i = 0; i < blocks.length && base < bounds.to; i++) {
      var span = CrossRange.blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      var lo = Math.max(bounds.from, span.base);
      var hi = Math.min(bounds.to, span.stop);
      if (hi <= lo || !list[i] || list[i].classList.contains('hr')) {
        base = span.stop;
        continue;
      }
      var el = list[i];
      if (el.classList.contains('table')) {
        var table = crossTableHtml(el, lo, hi);
        if (table)
          holder.appendChild(table);
        base = span.stop;
        continue;
      }
      var sub = CrossRange.crossBlockRange(el, lo - span.base, hi - span.base);
      if (!sub) {
        base = span.stop;
        continue;
      }
      var fragment = sub.cloneContents();
      var inner = CopySelection.blockSemantic(el);
      var only = fragment.childNodes.length === 1 ? fragment.firstChild : null;
      var shell;
      // 整块选中时片段已带出内层语义标签，不能再套一层（与 selectionHtml 同口径）
      if (inner && only && only.nodeType === 1 && only.nodeName === inner.nodeName) {
        shell = only;
      } else {
        shell = document.createElement(inner ? inner.tagName.toLowerCase() : 'p');
        shell.appendChild(fragment);
      }
      CopySelection.applyCopyStyle(inner || el, shell);
      CopySelection.inlineCodeTokenColors(el, sub, shell);
      holder.appendChild(shell);
      base = span.stop;
    }
    CopySelection.sanitizeCopyHtml(holder);
    return holder.innerHTML;
  }

  // 用 insert 替换跨块选区：整篇源码拼接后一次重建（一步撤销），光标落到替换末尾
  function replaceCrossSelection(insert) {
    var bounds = TableCross.crossBounds();
    if (!bounds)
      return false;
    var text = DocumentModel.currentSource();
    var from = Math.max(0, Math.min(bounds.from, text.length));
    var to = Math.max(0, Math.min(bounds.to, text.length));
    var next = text.slice(0, from) + insert + text.slice(to);
    crossSel = null;
    CrossRange.dropCrossLayer();
    CrossRange.announceCross();
    // 改动前的整篇状态先入栈：撤销要回到「选区还在」的那一步
    EditingSnapshot.commitHistory();
    var landed = Find.rebuildFromSourceText(next, from + insert.length);
    if (landed && landed.block) {
      landed.block.classList.add('editing');
      landed.block.focus();
      CaretEdit.placeBlockCaret(landed.block, landed.offset);
    }
    return true;
  }

  /* ---------------- 鼠标拖选跨块（原型） ----------------
     原生拖选同样出不了块：指针移出锚点块后交给自建选区。锚点在按下时按投点
     记住，之后每次移动只更新 focus；原生选区收成焦点处的折叠光标，高亮由
     覆盖层画。松手后选区保留，可直接删除/输入/复制，与 Shift+方向键同一套
     状态与清除时机。 */

  var DRAG_EDGE = 24;         // 距视口上下边缘多近开始自动滚动
  var DRAG_STEP = 18;
  return {
    crossSelectionHtml: crossSelectionHtml,
    replaceCrossSelection: replaceCrossSelection,
    DRAG_EDGE: DRAG_EDGE,
    DRAG_STEP: DRAG_STEP
  };
  })();

  var DragScroll = (function dragScrollModule() {
  function stopDragScroll() {
    if (dragScrollTimer) {
      clearInterval(dragScrollTimer);
      dragScrollTimer = 0;
    }
  }

  // 指针处的落点；行号栏/语言徽标/工具条不算正文
  function crossHitAt(x, y) {
    if (!document.caretRangeFromPoint)
      return null;
    var range = document.caretRangeFromPoint(x, y);
    if (!range)
      return null;
    var el = CaretCode.blockOf(range.startContainer);
    if (!el || !CrossPaint.crossHitNodeOk(el, range.startContainer))
      return null;
    var abs = CrossRange.absoluteOf(el, range.startContainer, range.startOffset);
    if (abs === null)
      return null;
    return { el: el, range: range, abs: abs };
  }

  // 原生选区收成焦点处的折叠光标：焦点块先 focus（触发 enterEdit），再落点
  function collapseAtCrossHit(hit) {
    if (document.activeElement !== hit.el)
      hit.el.focus();
    var selection = window.getSelection();
    if (!selection)
      return;
    selection.removeAllRanges();
    selection.addRange(hit.range);
  }

  function dragScrollTick() {
    if (!dragCross) {
      stopDragScroll();
      return;
    }
    var y = dragCross.y;
    var step = y < CrossHtmlReplace.DRAG_EDGE ? -CrossHtmlReplace.DRAG_STEP
      : (y > window.innerHeight - CrossHtmlReplace.DRAG_EDGE ? CrossHtmlReplace.DRAG_STEP : 0);
    if (!step) {
      stopDragScroll();
      return;
    }
    var before = window.scrollY;
    window.scrollBy(0, step);
    if (window.scrollY === before) {
      stopDragScroll();
      return;
    }
    updateCrossDrag(dragCross.x, y);
  }

  function updateCrossDrag(x, y) {
    if (!dragCross)
      return;
    dragCross.x = x;
    dragCross.y = y;
    // 拖到视口上下边缘时自己滚：原生拖选的自动滚动已经被折叠光标打断
    if (y < CrossHtmlReplace.DRAG_EDGE || y > window.innerHeight - CrossHtmlReplace.DRAG_EDGE) {
      if (!dragScrollTimer)
        dragScrollTimer = setInterval(dragScrollTick, 60);
    } else {
      stopDragScroll();
    }
    var hit = crossHitAt(x, Math.max(0, Math.min(y, window.innerHeight - 1)));
    if (!hit)
      return;
    if (!crossSel) {
      // 还在锚点块内：交回原生拖选，越出锚点块才升格
      if (hit.el === dragCross.el)
        return;
      crossSel = { anchor: dragCross.anchor, focus: hit.abs, goalX: dragCross.goalX };
      CrossRange.announceCross();
    } else if (hit.abs === crossSel.anchor) {
      CrossRange.clearCrossSelection();
      return;
    }
    crossSel.focus = hit.abs;
    collapseAtCrossHit(hit);
    CrossPaint.paintCrossSelection();
  }

  return {
    stopDragScroll: stopDragScroll,
    crossHitAt: crossHitAt,
    updateCrossDrag: updateCrossDrag
  };
  })();

  (function dragSelectModule() {
  // 在冒泡阶段记录锚点：块内的特殊按下（徽标、行号栏、表格格线）已经
  // preventDefault，不能再起拖选
  document.addEventListener('mousedown', function (event) {
    dragCross = null;
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey
        || mode !== 'wysiwyg')
      return;
    var el = CaretCode.blockOf(event.target);
    if (!el)
      return;
    var hit = DragScroll.crossHitAt(event.clientX, event.clientY);
    if (!hit || hit.el !== el)
      return;
    dragCross = {
      anchor: hit.abs,
      el: el,
      x: event.clientX,
      y: event.clientY,
      goalX: event.clientX
    };
  });

  document.addEventListener('mousemove', function (event) {
    if (!dragCross || event.buttons !== 1)
      return;
    DragScroll.updateCrossDrag(event.clientX, event.clientY);
  });

  document.addEventListener('mouseup', function () {
    if (!dragCross)
      return;
    dragCross = null;
    DragScroll.stopDragScroll();
  });

  root.addEventListener('keydown', function (event) {
    var el = CaretCode.blockOf(event.target);
    if (!el)
      return;

    // 组合输入（中文等）期间按键属于输入法：方向键选候选、回车/Esc 上屏或取消，
    // 一个都不能被下面的浮层或块级逻辑吃掉。判断必须放在最前面。
    if (composing)
      return;

    // 斜杠浮层打开时先吃掉导航键：上下选择、Enter/Tab 插入、Esc 删除已输入的 /
    if (Menus.isSlashOpen()) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        Menus.moveSlash(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        Menus.insertSlashItem();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        Menus.cancelSlash();
        return;
      }
    }

    // 跨块选区（原型）：编辑键先在整篇源码上生效，避免落到折叠光标上只改一个字符
    var plainKeys = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (crossSel) {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        CrossHtmlReplace.replaceCrossSelection('');
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        CrossHtmlReplace.replaceCrossSelection('\n');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        CrossRange.clearCrossSelection();
        return;
      }
    }

    // Shift+↑/↓ 扩展选区：块首/块尾升级为跨块选区，之后由覆盖层显示
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && event.shiftKey && plainKeys
        && CrossPaint.extendCrossSelection(el, event.key === 'ArrowUp')) {
      event.preventDefault();
      return;
    }

    // Shift+←/→ 跨块：块首/块尾或已有跨块选区时逐字扩展，其余交回原生
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        && event.shiftKey && plainKeys
        && TableCross.extendCrossSelectionHorizontal(el, event.key === 'ArrowLeft')) {
      event.preventDefault();
      return;
    }

    // 横向/翻页/制表键会让原生选区离开覆盖层范围：先收起，交回原生。
    // 普通字符键不能在这里清除：输入要经过 beforeinput 才能按整篇源码替换选区。
    if (crossSel && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                     || event.key === 'Home' || event.key === 'End'
                     || event.key === 'PageUp' || event.key === 'PageDown'
                     || event.key === 'Tab'
                     || ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey)))
      CrossRange.clearCrossSelection();

    // 上下方向键跨块：只在块首/块尾接管，块内与表格/代码块内部导航保持原生。
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      var navSelection = window.getSelection();
      if (navSelection && navSelection.rangeCount
          && navSelection.getRangeAt(0).collapsed
          && el.contains(navSelection.getRangeAt(0).startContainer)
          && Navigation.moveCaretAcrossBlock(el, event.key === 'ArrowUp')) {
        event.preventDefault();
        return;
      }
    }

    // 原生跨块选区上的退格/删除先接管（全选删除不能是死键）
    if ((event.key === 'Backspace' || event.key === 'Delete')
        && !event.metaKey && !event.ctrlKey && JoinIndent.deleteNativeCrossSelection()) {
      event.preventDefault();
      return;
    }

    var inTable = el.classList.contains('table');

    if (inTable && event.key === 'Tab') {
      event.preventDefault();
      RenderBlocks.moveTableCell(el, event.shiftKey ? -1 : 1);
      return;
    }

    if (inTable && event.key === 'Enter') {
      // Cmd/Ctrl+Enter 在当前行下方加一行、加 Shift 在上方加一行（光标落新行
      // 同列首格）；裸回车既不新增行也不插入换行，避免一次误触改掉表格结构。
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && !event.altKey)
        RenderBlocks.insertTableRow(el, !event.shiftKey);
      return;
    }

    if (inTable && (event.key === 'Backspace' || event.key === 'Delete')) {
      var tableSel = window.getSelection();
      if (tableSel.rangeCount && !tableSel.getRangeAt(0).collapsed
          && CellEdit.rangeCrossesCells(el, tableSel.getRangeAt(0))) {
        event.preventDefault();
        CellEdit.clearSelectedCellText(el, tableSel.getRangeAt(0));
        return;
      }
      if (CellEdit.atCellEdge(el, event.key === 'Backspace', event))
        return;
    }

    if (INLINE_PROTO && (event.key === 'Backspace' || event.key === 'Delete')) {
      var backward = event.key === 'Backspace';
      var neighbour = MarkerCaret.markerAdjacent(el, backward ? -1 : 1);
      if (neighbour) {
        event.preventDefault();
        // 块内行首退格：换行标记右侧退格 = 并入上一行，不能只是跨过标记
        if (backward && neighbour.classList.contains('mk-nl')) {
          JoinIndent.joinPrevLine(el);
          return;
        }
        // 标记不可见：直接删掉它另一侧同一行内的可见字符，而不是把光标停在
        // 标记边上（那样看起来像没反应）。跨行/跨列表项时退回“跨过标记”。
        var caret = window.getSelection().getRangeAt(0);
        var prefix = neighbour.classList.contains('mk-head')
          || neighbour.classList.contains('mk-bullet')
          || neighbour.classList.contains('mk-quote');
        if (!prefix && MarkerCaret.deleteVisibleChar(el, caret, backward, neighbour))
          return;
        MarkerCaret.collapseAt(neighbour, backward);
        return;
      }
      // 标记在光标前方挡住原生删除时，自己删掉光标另一侧的可见字符。
      // 删不动也必须 preventDefault：原生删除会紧贴着 contenteditable=false
      // 的原子对象执行，可能把它或相邻结构一起带走。
      var blocking = MarkerCaret.markerAdjacent(el, backward ? 1 : -1);
      if (blocking) {
        event.preventDefault();
        var range = window.getSelection().getRangeAt(0);
        // 光标在块最前、挡住删除的是结构前缀标记（标题 # / 列表项符 / 引用 >）：
        // 块首没有可见字符可删，退格不能成死键。上一块同类型就合并，
        // 否则剥掉前缀还原成正文（再按一次退格即可与上一段相接）。
        if (backward && CaretOffset.caretOffset(el) === 0 &&
            (blocking.classList.contains('mk-head') || blocking.classList.contains('mk-bullet') ||
             blocking.classList.contains('mk-quote'))) {
          var prevBlock = el.previousElementSibling;
          if (prevBlock && prevBlock.classList.contains('block') && JoinIndent.blockType(prevBlock) === JoinIndent.blockType(el))
            JoinIndent.mergeBack(el);
          else {
            var blockRaw = BlockParse.rawOf(el);
            EditingSnapshot.commitHistory();
            BlockParse.applyRawToBlock(el, BlockParse.contentOfRaw(blockRaw, BlockParse.kindOfRaw(blockRaw)), 0, 0, true);
            setTimeout(EditingSnapshot.commitHistory, 0);
          }
          return;
        }
        MarkerCaret.deleteVisibleChar(el, range, backward, blocking);
        return;
      }
    }

    if (INLINE_PROTO && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // 正常方向键会跳过零宽原子；只有程序化选区落进标记内部时才需要纠正。
      var inside = MarkerCaret.caretInsideMarker();
      if (inside) {
        event.preventDefault();
        MarkerCaret.collapseAt(inside, event.key === 'ArrowLeft');
        return;
      }
      // 块首（或行首）紧贴不可编辑原子对象时，WebKit 的左/右箭头会原地不动，
      // 光标看起来“卡”在折叠标记边上。这里显式跨过紧贴光标的标记。
      var adjacent = MarkerCaret.markerAdjacent(el, event.key === 'ArrowLeft' ? -1 : 1);
      if (adjacent) {
        event.preventDefault();
        MarkerCaret.collapseAt(adjacent, event.key === 'ArrowLeft');
        return;
      }
    }

    if (event.key === 'Enter') {
      if (LayoutCode.isCodeBlock(el)) {
        // 代码块里的回车只加一行，不切块；Shift+Enter 同样按换行处理
        event.preventDefault();
        if (CaretCode.insertCodeText(el, '\n')) {
          DocumentModel.scheduleDirty();
          EditingSnapshot.scheduleCommit();
        }
        return;
      }
      if (el.classList.contains('hr')) {
        // 分割线没有可拆的文本：直接走 splitBlock 会把 --- 变成两个空段，
        // 分割线凭空消失。回车应在其后插入一个空正文块，分割线留在原地。
        event.preventDefault();
        EditingSnapshot.commitHistory();
        BlockConvert.insertBlockAfter(el, '', 0);
        EditingSnapshot.commitHistory();
        DocumentModel.scheduleDirty();
        return;
      }
      if (!event.shiftKey) {
        event.preventDefault();
        SplitBlock.splitBlock(el);
        return;
      }
    }

    // 表格单元格外没有“块首”这个概念：光标停在首格行首时不能把整张表并进
    // 上一段（caretOffset(el) 会恰好等于 0）。
    if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !inTable
        && CaretOffset.caretOffset(el) === 0) {
      var prevSib = el.previousElementSibling;
      if (prevSib && prevSib.classList.contains('block')) {
        event.preventDefault();
        JoinIndent.mergeBack(el);
        return;
      }
      // 首块是结构块（无上一块可并）：块首退格剥前缀还原正文，避免死键
      if (!prevSib) {
        var kind1 = JoinIndent.blockType(el);
        if (kind1 === 'ul' || kind1 === 'ol' || kind1 === 'quote'
            || kind1 === 'code' || kind1.charAt(0) === 'h') {
          event.preventDefault();
          EditingSnapshot.commitHistory();
          BlockParse.applyRawToBlock(el, BlockParse.contentOfRaw(BlockParse.rawOf(el), kind1), 0, 0, true);
          setTimeout(EditingSnapshot.commitHistory, 0);
          return;
        }
      }
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey)
        JoinIndent.outdentCurrentLine(el);
      else
        JoinIndent.indentCurrentLine(el);
    }
  }, true);
  })();

  function isActive() {
    return !!crossSel;
  }

  return {
    clearCrossSelection: CrossRange.clearCrossSelection,
    absoluteOf: CrossRange.absoluteOf,
    paintCrossSelection: CrossPaint.paintCrossSelection,
    crossSelectionPlainText: TableCross.crossSelectionPlainText,
    crossSelectionHtml: CrossHtmlReplace.crossSelectionHtml,
    replaceCrossSelection: CrossHtmlReplace.replaceCrossSelection,
    crossBounds: TableCross.crossBounds,
    isActive: isActive
  };
  })();
