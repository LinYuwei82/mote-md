  var Find = (function findModule() {
  var findBar = null, findInput = null, findReplace = null;
  var findCount = null, findNote = null, findLayer = null;
  var findMatches = [], findActive = -1, findTimer = 0, findNoteTimer = 0;
  var findCaret = null;         // 打开查找前的原光标
  var findJumped = null;        // 最近一次跳转到的命中
  var findInSource = false;     // 本轮命中是 Core.sourceEl.value 上的区间
  var FindPaint = (function findPaintModule() {
  /* ---------------- 查找 / 替换（Cmd+F） ----------------
     高亮用「覆盖层」画：用 Range.getClientRects() 取每个命中的几何，把绝对定位的
     色块盖在上面（#find-layer 挂在 body、pointer-events:none）。文档里不插入任何
     节点，所以 dataset.raw / textContent 一字不变；关闭时覆盖层与查找条一起从 DOM
     移除，不留任何元素。覆盖层不占排版，块几何不受影响。

     命中集合按文档顺序生成：块顺序 → 表格单元格顺序 → 单元格内下标顺序，
     跨块连续编号、连续跳转，正着/反着都能绕回。查找文本是「整篇可见文本」：
     每个块各占一段，块与块之间用一个虚拟换行连接；查询里用 ⌥↩ 输入换行，
     命中就可以从上一块跨到下一块。表格单元格之间、分隔线两侧用不可匹配的
     哨兵隔开，所以命中不会跨单元格，也不会跨过分隔线。

     大小写：两边统一转小写再比对；中文与全角标点不受影响。不做正则、不做整词、
     不做空白归一化（连续空格要按原样输入）。

     替换是「按原文偏移改 dataset.raw，再整块重排」：标记结构、代码围栏、表格
     管道都由 renderBlock 从新原文重建，撤销栈记一步（整篇快照）。块内命中可以
     跨文本节点：只要起点/终点都在行内格式之外，区间里的 **、`、[ 等要么没有，
     要么是完整的行内结构，替换后 Markdown 仍然合法（行内格式会随区间一起被
     替换掉）。起点或终点落在 <strong>/<em>/<a>/`<code>` 内部时仍拒绝，避免留下
     不成对的标记。替换文本含换行 / 表格里的 | / 代码里的 ``` 也拒绝。跨块命中
     走整篇源码重建：允许替换文本含换行，但两端或中间夹着代码块、表格、分隔线
     时拒绝，避免把围栏或列结构改坏。

     焦点：查找期间输入焦点留在查找框；wysiwyg 编辑态跳转会把焦点交给命中的块并
     选中该词（先 focus 触发 enterEdit，再覆盖选区）。此时 Enter/Shift+Enter 仍由
     文档级监听接管为「下一个/上一个」。源码模式（Cmd+E）没有 DOM 高亮层，跳转时
     把焦点交给 textarea 并选中命中（原生选区即是高亮），其余命中只计数。

     关闭时若跳转过，光标留在最后一个命中；没跳转过就回到打开查找前的原位置。 */

  var findPaintFrame = 0;       // 合并同一帧内的多次重画请求

  function findRuns(block) {
    var runs = [];
    function collect(scope) {
      var nodes = [];
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        var host = node.parentNode;
        if (!host || !host.closest)
          continue;
        if (host.closest('.mk, .gutter, .code-lang, .tbl-align'))
          continue;
        if (!node.nodeValue)
          continue;
        nodes.push(node);
      }
      if (!nodes.length)
        return;
      var text = '';
      var table = [];
      for (var i = 0; i < nodes.length; i++) {
        table.push({ node: nodes[i], start: text.length });
        text += nodes[i].nodeValue;
      }
      runs.push({ text: text, nodes: table });
    }

    if (LayoutCode.isCodeBlock(block)) {
      var code = LayoutCode.codeEl(block);
      if (code)
        collect(code);
      return runs;
    }
    if (block.classList && block.classList.contains('table')) {
      var cells = block.querySelectorAll('th,td');
      for (var c = 0; c < cells.length; c++) {
        if (cells[c].closest('.tbl-align'))
          continue;
        collect(cells[c]);
      }
      return runs;
    }
    collect(block);
    return runs;
  }

  // 段内字符下标 → DOM 点（同一段内的节点共享一个连续字符串）。
  // 边界必须区分「起点」和「终点」：下标正好落在两个文本节点的接缝上时，
  // 起点取后一个节点的 0，终点取前一个节点的末尾；否则一个落在单个 token
  // 内部的命中会被算成跨节点区间，替换会被误判为「跨着色边界」，
  // Range 也会把多出来的后半段一起高亮。
  function findPoint(run, index, isEnd) {
    var nodes = run.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var start = nodes[i].start;
      var len = nodes[i].node.nodeValue.length;
      if (isEnd ? index <= start + len : index < start + len)
        return { node: nodes[i].node, offset: index - start };
    }
    if (isEnd) {
      var last = nodes[nodes.length - 1];
      return { node: last.node, offset: last.node.nodeValue.length };
    }
    var head = nodes[0];
    return { node: head.node, offset: 0 };
  }

  function dropFindLayer() {
    if (findLayer && findLayer.parentNode)
      findLayer.parentNode.removeChild(findLayer);
    findLayer = null;
  }

  function ensureFindLayer() {
    if (!findLayer) {
      findLayer = document.createElement('div');
      findLayer.id = 'find-layer';
      findLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(findLayer);
    }
    return findLayer;
  }

  function findRects(match) {
    var rects = match.range.getClientRects();
    var out = [];
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].width > 0.5 && rects[i].height > 0.5)
        out.push(rects[i]);
    }
    return out;
  }

  function paintFind() {
    if (findInSource || !findMatches.length) {
      dropFindLayer();
      return;
    }
    var layer = ensureFindLayer();
    while (layer.firstChild)
      layer.removeChild(layer.firstChild);
    for (var i = 0; i < findMatches.length; i++) {
      var rects = findRects(findMatches[i]);
      for (var r = 0; r < rects.length; r++) {
        var box = document.createElement('div');
        box.className = 'find-hit' + (i === findActive ? ' active' : '');
        box.style.left = (rects[r].left + window.scrollX) + 'px';
        box.style.top = (rects[r].top + window.scrollY) + 'px';
        box.style.width = rects[r].width + 'px';
        box.style.height = rects[r].height + 'px';
        layer.appendChild(box);
      }
    }
  }

  // 排版一变（缩放、图片解码完成、字体替换）命中矩形就过期，但这三种情况下都
  // 不会触发 window resize：统一合并到下一帧重画，避免一次操作里重复计算。
  function scheduleFindPaint() {
    if (!findLayer || !findMatches.length || findPaintFrame)
      return;
    findPaintFrame = requestAnimationFrame(function () {
      findPaintFrame = 0;
      if (findLayer && findMatches.length)
        paintFind();
    });
  }

  function updateFindCount() {
    if (!findCount)
      return;
    findCount.textContent = findMatches.length
      ? (findActive + 1) + '/' + findMatches.length
      : '0/0';
  }

  function setFindNote(text) {
    if (!findNote)
      return;
    if (findNoteTimer) {
      clearTimeout(findNoteTimer);
      findNoteTimer = 0;
    }
    findNote.textContent = text || '';
    findNote.style.display = text ? 'inline' : 'none';
    if (text) {
      findNoteTimer = setTimeout(function () {
        findNoteTimer = 0;
        if (findNote) {
          findNote.textContent = '';
          findNote.style.display = 'none';
        }
      }, 4200);
    }
  }

  // 整篇可见文本：每个块占一段，块与块之间用一个虚拟换行连接；表格单元格之间、
  // 分隔线两侧用不可匹配的 \0 隔开。返回全文与文本段索引（at 为段在全文中的起点），
  // 命中下标 → 段 → DOM 点都靠这张表。
  return {
    findRuns: findRuns,
    findPoint: findPoint,
    dropFindLayer: dropFindLayer,
    findRects: findRects,
    paintFind: paintFind,
    scheduleFindPaint: scheduleFindPaint,
    updateFindCount: updateFindCount,
    setFindNote: setFindNote
  };
  })();

  var FindScan = (function findScanModule() {
  function findBuildDocument() {
    var blocks = BlockParse.blockList();
    var parts = [];
    var chunks = [];
    var length = 0;
    function sep(ch) {
      chunks.push(ch);
      length += ch.length;
    }
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      if (block.classList.contains('hr')) {
        if (length)
          sep('\0');
        continue;
      }
      var runs = FindPaint.findRuns(block);
      for (var r = 0; r < runs.length; r++) {
        if (length)
          sep(r === 0 ? '\n' : '\0');
        parts.push({ at: length, run: runs[r], block: block });
        chunks.push(runs[r].text);
        length += runs[r].text.length;
      }
    }
    return { text: chunks.join(''), parts: parts };
  }

  // 全文字符下标 → 所在文本段；落在分隔符或越界时返回 null（跨分隔符的命中跳过）。
  function findPartAt(parts, index) {
    var lo = 0, hi = parts.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (parts[mid].at <= index) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0)
      return null;
    var part = parts[found];
    if (index >= part.at + part.run.text.length)
      return null;
    return part;
  }

  function findScanBlocks(query, needle) {
    var doc = findBuildDocument();
    var text = doc.text;
    var hay = text.toLowerCase();
    var use = needle;
    // 少数语言的小写映射会改变长度（如 İ），那会打乱偏移，退回区分大小写
    if (hay.length !== text.length) {
      hay = text;
      use = query;
    }
    var from = 0;
    var at;
    while ((at = hay.indexOf(use, from)) >= 0) {
      var last = at + use.length - 1;
      var head = findPartAt(doc.parts, at);
      var tail = findPartAt(doc.parts, last);
      if (head && tail) {
        var range = document.createRange();
        try {
          var a = FindPaint.findPoint(head.run, at - head.at, false);
          var z = FindPaint.findPoint(tail.run, last - tail.at + 1, true);
          range.setStart(a.node, a.offset);
          range.setEnd(z.node, z.offset);
          findMatches.push({
            range: range,
            block: head.block,
            endBlock: tail.block,
            cross: head.run !== tail.run,
            startRun: head.run,
            startIndex: at,
            endIndex: at + use.length
          });
        } catch (error) { /* 跳过无法落到 DOM 的命中 */ }
      }
      from = at + Math.max(1, use.length);
    }
  }

  function findScanSource(query, needle) {
    var text = Core.sourceEl.value;
    var hay = text.toLowerCase();
    var use = needle;
    if (hay.length !== text.length) {
      hay = text;
      use = query;
    }
    var from = 0;
    var at;
    while ((at = hay.indexOf(use, from)) >= 0) {
      findMatches.push({ source: true, start: at, end: at + use.length });
      from = at + Math.max(1, use.length);
    }
  }

  function findScan(query) {
    findMatches = [];
    findActive = -1;
    findInSource = ViewState.mode() === 'source';
    if (!query) {
      FindPaint.dropFindLayer();
      FindPaint.updateFindCount();
      return;
    }
    var needle = query.toLowerCase();
    if (findInSource)
      findScanSource(query, needle);
    else
      findScanBlocks(query, needle);
    if (!findMatches.length) {
      FindPaint.dropFindLayer();
      FindPaint.updateFindCount();
      return;
    }
    findActive = 0;
    FindPaint.paintFind();
    FindPaint.updateFindCount();
  }

  // 命中落在代码块的横向滚动区里时，先把它横向带进可视区（否则高亮在屏幕外）
  function revealFindMatch(match, rect) {
    var node = match.range.startContainer;
    var host = node.nodeType === 1 ? node : node.parentNode;
    var scroller = host && host.closest ? host.closest('.code-scroll') : null;
    if (!scroller || !rect)
      return;
    var box = scroller.getBoundingClientRect();
    if (rect.left < box.left)
      scroller.scrollLeft -= (box.left - rect.left) + 24;
    else if (rect.right > box.right)
      scroller.scrollLeft += (rect.right - box.right) + 24;
  }

  // 跨块选区横跨多个 contenteditable，WebKit 的选区行为不确定；跳转时只选
  // 起点块内的那一段，高亮层仍然画完整命中。
  function findSelectRange(match) {
    var range = match.range.cloneRange();
    if (match.cross && match.startRun) {
      var tail = FindPaint.findPoint(match.startRun, match.startRun.text.length, true);
      try {
        range.setEnd(tail.node, tail.offset);
      } catch (error) { /* 起点段已失效时保持整段选区 */ }
    }
    return range;
  }

  // 编辑态跳转：先让块进入就地编辑（enterEdit 会先把光标放到块尾），再把选区
  // 覆盖成命中范围。enterEdit 是同步的，先 focus 后设选区，落点才是命中本身；
  // 反过来先设选区会被 enterEdit 的 setSelectionRange 覆盖掉。
  function applyFindCaret(match) {
    var block = CaretCode.blockOf(match.range.startContainer) || match.block;
    if (!block || !block.isConnected || !match.range.startContainer.isConnected)
      return false;
    if (document.activeElement !== block)
      block.focus();
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(findSelectRange(match));
    return true;
  }

  function scrollSourceTo(start) {
    var line = Core.sourceEl.value.slice(0, start).split('\n').length;
    var lineHeight = parseFloat(getComputedStyle(Core.sourceEl).lineHeight) || 22;
    var visible = Core.sourceEl.clientHeight / lineHeight;
    Core.sourceEl.scrollTop = Math.max(0, (line - visible / 2) * lineHeight);
  }

  function goFind(delta) {
    if (!findMatches.length)
      return;
    findActive = (findActive + delta + findMatches.length) % findMatches.length;
    var match = findMatches[findActive];

    if (findInSource) {
      Core.sourceEl.focus();
      try {
        Core.sourceEl.setSelectionRange(match.start, match.end);
      } catch (error) { /* ignore */ }
      scrollSourceTo(match.start);
      findJumped = match;
      FindPaint.updateFindCount();
      return;
    }

    var rects = FindPaint.findRects(match);
    if (rects.length) {
      window.scrollBy(0, rects[0].top - window.innerHeight * 0.38);
      revealFindMatch(match, rects[0]);
    }
    // 覆盖层用「视口矩形 + 滚动量」换算成文档坐标；代码块内部横向滚动不改变
    // 文档滚动量，所以必须等横向滚动落定后再画。
    FindPaint.paintFind();
    var wantCaret = !!findCaret || !!Core.root.querySelector('.block.editing');
    if (wantCaret && applyFindCaret(match))
      findJumped = match;
    FindPaint.updateFindCount();
  }

  return {
    findScan: findScan,
    findSelectRange: findSelectRange,
    scrollSourceTo: scrollSourceTo,
    goFind: goFind
  };
  })();

  var FindMatch = (function findMatchModule() {
  /* ---- 替换：命中 → 整篇原文的绝对区间 ---- */

  // 命中边界落在行内格式内部时，整段替换会把外侧的开标记留下、把闭标记删掉，
  // 产生不成对的 ** / ` / [ 等。代码块不适用这条：高亮会把一行拆成多个 span，
  // 但 raw 仍是连续的，跨 span 替换是安全的。
  var FIND_INLINE_HOSTS = {
    STRONG: 1, EM: 1, DEL: 1, S: 1, A: 1, CODE: 1,
    MARK: 1, SUP: 1, SUB: 1, KBD: 1, SPAN: 1
  };

  function findBoundarySafe(block, node) {
    if (LayoutCode.isCodeBlock(block))
      return true;
    var current = node && node.nodeType === 3 ? node.parentNode : node;
    while (current && current !== block) {
      if (current.nodeType === 1 && FIND_INLINE_HOSTS[current.nodeName])
        return false;
      current = current.parentNode;
    }
    return true;
  }

  // 块内命中允许跨文本节点，但两个端点都必须在行内格式之外；这样区间里要么
  // 没有标记，要么是完整的行内结构，替换后 Markdown 仍然合法。返回绝对区间。
  function findMatchSpan(match) {
    if (findInSource)
      return { start: match.start, end: match.end, sameBlock: true, source: true };
    var range = match.range;
    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected)
      return null;
    var startBlock = CaretCode.blockOf(range.startContainer) || match.block;
    var endBlock = CaretCode.blockOf(range.endContainer) || match.endBlock || startBlock;
    if (!startBlock || !endBlock || !startBlock.isConnected || !endBlock.isConnected)
      return null;
    if (!findBoundarySafe(startBlock, range.startContainer)
        || !findBoundarySafe(endBlock, range.endContainer))
      return null;
    var sameBlock = startBlock === endBlock;
    var startScope = LayoutCode.isCodeBlock(startBlock) ? LayoutCode.codeEl(startBlock) : startBlock;
    var endScope = LayoutCode.isCodeBlock(endBlock) ? LayoutCode.codeEl(endBlock) : endBlock;
    if (!startScope || !endScope)
      return null;
    var start = CaretCode.offsetIn(startScope, range.startContainer, range.startOffset);
    var end = CaretCode.offsetIn(endScope, range.endContainer, range.endOffset);
    if (start < 0 || end < 0)
      return null;
    if (LayoutCode.isCodeBlock(startBlock))
      start += LayoutCode.codePrefixLength(startBlock);
    if (LayoutCode.isCodeBlock(endBlock))
      end += LayoutCode.codePrefixLength(endBlock);
    var list = BlockParse.blockList();
    var si = list.indexOf(startBlock);
    var ei = list.indexOf(endBlock);
    if (si < 0 || ei < 0 || ei < si)
      return null;
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var startAbs = DocumentModel.blockStartOffset(blocks, gaps, si) + start;
    var endAbs = DocumentModel.blockStartOffset(blocks, gaps, ei) + end;
    if (endAbs < startAbs)
      return null;
    return {
      start: startAbs,
      end: endAbs,
      sameBlock: sameBlock,
      startBlock: startBlock,
      endBlock: endBlock,
      startIndex: si,
      endIndex: ei,
      startRelative: start,
      endRelative: end
    };
  }

  function replacementProblem(match, repl) {
    if (repl.indexOf('\0') >= 0)
      return '替换文本含非法字符';
    if (findInSource)
      return repl.indexOf('\n') >= 0 ? '替换文本不能含换行' : '';
    var span = findMatchSpan(match);
    if (!span)
      return '命中边界在行内格式内部或已失效，未替换';
    if (!span.sameBlock) {
      if (LayoutCode.isCodeBlock(span.startBlock) || LayoutCode.isCodeBlock(span.endBlock)
          || span.startBlock.classList.contains('table')
          || span.endBlock.classList.contains('table')
          || span.startBlock.classList.contains('hr')
          || span.endBlock.classList.contains('hr'))
        return '跨块替换不支持代码块/表格/分隔线边界';
      var list = BlockParse.blockList();
      for (var i = span.startIndex + 1; i < span.endIndex; i++) {
        var between = list[i];
        if (LayoutCode.isCodeBlock(between) || between.classList.contains('table')
            || between.classList.contains('hr'))
          return '跨块区间包含代码块/表格/分隔线，未替换';
      }
      return '';
    }
    if (repl.indexOf('\n') >= 0)
      return '替换文本不能含换行';
    var block = span.startBlock;
    if (block.classList.contains('hr'))
      return '分隔线不支持替换';
    if (block.classList.contains('table') && repl.indexOf('|') >= 0)
      return '替换文本含 |，会改变表格列结构，已跳过';
    if (LayoutCode.isCodeBlock(block) && repl.indexOf('```') >= 0)
      return '替换文本含 ```，会破坏代码围栏，已跳过';
    return '';
  }

  function rerenderFromRaw(block, raw, wasEditing) {
    RenderBlocks.renderBlock(block, raw);
    if (wasEditing && !block.classList.contains('editing'))
      block.classList.add('editing');
    if (LayoutCode.isCodeBlock(block))
      LayoutCode.normalizeCodeScrolls(block);
  }

  // 跨块替换后整篇重建：一次撤销步、保持滚动位置，返回替换末尾所在的块与块内偏移。
  function rebuildFromSourceText(text, caret) {
    var scrollY = window.scrollY;
    var layout = LayoutCode.splitSourceLayout(text);
    EditingSnapshot.setSuppressed(true);
    EditingSnapshot.mountBlocks(layout.blocks, layout.gaps, layout.trail);
    EditingSnapshot.setSuppressed(false);
    var at = EditingSnapshot.locateBlock(layout.blocks, layout.gaps, caret);
    EditingSnapshot.commitHistory();
    Toc.scheduleTocRefresh();
    window.scrollTo(window.scrollX, scrollY);
    return { block: Core.root.children[at.index] || null, offset: at.start };
  }

  return {
    findMatchSpan: findMatchSpan,
    replacementProblem: replacementProblem,
    rerenderFromRaw: rerenderFromRaw,
    rebuildFromSourceText: rebuildFromSourceText
  };
  })();

  var ReplaceRun = (function replaceRunModule() {
  function replaceCurrent() {
    if (!findMatches.length) {
      FindPaint.setFindNote('没有可替换的命中');
      return;
    }
    var match = findMatches[findActive];
    var repl = findReplace ? findReplace.value : '';
    var problem = FindMatch.replacementProblem(match, repl);
    if (problem) {
      FindPaint.setFindNote(problem);
      return;
    }
    var keep = findActive;
    if (findInSource) {
      var value = Core.sourceEl.value;
      Core.sourceEl.value = value.slice(0, match.start) + repl + value.slice(match.end);
      EditingSnapshot.commitHistory();
      Toc.scheduleTocRefresh();
      FindScan.findScan(findInput.value);
      if (findMatches.length) {
        findActive = Math.min(keep, findMatches.length - 1);
        FindPaint.updateFindCount();
      }
      FindPaint.setFindNote('已替换 1 处');
      return;
    }
    var span = FindMatch.findMatchSpan(match);
    if (!span) {
      FindPaint.setFindNote('命中已失效，请重新查找');
      return;
    }
    if (!span.sameBlock) {
      var text = DocumentModel.currentSource();
      if (span.end > text.length) {
        FindPaint.setFindNote('命中已失效，请重新查找');
        return;
      }
      var landed = FindMatch.rebuildFromSourceText(
        text.slice(0, span.start) + repl + text.slice(span.end),
        span.start + repl.length);
      findCaret = landed.block ? { block: landed.block, offset: landed.offset } : null;
      findJumped = null;
      FindScan.findScan(findInput.value);
      if (findMatches.length) {
        findActive = Math.min(keep, findMatches.length - 1);
        FindPaint.paintFind();
        FindPaint.updateFindCount();
      }
      if (findInput)
        findInput.focus();
      FindPaint.setFindNote('已替换 1 处（跨块）');
      return;
    }
    var block = span.startBlock;
    var raw = block.dataset.raw || '';
    var wasEditing = block.classList.contains('editing');
    FindMatch.rerenderFromRaw(block,
      raw.slice(0, span.startRelative) + repl + raw.slice(span.endRelative), wasEditing);
    EditingSnapshot.commitHistory();
    Toc.scheduleTocRefresh();
    FindScan.findScan(findInput.value);
    if (findMatches.length) {
      findActive = Math.min(keep, findMatches.length - 1);
      FindPaint.paintFind();
      FindPaint.updateFindCount();
    }
    FindPaint.setFindNote('已替换 1 处');
  }

  // 只要有一个跨块命中就统一按绝对区间从后往前改整篇源码，最后重建一次。
  function replaceAllAcrossBlocks(repl, query) {
    var text = DocumentModel.currentSource();
    var spans = [];
    var skipped = 0;
    for (var m = 0; m < findMatches.length; m++) {
      if (FindMatch.replacementProblem(findMatches[m], repl)) {
        skipped++;
        continue;
      }
      var span = FindMatch.findMatchSpan(findMatches[m]);
      if (!span || span.end > text.length) {
        skipped++;
        continue;
      }
      spans.push(span);
    }
    if (!spans.length) {
      FindPaint.setFindNote('没有可替换的命中');
      return;
    }
    spans.sort(function (a, b) { return b.start - a.start; });
    // 从后往前改：最后一个替换的末尾在后续修改中不会再移动
    var caret = spans[0].start + repl.length;
    for (var i = 0; i < spans.length; i++)
      text = text.slice(0, spans[i].start) + repl + text.slice(spans[i].end);
    var landed = FindMatch.rebuildFromSourceText(text, caret);
    findCaret = landed.block ? { block: landed.block, offset: landed.offset } : null;
    findJumped = null;
    FindScan.findScan(query);
    FindPaint.paintFind();
    FindPaint.updateFindCount();
    if (findInput)
      findInput.focus();
    FindPaint.setFindNote(skipped
      ? '已替换 ' + spans.length + ' 处，跳过 ' + skipped + ' 处（跨行内标记/结构限制）'
      : '全部替换 ' + spans.length + ' 处');
  }

  function replaceAll() {
    if (!findMatches.length) {
      FindPaint.setFindNote('没有可替换的命中');
      return;
    }
    var repl = findReplace ? findReplace.value : '';
    var query = findInput.value;
    var done = 0;
    var skipped = 0;

    if (findInSource) {
      var value = Core.sourceEl.value;
      for (var i = findMatches.length - 1; i >= 0; i--)
        value = value.slice(0, findMatches[i].start) + repl + value.slice(findMatches[i].end);
      done = findMatches.length;
      Core.sourceEl.value = value;
      EditingSnapshot.commitHistory();
      Toc.scheduleTocRefresh();
      FindScan.findScan(query);
      FindPaint.updateFindCount();
      FindPaint.setFindNote('全部替换 ' + done + ' 处');
      return;
    }

    // 只要命中里有跨块的，就整篇改一次；否则保持按块重排（更快，也保留编辑态）
    var hasCross = false;
    for (var c = 0; c < findMatches.length; c++) {
      var crossSpan = FindMatch.findMatchSpan(findMatches[c]);
      if (crossSpan && !crossSpan.sameBlock) {
        hasCross = true;
        break;
      }
    }
    if (hasCross) {
      replaceAllAcrossBlocks(repl, query);
      return;
    }

    // 按块分组（保持文档顺序），块内从后往前改 raw，前面命中的下标不受影响
    var groups = [];
    for (var m = 0; m < findMatches.length; m++) {
      var problem = FindMatch.replacementProblem(findMatches[m], repl);
      if (problem) {
        skipped++;
        continue;
      }
      var span = FindMatch.findMatchSpan(findMatches[m]);
      if (!span) {
        skipped++;
        continue;
      }
      var host = span.startBlock;
      var slot = -1;
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].block === host) {
          slot = g;
          break;
        }
      }
      if (slot < 0) {
        groups.push({ block: host, spans: [] });
        slot = groups.length - 1;
      }
      groups[slot].spans.push({ start: span.startRelative, end: span.endRelative });
    }
    for (var n = 0; n < groups.length; n++) {
      var target = groups[n].block;
      var text = target.dataset.raw || '';
      var spans = groups[n].spans.sort(function (a, b) { return b.start - a.start; });
      for (var s = 0; s < spans.length; s++)
        text = text.slice(0, spans[s].start) + repl + text.slice(spans[s].end);
      FindMatch.rerenderFromRaw(target, text, target.classList.contains('editing'));
      done += spans.length;
    }
    if (done) {
      EditingSnapshot.commitHistory();
      Toc.scheduleTocRefresh();
      FindScan.findScan(query);
      FindPaint.paintFind();
      FindPaint.updateFindCount();
    }
    FindPaint.setFindNote(skipped
      ? '已替换 ' + done + ' 处，跳过 ' + skipped + ' 处（跨行内标记/结构限制）'
      : '全部替换 ' + done + ' 处');
  }

  return {
    replaceCurrent: replaceCurrent,
    replaceAll: replaceAll
  };
  })();

  var FindUi = (function findUiModule() {
  function scheduleFind() {
    if (findTimer)
      clearTimeout(findTimer);
    findTimer = setTimeout(function () {
      findTimer = 0;
      if (findInput)
        FindScan.findScan(findInput.value);
    }, 120);
  }

  // 查找框是多行 textarea：⌥↩ 输入换行，块与块之间也按一个换行参与匹配。
  function growFindInput() {
    if (!findInput)
      return;
    findInput.style.height = 'auto';
    findInput.style.height = Math.min(72, Math.max(22, findInput.scrollHeight)) + 'px';
  }

  function buildFindBar() {
    findBar = document.createElement('div');
    findBar.id = 'find-bar';
    findBar.innerHTML = '<textarea id="find-input" rows="1" placeholder="查找（⌥↩ 换行）" spellcheck="false"></textarea>'
      + '<input id="find-replace" type="text" placeholder="替换为" spellcheck="false">'
      + '<span id="find-count">0/0</span>'
      + '<button id="find-prev" type="button" title="上一个（Shift+Enter）">↑</button>'
      + '<button id="find-next" type="button" title="下一个（Enter）">↓</button>'
      + '<button id="find-replace-one" type="button" title="替换当前命中">替换</button>'
      + '<button id="find-replace-all" type="button" title="全部替换">全部</button>'
      + '<button id="find-close" type="button" title="关闭（Esc）">×</button>'
      + '<span id="find-note"></span>';
    document.body.appendChild(findBar);
    findInput = document.getElementById('find-input');
    findReplace = document.getElementById('find-replace');
    findCount = document.getElementById('find-count');
    findNote = document.getElementById('find-note');
    findNote.style.display = 'none';
    growFindInput();

    findInput.addEventListener('input', function () {
      growFindInput();
      scheduleFind();
    });
    findReplace.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        ReplaceRun.replaceCurrent();
      }
    });
    findInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter')
        return;
      // ⌥↩ 让 textarea 插入换行，input 事件会重新扫描；其余 Enter 仍是跳转
      if (event.altKey) {
        setTimeout(growFindInput, 0);
        return;
      }
      event.preventDefault();
      FindScan.goFind(event.shiftKey ? -1 : 1);
    });
    document.getElementById('find-prev').addEventListener('click', function () { FindScan.goFind(-1); });
    document.getElementById('find-next').addEventListener('click', function () { FindScan.goFind(1); });
    document.getElementById('find-replace-one').addEventListener('click', ReplaceRun.replaceCurrent);
    document.getElementById('find-replace-all').addEventListener('click', ReplaceRun.replaceAll);
    document.getElementById('find-close').addEventListener('click', function () { closeFind(); });
  }

  function openFind() {
    if (findBar)
      return;
    // 查找条打开后焦点交给查找框，覆盖层选区先收起
    Cross.clearCrossSelection();
    findInSource = ViewState.mode() === 'source';
    if (findInSource) {
      findCaret = { source: true, start: Core.sourceEl.selectionStart, end: Core.sourceEl.selectionEnd };
    } else {
      var block = document.activeElement ? CaretCode.blockOf(document.activeElement) : null;
      // 关掉查找栏时走 placeBlockCaret（原文口径），这里也按原文口径取
      findCaret = block ? { block: block, offset: CaretOffset.rawCaretOffset(block) } : null;
    }
    findJumped = null;

    buildFindBar();
    findBar.style.display = 'flex';
    findInput.focus();

    var picked = '';
    if (findInSource) {
      if (Core.sourceEl.selectionEnd > Core.sourceEl.selectionStart)
        picked = Core.sourceEl.value.slice(Core.sourceEl.selectionStart, Core.sourceEl.selectionEnd);
    } else {
      var selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount)
        picked = selection.toString();
    }
    picked = picked.replace(/\s+/g, ' ').trim();
    if (picked && picked.length <= 80)
      findInput.value = picked;
    findInput.select();
    growFindInput();
    FindScan.findScan(findInput.value);
  }

  function closeFind() {
    if (findTimer) {
      clearTimeout(findTimer);
      findTimer = 0;
    }
    if (findNoteTimer) {
      clearTimeout(findNoteTimer);
      findNoteTimer = 0;
    }
    var inSource = findInSource;
    var jumped = findJumped;
    var caret = findCaret;
    findMatches = [];
    findActive = -1;
    findJumped = null;
    findCaret = null;
    findInSource = false;
    FindPaint.dropFindLayer();
    if (findBar && findBar.parentNode)
      findBar.parentNode.removeChild(findBar);
    findBar = findInput = findReplace = findCount = findNote = null;

    if (inSource) {
      Core.sourceEl.focus();
      var target = jumped && jumped.source ? jumped : caret;
      if (target) {
        try {
          Core.sourceEl.setSelectionRange(target.start, target.end === undefined ? target.start : target.end);
        } catch (error) { /* ignore */ }
        FindScan.scrollSourceTo(target.start);
      }
      return;
    }

    if (jumped && jumped.block && jumped.block.isConnected
        && jumped.range.startContainer.isConnected) {
      // 跳转过：光标落在最后一个命中
      if (document.activeElement !== jumped.block)
        jumped.block.focus();
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(FindScan.findSelectRange(jumped));
    } else if (caret && caret.block && caret.block.isConnected) {
      // 没跳转过：回到打开查找前的光标位置
      if (document.activeElement !== caret.block)
        caret.block.focus();
      CaretEdit.placeBlockCaret(caret.block, caret.offset);
    }
  }

  document.addEventListener('keydown', function (event) {
    var barOpen = !!(findBar && findBar.style.display !== 'none');
    if ((event.metaKey || event.ctrlKey) && !event.altKey
        && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      event.stopPropagation();
      if (barOpen)
        closeFind();
      else
        openFind();
      return;
    }
    if (!barOpen)
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
      return;
    }
    // 编辑态跳转后焦点在正文块上，Enter/Shift+Enter 仍按「下一个/上一个」处理；
    // 查找框自己的 Enter 由 input 上的监听处理（这里放行）。
    var target = event.target;
    if (event.key === 'Enter' && target && target !== findInput && target.closest
        && target.closest('.block')) {
      event.preventDefault();
      event.stopPropagation();
      FindScan.goFind(event.shiftKey ? -1 : 1);
    }
  }, true);

  // 覆盖层是文档绝对坐标：只有代码块内部横向滚动会改变几何而不改变文档滚动量。
  // 窗口缩放会让绝对坐标失配，也重画一次。
  document.addEventListener('scroll', function (event) {
    if (!findLayer || !findMatches.length)
      return;
    if (event.target && event.target.closest && event.target.closest('.code-scroll'))
      FindPaint.paintFind();
  }, true);

  window.addEventListener('resize', function () {
    if (findLayer && findMatches.length)
      FindPaint.paintFind();
    // 覆盖层是文档绝对坐标，缩放/换行变化后必须按新几何重画
    if (Cross.isActive())
      Cross.paintCrossSelection();
  });

  // 命中的块里图片晚一步解码完、字体替换完成时块高会变，但都不触发 resize。
  // load 不冒泡，必须用捕获阶段才能收到 <img> 的加载完成。
  document.addEventListener('load', function (event) {
    var target = event.target;
    if (target && target.nodeName === 'IMG') {
      FindPaint.scheduleFindPaint();
      if (Cross.isActive())
        Cross.paintCrossSelection();
    }
  }, true);

  if (document.fonts) {
    if (document.fonts.ready && document.fonts.ready.then)
      document.fonts.ready.then(function () {
        FindPaint.scheduleFindPaint();
        if (Cross.isActive())
          Cross.paintCrossSelection();
      });
    if (document.fonts.addEventListener)
      document.fonts.addEventListener('loadingdone', function () {
        FindPaint.scheduleFindPaint();
        if (Cross.isActive())
          Cross.paintCrossSelection();
      });
  }

  window.addEventListener('scroll', function () {
    Toc.scheduleActiveHeading();
  });

  // 视口或字号变化后标题纵坐标失效，下一次滚动高亮时重算
  window.addEventListener('resize', function () { Toc.invalidateTops(); });

  if (Core.tocList) {
    Core.tocList.addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('.toc-item') : null;
      if (!node)
        return;
      event.preventDefault();
      var item = Toc.itemAt(Number(node.getAttribute('data-toc')));
      if (!item)
        return;
      item.el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -16);
      Toc.updateActiveHeading();
    });
  }

  document.addEventListener('dragover', function (event) {
    event.preventDefault();
  });

  document.addEventListener('drop', function (event) {
    event.preventDefault();
    var files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length)
      return;
    var file = files[0];
    // 图片走 base64 落盘（与粘贴同一管道）；.md 等文本仍回退为「未关联路径」载入。
    // 原生层装好 NSDraggingDestination 后，文件拖放会先被原生接走，这里只是兜底。
    if (/^image\//i.test(file.type || '')) {
      ClipboardPaste.postImageFile(file, 'drop');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      Util.post({ type: 'drop', name: file.name, text: String(reader.result) });
    };
    reader.readAsText(file);
  });

  return {
    scheduleFind: scheduleFind,
    closeFind: closeFind
  };
  })();

  return {
    findRuns: FindPaint.findRuns,
    findPoint: FindPaint.findPoint,
    dropFindLayer: FindPaint.dropFindLayer,
    findRects: FindPaint.findRects,
    paintFind: FindPaint.paintFind,
    scheduleFindPaint: FindPaint.scheduleFindPaint,
    updateFindCount: FindPaint.updateFindCount,
    setFindNote: FindPaint.setFindNote,
    findScan: FindScan.findScan,
    findSelectRange: FindScan.findSelectRange,
    scrollSourceTo: FindScan.scrollSourceTo,
    goFind: FindScan.goFind,
    findMatchSpan: FindMatch.findMatchSpan,
    replacementProblem: FindMatch.replacementProblem,
    rerenderFromRaw: FindMatch.rerenderFromRaw,
    rebuildFromSourceText: FindMatch.rebuildFromSourceText,
    replaceCurrent: ReplaceRun.replaceCurrent,
    replaceAll: ReplaceRun.replaceAll,
    scheduleFind: FindUi.scheduleFind,
    closeFind: FindUi.closeFind,
    isOpen: function () { return !!findBar; }
  };
  })();
