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

  // 命中点落在格线/边框/内边距上时，按几何距离挑最近的单元格
  function cellFromPoint(el, x, y) {
    var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    for (var i = 0; i < stack.length; i++) {
      var hit = stack[i].closest ? stack[i].closest('th,td') : null;
      if (hit && el.contains(hit) && !hit.closest('.tbl-align'))
        return hit;
    }
    var cells = el.querySelectorAll('th, td');
    var best = null;
    var bestDist = Infinity;
    for (var c = 0; c < cells.length; c++) {
      if (cells[c].closest('.tbl-align'))
        continue;
      var rect = cells[c].getBoundingClientRect();
      var dx = Math.max(rect.left - x, 0, x - rect.right);
      var dy = Math.max(rect.top - y, 0, y - rect.bottom);
      var dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = cells[c];
      }
    }
    return best;
  }

  // 单元格末尾必须落在最后一个可见文本节点之后、尾部 | 标记之前：
  // 落在标记之后会让新输入跑到 `|` 外面，重排时那一行会凭空多出一列。
  function caretInCellEnd(cell) {
    var nodes = editableTextNodes(cell);
    var range = document.createRange();
    if (!nodes.length) {
      // 空格子里没有可依附的可见文本：光标要放在尾部结构标记（| / \n）之前。
      // 放到单元格末尾（标记之后）时，新输入会写到分隔符外面，重排多出一列。
      var i = cell.childNodes.length;
      while (i > 0) {
        var prev = cell.childNodes[i - 1];
        if (prev.nodeType === 1 && prev.classList
            && (prev.classList.contains('mk-pipe') || prev.classList.contains('mk-nl')))
          i--;
        else
          break;
      }
      range.setStart(cell, i);
    } else {
      var last = nodes[nodes.length - 1];
      range.setStart(last, last.nodeValue.length);
    }
    range.collapse(true);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 光标必须落在单元格里：一旦落到表格外，后续输入会写进块级文本（甚至 <hr>
  // 外侧），原文就坏了。这里只兜底，不改变正常点击的位置。
  function ensureCellCaret(el) {
    var cell = activeCell(el);
    if (cell) {
      // 元素级光标停在单元格末尾（尾部 | 之后）同样会写坏原文：新输入会跑到
      // 分隔符外面，下次重排那一行就多出一列。收回到可见文本末尾。
      var selection = window.getSelection();
      var range = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (range && range.collapsed && range.startContainer === cell
          && range.startOffset >= cell.childNodes.length)
        caretInCellEnd(cell);
      return;
    }
    var first = el.querySelector('th, td');
    if (first)
      caretInCellEnd(first);
  }

  function ensureHrSource(el) {
    var src = el.querySelector('.hr-src');
    if (!src) {
      src = document.createElement('span');
      src.className = 'hr-src';
      src.textContent = el.dataset.raw || '';
      el.appendChild(src);
    }
    return src;
  }

  // 整篇重建（撤销/重做、源码→预览）后按块类型恢复光标；偏移一律是块原文口径
  function placeBlockCaret(el, start, end) {
    // 只给起点时按点光标处理：让 undefined 参与下面的减法会得到 NaN，范围与
    // 光标都会被算成 0（代码块里就表现为光标跳到块首）
    if (end === undefined || end === null)
      end = start;
    if (el.classList.contains('hr')) {
      var src = ensureHrSource(el);
      var hrLen = src.textContent.length;
      setSelectionRange(src, Math.max(0, Math.min(start, hrLen)), Math.max(0, Math.min(end, hrLen)));
      return;
    }
    if (isCodeBlock(el)) {
      // 快照里是 dataset.raw 口径（含围栏），换成 <code> 内偏移
      var code = codeEl(el);
      var prefix = codePrefixLength(el);
      var limit = code.textContent.length;
      setSelectionRange(code, Math.max(0, Math.min(start - prefix, limit)),
        Math.max(0, Math.min(end - prefix, limit)));
      return;
    }
    setSelectionRange(el, start, end);
    if (el.classList.contains('table'))
      ensureCellCaret(el);
  }

  function enterEdit(el) {
    if (el.classList.contains('editing'))
      return;
    el.classList.add('editing');

    if (inPlaceEditable(el)) {
      // 不重建内容。渲染态 DOM 原样进入编辑，标记/行号栏本来就常驻，
      // 因此进入某块只切换一个 class，不产生任何重排。
      var at = pendingOffset;
      pendingOffset = null;
      if (el.classList.contains('hr')) {
        // 横线保持原位，原文以绝对定位的淡色行叠在线上（不占高度）
        caretAtEdge(ensureHrSource(el), false);
        return;
      }
      if (isCodeBlock(el)) {
        var code = codeEl(el);
        if (!code)
          return;
        ensureLangBadge(el);
        var limit = code.textContent.length;
        setSelectionRange(code, at === null ? limit : Math.max(0, Math.min(at, limit)));
        return;
      }
      // 必须走 locateOffset（标记按零宽原子取整）：setCaret 会数进标记文本，
      // 点击行首时可能把光标塞进折叠标记里。
      if (el.classList.contains('table')) {
        if (at === null) {
          var cells = tableCellList(el);
          if (cells.length) {
            caretInCellEnd(cells[cells.length - 1]);
            return;
          }
        }
        setSelectionRange(el, at === null ? el.textContent.length
                                          : Math.max(0, Math.min(at, el.textContent.length)));
        ensureCellCaret(el);
        return;
      }
      setSelectionRange(el, at === null ? el.textContent.length
                                        : Math.max(0, Math.min(at, el.textContent.length)));
      return;
    }

    el.textContent = el.dataset.raw === undefined ? el.textContent : el.dataset.raw;
    var offset = pendingOffset === null ? el.textContent.length : pendingOffset;
    pendingOffset = null;
    setCaret(el, Math.max(0, Math.min(offset, el.textContent.length)));
  }

  function leaveEdit(el) {
    if (!el.classList.contains('editing'))
      return;
    // 撤销时整篇重建会把旧节点摘掉，focusout 可能在游离节点上触发
    if (!el.isConnected)
      return;
    if (isCodeBlock(el)) {
      // 编辑期间 DOM 一直保持渲染态（行号栏 + 高亮 span），离开只摘掉 class。
      // 组合输入若没来得及收尾，这里补一次同步，仍不重建整块结构。
      if (el._codeStale)
        syncCode(el, true);
      el.classList.remove('editing');
      commitHistory();
      scheduleTocRefresh();
      scheduleMermaid();
      return;
    }
    if (el.classList.contains('hr') || el.classList.contains('table')) {
      // 编辑期间结构一直是渲染态（表格行/单元格/横线都在），离开时按 DOM 原文
      // 重排一次：表格对齐行回到隐藏行、单元格内新输入的 ** 等标记重新着色。
      renderBlock(el, el.textContent);
      commitHistory();
      scheduleTocRefresh();
      return;
    }
    renderBlock(el, el.textContent.replace(/\n+$/, ''));
    commitHistory();
    scheduleTocRefresh();
  }


