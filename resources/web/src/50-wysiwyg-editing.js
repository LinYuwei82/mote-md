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


  // 拆分块后平衡成对行内标记（**、`、__、~~）：前半未闭合时——若后半以该标记
  // 开头（拆分点恰在闭合标记前）把闭合标记挪到前半；否则前半补闭合、后半重开。
  function balanceInlineMarkers(before, after) {
    var marks = ['**', '`', '__', '~~'];
    for (var mi = 0; mi < marks.length; mi++) {
      var M = marks[mi];
      if ((before.split(M).length - 1) % 2 === 1) {
        if (after.indexOf(M) === 0) {
          before += M;
          after = after.slice(M.length);
        } else {
          var cut = before.lastIndexOf(M);
          if (before.slice(cut + M.length) === '') {
            before = before.slice(0, cut);
            after = M + after;
          } else {
            before += M;
            after = M + after;
          }
        }
      }
    }
    return [before, after];
  }

  function splitBlock(el) {
    commitHistory();   // 先把分段前的状态固定为一个步骤

    var raw = el.textContent;
    var offset = caretOffset(el);
    var kind = blockType(el);
    var before, after;
    var exitStructure = false;
    // 列表/有序列表/引用按行拆分：后半段必须保留结构前缀，否则 "\n- b" 这类
    // 残缺原文会被 renderBlock 降级成带字面 "- " 的段落；空条目上回车退出结构，
    // 不再无限追加空条目（与 wolai/Notion 一致）。
    if (kind === 'ul' || kind === 'ol' || kind === 'quote') {
      var leadRe = kind === 'quote' ? /^\s*>\s?/
        : kind === 'ol' ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      var lines = raw.split('\n');
      var pos = 0, li = 0, col = 0, i;
      for (i = 0; i < lines.length; i++) {
        var lineEnd = pos + lines[i].length;
        if (offset <= lineEnd) { li = i; col = offset - pos; break; }
        if (offset === lineEnd + 1 && i + 1 < lines.length) { li = i + 1; col = 0; break; }
        pos = lineEnd + 1;
        li = i; col = lines[i].length;
      }
      var line = lines[li];
      var lm = line.match(leadRe);
      var lead = lm ? lm[0] : (kind === 'quote' ? '> ' : kind === 'ol' ? '1. ' : '- ');
      // 任务项：前缀连带复选框一起算，拆出的后半段保留 [ ]/[x] 标记
      if (kind !== 'quote') {
        var tm = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/);
        if (tm)
          lead = tm[0];
      }
      if (line.slice(lead.length).trim() === '') {
        // 空条目没有可拆的内容：无论光标在标记前后都退出结构
        before = lines.slice(0, li).join('\n');
        after = lines.slice(li + 1).join('\n');
        exitStructure = true;
      } else if (col >= line.length && li < lines.length - 1) {
        // 光标在非末行行尾：按行边界拆，当前行整行留在前半，不造空条目
        before = lines.slice(0, li + 1).join('\n');
        after = lines.slice(li + 1).join('\n');
      } else if (col <= lead.length) {
        before = lines.slice(0, li).join('\n');
        after = lines.slice(li).join('\n');
      } else {
        before = lines.slice(0, li).concat(line.slice(0, col)).join('\n');
        after = [lead + line.slice(col)].concat(lines.slice(li + 1)).join('\n');
      }
    } else {
      before = raw.slice(0, offset);
      after = raw.slice(offset);
      // 标题中间回车：后半段保留 # 前缀，不降级成正文
      if (kind.charAt(0) === 'h' && after.trim() !== '') {
        var hm = raw.match(/^(#{1,6})(\s+)/);
        if (hm)
          after = hm[1] + hm[2] + after.replace(/^\s+/, '');
      }
    }

    // 拆分点若落在 **加粗** / `行内代码` 等成对标记内部，两半会各留一个未闭合
    // 标记，渲染成字面星号/反引号。拆分后先做配对平衡：前半闭合、后半重开。
    var balanced = balanceInlineMarkers(before, after);
    before = balanced[0];
    after = balanced[1];

    renderBlock(el, before);

    if (exitStructure && !before && !after) {
      // 唯一一行就是空条目：本块直接退回空正文即可，不再拆出新块
      el.classList.add('editing');
      el.focus();
      setCaret(el, 0);
      scheduleDirty();
      commitHistory();   // 分段后的状态单独成一个步骤
      scheduleTocRefresh();
      return;
    }

    var neo = document.createElement('div');
    neo.className = 'block';
    neo.setAttribute('contenteditable', 'true');
    root.insertBefore(neo, el.nextSibling);
    renderBlock(neo, after);
    neo.classList.add('editing');
    neo.focus();
    setCaret(neo, 0);
    scheduleDirty();
    commitHistory();   // 分段后的状态单独成一个步骤
    scheduleTocRefresh();
  }

  // 结构类型：只有类型相同的相邻块才允许合并。段落原文接进表格、标题、列表或
  // 引用的原文里会把结构写坏（表格会把段落文字并进最后一行末格）。
  function blockType(el) {
    if (isCodeBlock(el))
      return 'code';
    for (var level = 1; level <= 6; level++) {
      if (el.classList.contains('h' + level))
        return 'h' + level;
    }
    var kinds = ['table', 'ul', 'ol', 'quote', 'hr'];
    for (var i = 0; i < kinds.length; i++) {
      if (el.classList.contains(kinds[i]))
        return kinds[i];
    }
    return 'p';
  }

  // 块内行首退格（光标紧跟换行标记之后）：去掉换行与本行的结构前缀，
  // 把内容并入上一行末尾——与跨块块首退格合并同一套语义。换行标记不可编辑，
  // 不接管的话退格只会把光标挪过标记，看起来像死键。
  function joinPrevLine(el) {
    var raw = el.textContent;
    var offset = caretOffset(el);
    var lines = raw.split('\n');
    var acc = 0, li = -1, i;
    for (i = 0; i < lines.length; i++) {
      if (offset <= acc + lines[i].length) { li = i; break; }
      acc += lines[i].length + 1;
    }
    if (li <= 0)
      return;
    var line = lines[li];
    var lm = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|^\s*>\s?/);
    var lead = lm ? lm[0] : '';
    var joined = lines.slice(0, li - 1);
    joined.push(lines[li - 1] + line.slice(lead.length));
    var rest = lines.slice(li + 1);
    for (i = 0; i < rest.length; i++)
      joined.push(rest[i]);
    commitHistory();
    applyRawToBlock(el, joined.join('\n'), acc - 1, acc - 1, true);
    setTimeout(commitHistory, 0);
    scheduleTocRefresh();
  }

  // 光标所在行的定位信息（块原文口径，代码块含围栏行）
  function caretLineInfo(el) {
    var raw = rawOf(el);
    var off = rawCaretOffset(el);
    var lines = raw.split('\n');
    var acc = 0, li = 0;
    for (var i = 0; i < lines.length; i++) {
      if (off <= acc + lines[i].length) { li = i; break; }
      acc += lines[i].length + 1;
    }
    return { lines: lines, li: li, lineStart: acc, off: off };
  }

  // Tab：结构行（列表/任务/引用）在本行行首加两格缩进——光标在行中也一样，
  // 不能把空格插进正文；其余行保持行内插两格。
  function indentCurrentLine(el) {
    if (!isCodeBlock(el)) {
      var info = caretLineInfo(el);
      var line = info.lines[info.li];
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s*>/.test(line)) {
        commitHistory();
        var lines = info.lines.slice();
        lines[info.li] = '  ' + lines[info.li];
        applyRawToBlock(el, lines.join('\n'), info.off + 2, info.off + 2, true);
        setTimeout(commitHistory, 0);
        return;
      }
    }
    document.execCommand('insertText', false, '  ');
  }

  // Shift+Tab：去掉本行行首最多两个空格；本行没有缩进就什么都不做
  function outdentCurrentLine(el) {
    var info = caretLineInfo(el);
    var line = info.lines[info.li];
    var strip = Math.min(/^\s*/.exec(line)[0].length, 2);
    if (!strip)
      return;
    commitHistory();
    var lines = info.lines.slice();
    lines[info.li] = line.slice(strip);
    var caret = Math.max(info.lineStart, info.off - strip);
    applyRawToBlock(el, lines.join('\n'), caret, caret, true);
    setTimeout(commitHistory, 0);
  }

  // 原生跨块选区（Cmd+A 全选、鼠标拖出块）上的删除：按整篇源码拼接删掉选区。
  // 不接管的话 INLINE_PROTO 会把选区收成折叠光标，退格变成死键。
  function deleteNativeCrossSelection() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return false;
    var range = selection.getRangeAt(0);
    if (range.collapsed)
      return false;
    var first = blockAtBoundary(range.startContainer, range.startOffset, false);
    var last = blockAtBoundary(range.endContainer, range.endOffset, true);
    if (!first || !last || first === last)
      return false;
    var from = absoluteOf(first, range.startContainer, range.startOffset);
    var to = absoluteOf(last, range.endContainer, range.endOffset);
    if (from === null || to === null) {
      var list = blockList();
      var blocks = collectBlocks();
      var gaps = collectGaps();
      var fi = list.indexOf(first);
      var li = list.indexOf(last);
      if (fi < 0 || li < 0)
        return false;
      if (from === null)
        from = blockStartOffset(blocks, gaps, fi);
      if (to === null)
        to = blockStartOffset(blocks, gaps, li) + blocks[li].length;
    }
    if (from > to) {
      var t = from;
      from = to;
      to = t;
    }
    var text = currentSource();
    var next = text.slice(0, from) + text.slice(to);
    commitHistory();
    var landed = rebuildFromSourceText(next, from);
    if (landed && landed.block) {
      landed.block.classList.add('editing');
      landed.block.focus();
      placeBlockCaret(landed.block, landed.offset);
    }
    commitHistory();
    return true;
  }

  function mergeBack(el) {
    var previous = el.previousElementSibling;
    if (!previous || !previous.classList.contains('block'))
      return;

    // 相邻块结构类型不同时不合并：两段原文直接拼接会得到坏 Markdown
    if (blockType(el) !== blockType(previous)) {
      // 代码块首行行首退格是例外：上一块不是代码块时合并不了，但退格不能是
      // 死键——先剥掉围栏还原成正文（再按一次退格即可与上一段相接）。
      if (isCodeBlock(el) && !isCodeBlock(previous)) {
        commitHistory();
        applyRawToBlock(el, contentOfRaw(rawOf(el), 'code'), 0, 0, true);
        setTimeout(commitHistory, 0);
        return;
      }
      // 结构块（引用/列表/标题）首行退格遇到不同类型：剥掉前缀还原正文（再按
      // 一次即可与上一段合并），对齐原生壳行为，避免死键。
      var kind0 = blockType(el);
      if (kind0 === 'ul' || kind0 === 'ol' || kind0 === 'quote' || kind0.charAt(0) === 'h') {
        commitHistory();
        applyRawToBlock(el, contentOfRaw(rawOf(el), kind0), 0, 0, true);
        setTimeout(commitHistory, 0);
      }
      return;
    }

    // 代码块首行行首退格 → 与上一块合并。相邻也是代码块时合并正文（保留上一块
    // 的语言）；相邻是普通块时不把围栏塞进段落（那会得到坏 Markdown），保持不动。
    if (isCodeBlock(el)) {
      commitHistory();   // 合并前的状态单独成一个步骤
      var junction = codeText(previous).length;
      var joined = codeText(previous) + codeText(el);
      renderBlock(previous, codeRaw(previous, joined));
      normalizeCodeScrolls(previous);
      el.remove();
      previous.classList.add('editing');
      previous.focus();
      setSelectionRange(codeEl(previous), junction);
      scheduleDirty();
      commitHistory();
      scheduleTocRefresh();
      return;
    }

    commitHistory();   // 合并前的状态单独成一个步骤

    var previousRaw = previous.dataset.raw === undefined ? previous.textContent : previous.dataset.raw;
    // 同类型拼接要按结构口径：标题剥掉第二块的 # 前缀再并成一行；列表/引用
    // 每行自带标记，补一个换行合成一个块；正文直接首尾相接。
    var elRaw = el.textContent;
    var mergeKind = blockType(el);
    var merged;
    if (mergeKind.charAt(0) === 'h')
      merged = previousRaw + contentOfRaw(elRaw, mergeKind);
    else if (mergeKind === 'ul' || mergeKind === 'ol' || mergeKind === 'quote')
      merged = previousRaw + '\n' + elRaw;
    else
      merged = previousRaw + elRaw;
    el.remove();
    renderBlock(previous, merged);
    normalizeCodeScrolls(previous);
    previous.classList.add('editing');
    previous.focus();
    setCaret(previous, previousRaw.length);
    scheduleDirty();
    commitHistory();
    scheduleTocRefresh();
  }

