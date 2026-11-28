  var Navigation = (function navigationModule() {
  // 导航作用域：代码块只看 <code>（行号栏不参与），普通块就是块本身。
  function navScope(el) {
    return LayoutCode.isCodeBlock(el) ? LayoutCode.codeEl(el) : el;
  }

  // 取 scope 内首/末一个「可见字符」的矩形。折叠 Range 在 WebKit 里常是 0×0，
  // 所以量真实字符；零宽标记、行号栏、语言徽标与隐藏的对齐行都要跳过。
  function textCharRect(scope, atEnd) {
    if (!scope)
      return null;
    var nodes = [];
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var host = node.parentNode;
      if (host && host.closest && host.closest('.mk, .gutter, .code-lang, .tbl-align'))
        continue;
      if (node.nodeValue)
        nodes.push(node);
    }
    if (!nodes.length)
      return null;
    node = nodes[atEnd ? nodes.length - 1 : 0];
    var len = node.nodeValue.length;
    var range = document.createRange();
    if (atEnd) {
      range.setStart(node, len - 1);
      range.setEnd(node, len);
    } else {
      range.setStart(node, 0);
      range.setEnd(node, Math.min(1, len));
    }
    var rect = range.getBoundingClientRect();
    if (rect && (rect.height > 0.5 || rect.width > 0.5))
      return rect;
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].height > 0.5 || rects[i].width > 0.5)
        return rects[i];
    }
    return null;
  }

  // 块内首行（atEnd=false）/末行（atEnd=true）的文字矩形。用块内首/末字符取，
  // 比 getBoundingClientRect 更贴近文字本身，不受块上下 padding 影响。
  function contentEdgeRect(el, atEnd) {
    if (el.classList.contains('hr'))
      return textCharRect(el.querySelector('.hr-src'), atEnd);
    if (el.classList.contains('table')) {
      var cells = RenderBlocks.tableCellList(el);
      if (!cells.length)
        return null;
      for (var i = 0; i < cells.length; i++) {
        var rect = textCharRect(cells[atEnd ? cells.length - 1 - i : i], atEnd);
        if (rect)
          return rect;
      }
      return null;
    }
    return textCharRect(navScope(el), atEnd);
  }

  // 当前折叠光标的文字矩形；取不到时返回 null，由调用方退化为字符偏移判断。
  // WebKit 对折叠 Range 常返回 0×0：改为量光标旁边那个字符的矩形，上下边与
  // 所在行一致，横向位置按光标在该字符左/右取 left/right。
  function caretRectOfSelection() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (!range.collapsed) {
      var whole = range.getBoundingClientRect();
      return whole && (whole.height > 0.5 || whole.width > 0.5) ? whole : null;
    }
    var node = range.startContainer;
    var offset = range.startOffset;
    try {
      if (node.nodeType === 3 && node.nodeValue.length) {
        var from = Math.min(offset, node.nodeValue.length - 1);
        var probe = document.createRange();
        probe.setStart(node, from);
        probe.setEnd(node, from + 1);
        var rect = probe.getBoundingClientRect();
        if (rect && (rect.height > 0.5 || rect.width > 0.5)) {
          return {
            left: offset < node.nodeValue.length ? rect.left : rect.right,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height
          };
        }
      } else if (node.nodeType === 1 && node.childNodes.length) {
        // 元素容器（空块等）：用光标后一个子节点，没有就取前一个
        var anchor = node.childNodes[Math.min(offset, node.childNodes.length - 1)]
          || node.childNodes[Math.max(0, offset - 1)];
        if (anchor && anchor.nodeType === 1) {
          var box = anchor.getBoundingClientRect();
          if (box && (box.height > 0.5 || box.width > 0.5))
            return box;
        }
      }
    } catch (error) { /* ignore */ }
    return null;
  }

  // 光标是否在本块首行（up）/末行（down）。
  function caretAtBlockEdge(el, up, caret) {
    var line = contentEdgeRect(el, !up);
    if (caret && line) {
      var height = line.height || 20;
      return up
        ? caret.top <= line.top + height * 0.5
        : caret.bottom >= line.bottom - height * 0.5;
    }
    var scope = navScope(el) || el;
    return up ? CaretOffset.caretOffset(el) === 0 : CaretOffset.caretOffset(el) >= scope.textContent.length;
  }

  // 投点是否落在目标块可编辑范围内（表格必须落进单元格，代码块必须落进 <code>）。
  function pointInNavScope(el, node) {
    if (!node)
      return false;
    if (el.classList.contains('table')) {
      var parent = node.nodeType === 1 ? node : node.parentNode;
      var cell = parent && parent.closest ? parent.closest('th,td') : null;
      return !!(cell && el.contains(cell) && !cell.closest('.tbl-align'));
    }
    if (el.classList.contains('hr')) {
      var src = el.querySelector('.hr-src');
      return !!(src && (node === src || src.contains(node)));
    }
    var scope = navScope(el) || el;
    return node === scope || scope.contains(node);
  }

  // 目标块落点：优先按原光标的横向位置投到目标块的末行/首行；投不到时回退到
  // 结构上的块尾/块首（表格落单元格、代码落 <code>、分隔线落原文行）。
  function placeCaretInBlock(target, up, x) {
    if (target.classList.contains('hr')) {
      var src = CaretEdit.ensureHrSource(target);
      CaretOffset.setSelectionRange(src, up ? src.textContent.length : 0);
      return;
    }
    var line = contentEdgeRect(target, up);
    if (x !== null && line && document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(x, line.top + line.height * 0.5);
      if (range && pointInNavScope(target, range.startContainer)) {
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    }
    if (target.classList.contains('table')) {
      var cells = RenderBlocks.tableCellList(target);
      if (!cells.length)
        return;
      if (up)
        CaretEdit.caretInCellEnd(cells[cells.length - 1]);
      else
        CellEdit.caretAtEdge(cells[0], true);
      return;
    }
    var scope = navScope(target);
    if (scope)
      CaretOffset.setSelectionRange(scope, up ? scope.textContent.length : 0);
  }

  // 在相邻块之间搬光标；返回 false 表示不该接管（还在块内、或已是首/末块）。
  function moveCaretAcrossBlock(el, up) {
    var target = up ? el.previousElementSibling : el.nextElementSibling;
    while (target && !(target.classList && target.classList.contains('block')))
      target = up ? target.previousElementSibling : target.nextElementSibling;
    if (!target)
      return false;

    var caret = caretRectOfSelection();
    if (!caretAtBlockEdge(el, up, caret))
      return false;

    var x = caret ? caret.left : null;
    target.focus();   // focusin → enterEdit；Config.INLINE_PROTO 下不重排
    placeCaretInBlock(target, up, x);
    return true;
  }

  /* ---------------- 跨块 Shift+方向键选区（原型） ----------------
     每个块是独立 contenteditable，WebKit 会把跨块的 Selection.extend() 夹回原
     块，原生选区跨不出块。这里自建一份「整篇绝对偏移」选区状态，用 body 上的
     覆盖层画高亮；原生选区只保留焦点处的折叠光标，保证光标可见、滚动与输入法
     正常。偏移口径与撤销栈一致：blockStartOffset + 块内 raw 偏移。

     范围只在 Shift+方向键或鼠标拖选时建立/扩展；点击、Esc、普通按键、撤销重建、
     打开查找、切源码模式都会清除。原型边界：输入法组合输入、跨表格单元格的精细
     边界都不接管，遇到时回退到原生单块行为。 */

  return {
    navScope: navScope,
    contentEdgeRect: contentEdgeRect,
    caretRectOfSelection: caretRectOfSelection,
    caretAtBlockEdge: caretAtBlockEdge,
    pointInNavScope: pointInNavScope,
    placeCaretInBlock: placeCaretInBlock,
    moveCaretAcrossBlock: moveCaretAcrossBlock
  };
  })();
