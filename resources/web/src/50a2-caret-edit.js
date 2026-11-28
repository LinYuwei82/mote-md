  var CaretEdit = (function caretEditModule() {
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
    var nodes = MarkerCaret.editableTextNodes(cell);
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
    var cell = CellEdit.activeCell(el);
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
      CaretOffset.setSelectionRange(src, Math.max(0, Math.min(start, hrLen)), Math.max(0, Math.min(end, hrLen)));
      return;
    }
    if (LayoutCode.isCodeBlock(el)) {
      // 快照里是 dataset.raw 口径（含围栏），换成 <code> 内偏移
      var code = LayoutCode.codeEl(el);
      var prefix = LayoutCode.codePrefixLength(el);
      var limit = code.textContent.length;
      CaretOffset.setSelectionRange(code, Math.max(0, Math.min(start - prefix, limit)),
        Math.max(0, Math.min(end - prefix, limit)));
      return;
    }
    CaretOffset.setSelectionRange(el, start, end);
    if (el.classList.contains('table'))
      ensureCellCaret(el);
  }

  function enterEdit(el) {
    if (el.classList.contains('editing'))
      return;
    el.classList.add('editing');

    if (CellEdit.inPlaceEditable(el)) {
      // 不重建内容。渲染态 DOM 原样进入编辑，标记/行号栏本来就常驻，
      // 因此进入某块只切换一个 class，不产生任何重排。
      var at = pendingOffset;
      pendingOffset = null;
      if (el.classList.contains('hr')) {
        // 横线保持原位，原文以绝对定位的淡色行叠在线上（不占高度）
        CellEdit.caretAtEdge(ensureHrSource(el), false);
        return;
      }
      if (LayoutCode.isCodeBlock(el)) {
        var code = LayoutCode.codeEl(el);
        if (!code)
          return;
        CaretCode.ensureLangBadge(el);
        var limit = code.textContent.length;
        CaretOffset.setSelectionRange(code, at === null ? limit : Math.max(0, Math.min(at, limit)));
        return;
      }
      // 必须走 locateOffset（标记按零宽原子取整）：setCaret 会数进标记文本，
      // 点击行首时可能把光标塞进折叠标记里。
      if (el.classList.contains('table')) {
        if (at === null) {
          var cells = RenderBlocks.tableCellList(el);
          if (cells.length) {
            caretInCellEnd(cells[cells.length - 1]);
            return;
          }
        }
        CaretOffset.setSelectionRange(el, at === null ? el.textContent.length
                                          : Math.max(0, Math.min(at, el.textContent.length)));
        ensureCellCaret(el);
        return;
      }
      CaretOffset.setSelectionRange(el, at === null ? el.textContent.length
                                        : Math.max(0, Math.min(at, el.textContent.length)));
      return;
    }

    el.textContent = el.dataset.raw === undefined ? el.textContent : el.dataset.raw;
    var offset = pendingOffset === null ? el.textContent.length : pendingOffset;
    pendingOffset = null;
    CaretCode.setCaret(el, Math.max(0, Math.min(offset, el.textContent.length)));
  }

  function leaveEdit(el) {
    if (!el.classList.contains('editing'))
      return;
    // 撤销时整篇重建会把旧节点摘掉，focusout 可能在游离节点上触发
    if (!el.isConnected)
      return;
    if (LayoutCode.isCodeBlock(el)) {
      // 编辑期间 DOM 一直保持渲染态（行号栏 + 高亮 span），离开只摘掉 class。
      // 组合输入若没来得及收尾，这里补一次同步，仍不重建整块结构。
      if (el._codeStale)
        CaretCode.syncCode(el, true);
      el.classList.remove('editing');
      EditingSnapshot.commitHistory();
      Toc.scheduleTocRefresh();
      MermaidInit.scheduleMermaid();
      return;
    }
    if (el.classList.contains('hr') || el.classList.contains('table')) {
      // 编辑期间结构一直是渲染态（表格行/单元格/横线都在），离开时按 DOM 原文
      // 重排一次：表格对齐行回到隐藏行、单元格内新输入的 ** 等标记重新着色。
      RenderBlocks.renderBlock(el, el.textContent);
      EditingSnapshot.commitHistory();
      Toc.scheduleTocRefresh();
      return;
    }
    RenderBlocks.renderBlock(el, el.textContent.replace(/\n+$/, ''));
    EditingSnapshot.commitHistory();
    Toc.scheduleTocRefresh();
  }


  return {
    cellFromPoint: cellFromPoint,
    caretInCellEnd: caretInCellEnd,
    ensureCellCaret: ensureCellCaret,
    ensureHrSource: ensureHrSource,
    placeBlockCaret: placeBlockCaret,
    enterEdit: enterEdit,
    leaveEdit: leaveEdit
  };
  })();
