  var CrossPaint = (function crossPaintModule() {
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

  return {
    paintCrossSelection: paintCrossSelection,
    crossHitNodeOk: crossHitNodeOk,
    extendCrossSelection: extendCrossSelection
  };
  })();

  var paintCrossSelection = CrossPaint.paintCrossSelection;
  var crossHitNodeOk = CrossPaint.crossHitNodeOk;
  var extendCrossSelection = CrossPaint.extendCrossSelection;
