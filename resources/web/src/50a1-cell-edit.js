  /* ---------------- 所见即所得编辑 ---------------- */

  // 行内折叠接管「渲染态 == 原文」的块：段落/标题/列表/引用/代码块，以及
  // 用零宽标记补回 | 与对齐行的表格、用绝对定位叠出原文的 <hr>。回退模式下
  // 仍走整块替换。
  function inPlaceEditable(el) {
    return INLINE_PROTO;
  }

  function caretAtEdge(node, atStart) {
    var range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(!!atStart);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function activeCell(el) {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return null;
    var node = selection.getRangeAt(0).startContainer;
    var parent = node.nodeType === 1 ? node : node.parentNode;
    var cell = parent && parent.closest ? parent.closest('th,td') : null;
    return cell && el.contains(cell) && !cell.closest('.tbl-align') ? cell : null;
  }

  // 光标在单元格可见文本里的位置（标记不计入）。offset 为 -1 表示判断不了
  // （例如光标落进了不可编辑标记内部），调用方按“不是边界”处理。
  function cellCaretInfo(cell, range) {
    var nodes = editableTextNodes(cell);
    var total = 0;
    var i;
    for (i = 0; i < nodes.length; i++)
      total += nodes[i].nodeValue.length;
    // 容器是元素节点时（空格子里 WebKit 常把光标放在子节点之间，比如尾部 |
    // 标记旁），按边界比较数出光标左侧的可见字符数，同样能判断格首/格尾。
    if (range.startContainer.nodeType === 1) {
      var offset = 0;
      for (i = 0; i < nodes.length; i++) {
        var probe = document.createRange();
        probe.selectNodeContents(nodes[i]);
        if (probe.compareBoundaryPoints(Range.END_TO_END, range) > 0)
          break;
        offset += nodes[i].nodeValue.length;
      }
      return { offset: offset, total: total };
    }
    var acc = 0;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] === range.startContainer)
        return { offset: acc + range.startOffset, total: total };
      acc += nodes[i].nodeValue.length;
    }
    return { offset: -1, total: total };
  }

  // 单元格边界上的退格/删除定义为“不动”：跨格删字会悄悄吃掉 padding 空格，
  // 还会让光标跳到相邻单元格，语义不清。结构改动只走 Tab / 粘贴。
  function atCellEdge(el, backward, event) {
    var cell = activeCell(el);
    if (!cell)
      return false;
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return false;
    var range = selection.getRangeAt(0);
    if (!range.collapsed)
      return false;
    var info = cellCaretInfo(cell, range);
    if (info.offset < 0)
      return false;
    if (backward ? info.offset === 0 : info.offset >= info.total) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  function cellOfNode(el, node) {
    var parent = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    var cell = parent && parent.closest ? parent.closest('th,td') : null;
    return cell && el.contains(cell) && !cell.closest('.tbl-align') ? cell : null;
  }

  function rangeCrossesCells(el, range) {
    var a = cellOfNode(el, range.startContainer);
    var b = cellOfNode(el, range.endContainer);
    return !!(a || b) && a !== b;
  }

  // 单元格里"可见文本"（不含任何零宽标记里的原文）
  function cellVisibleText(cell) {
    var out = '';
    var walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var host = node.parentNode;
      if (host && host.closest && host.closest('.mk'))
        continue;
      out += node.nodeValue;
    }
    return out;
  }

  // 清理策略：跨格删除只清可见文本，行内标记（**、`、[]() 等）是零宽原子、
  // 不会被删掉。若某格删完后已无可见文本，这些标记就失去了承载内容——留着会在
  // 下次重渲染时显形（例如只剩 ****、[](url)）。此时把该格里除结构性标记
  // （| 与 \n）以外的元素全部移除，得到真正的空单元格。
  // 兜底：| 与 \n 结构标记始终保留，因此列数不会被改变；清理本身若异常，
  // 调用方退回“只清可见文本”，结构安全优先。
  function purgeCellFormatting(cell) {
    var nodes = cell.querySelectorAll('*');
    for (var i = nodes.length - 1; i >= 0; i--) {
      var node = nodes[i];
      if (node.classList && (node.classList.contains('mk-pipe')
          || node.classList.contains('mk-nl') || node.classList.contains('mk-pipeesc')))
        continue;
      if (node.parentNode && cell.contains(node))
        node.parentNode.removeChild(node);
    }
  }

  // 跨格删除：只清可见文本，保留 | 与对齐行标记。交给原生删除会把选区里的
  // contenteditable=false 标记一起带走，列数就变了（重排后整行少一列）。
  function clearSelectedCellText(el, range) {
    var startNode = range.startContainer;
    var startOffset = range.startOffset;
    var scope = range.commonAncestorContainer;
    if (scope.nodeType !== 1)
      scope = scope.parentNode;
    if (!scope || !el.contains(scope))
      scope = el;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    var hits = [];
    var node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node))
        continue;
      var host = node.parentNode;
      if (!host || !host.closest)
        continue;
      if (host.closest('.mk') || !host.closest('th,td'))
        continue;
      var s = node === startNode ? startOffset : 0;
      var e = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      // 所属单元格在这里就记下来：下面的清理可能把承载它的格式容器整段摘掉，
      // 之后再从 node.parentNode 往上找就找不到 <td> 了。
      if (e > s)
        hits.push({ node: node, start: s, end: e, cell: host.closest('th,td') });
    }
    if (!hits.length)
      return false;
    var cells = [];
    for (var i = 0; i < hits.length; i++) {
      var value = hits[i].node.nodeValue;
      hits[i].node.nodeValue = value.slice(0, hits[i].start) + value.slice(hits[i].end);
      var cell = hits[i].cell;
      if (cell && cell.closest('table') && cells.indexOf(cell) < 0)
        cells.push(cell);
    }
    for (var c = 0; c < cells.length; c++) {
      if (cellVisibleText(cells[c]).replace(/\s/g, '') !== '')
        continue;
      try {
        purgeCellFormatting(cells[c]);
      } catch (error) {
        // 兜底：清理失败就保留标记，仅清可见文本（列结构不受影响）
      }
    }
    var first = hits[0];
    var firstCell = first.cell;
    if (firstCell && !first.node.isConnected) {
      // 清理把承载起点的那段格式容器删掉了：光标落回该格可见文本末尾；
      // 若该格已空，就落在格内首个可编辑位置（结构标记之间）。
      if (cellVisibleText(firstCell).length)
        caretInCellEnd(firstCell);
      else
        caretAtEdge(firstCell, false);
    } else if (first.node.isConnected) {
      var caret = document.createRange();
      var offset = first.node === startNode ? Math.min(startOffset, first.node.nodeValue.length) : 0;
      caret.setStart(first.node, offset);
      caret.collapse(true);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    el.dataset.raw = el.textContent;
    scheduleDirty();
    scheduleCommit();
    return true;
  }

