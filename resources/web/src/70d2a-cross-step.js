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
    var list = blockList();
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
