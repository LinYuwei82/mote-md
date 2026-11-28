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
        var span = tableCellAbsSpan(el, cells[c]);
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
          var clipped = cellClipContents(cells[c], lo - span.start, hi - span.start);
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
    var bounds = crossBounds();
    if (!bounds || bounds.from === bounds.to)
      return '';
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var list = blockList();
    var holder = document.createElement('div');
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
      var el = list[i];
      if (el.classList.contains('table')) {
        var table = crossTableHtml(el, lo, hi);
        if (table)
          holder.appendChild(table);
        base = span.stop;
        continue;
      }
      var sub = crossBlockRange(el, lo - span.base, hi - span.base);
      if (!sub) {
        base = span.stop;
        continue;
      }
      var fragment = sub.cloneContents();
      var inner = blockSemantic(el);
      var only = fragment.childNodes.length === 1 ? fragment.firstChild : null;
      var shell;
      // 整块选中时片段已带出内层语义标签，不能再套一层（与 selectionHtml 同口径）
      if (inner && only && only.nodeType === 1 && only.nodeName === inner.nodeName) {
        shell = only;
      } else {
        shell = document.createElement(inner ? inner.tagName.toLowerCase() : 'p');
        shell.appendChild(fragment);
      }
      applyCopyStyle(inner || el, shell);
      inlineCodeTokenColors(el, sub, shell);
      holder.appendChild(shell);
      base = span.stop;
    }
    sanitizeCopyHtml(holder);
    return holder.innerHTML;
  }

  // 用 insert 替换跨块选区：整篇源码拼接后一次重建（一步撤销），光标落到替换末尾
  function replaceCrossSelection(insert) {
    var bounds = crossBounds();
    if (!bounds)
      return false;
    var text = currentSource();
    var from = Math.max(0, Math.min(bounds.from, text.length));
    var to = Math.max(0, Math.min(bounds.to, text.length));
    var next = text.slice(0, from) + insert + text.slice(to);
    crossSel = null;
    dropCrossLayer();
    announceCross();
    // 改动前的整篇状态先入栈：撤销要回到「选区还在」的那一步
    commitHistory();
    var landed = rebuildFromSourceText(next, from + insert.length);
    if (landed && landed.block) {
      landed.block.classList.add('editing');
      landed.block.focus();
      placeBlockCaret(landed.block, landed.offset);
    }
    return true;
  }

  /* ---------------- 鼠标拖选跨块（原型） ----------------
     原生拖选同样出不了块：指针移出锚点块后交给自建选区。锚点在按下时按投点
     记住，之后每次移动只更新 focus；原生选区收成焦点处的折叠光标，高亮由
     覆盖层画。松手后选区保留，可直接删除/输入/复制，与 Shift+方向键同一套
     状态与清除时机。 */

  var dragCross = null;       // { anchor, el, x, y, goalX }
  var dragScrollTimer = 0;
  var DRAG_EDGE = 24;         // 距视口上下边缘多近开始自动滚动
  var DRAG_STEP = 18;

