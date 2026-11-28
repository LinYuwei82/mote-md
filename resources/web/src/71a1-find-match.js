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
    if (isCodeBlock(block))
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
    var startBlock = blockOf(range.startContainer) || match.block;
    var endBlock = blockOf(range.endContainer) || match.endBlock || startBlock;
    if (!startBlock || !endBlock || !startBlock.isConnected || !endBlock.isConnected)
      return null;
    if (!findBoundarySafe(startBlock, range.startContainer)
        || !findBoundarySafe(endBlock, range.endContainer))
      return null;
    var sameBlock = startBlock === endBlock;
    var startScope = isCodeBlock(startBlock) ? codeEl(startBlock) : startBlock;
    var endScope = isCodeBlock(endBlock) ? codeEl(endBlock) : endBlock;
    if (!startScope || !endScope)
      return null;
    var start = offsetIn(startScope, range.startContainer, range.startOffset);
    var end = offsetIn(endScope, range.endContainer, range.endOffset);
    if (start < 0 || end < 0)
      return null;
    if (isCodeBlock(startBlock))
      start += codePrefixLength(startBlock);
    if (isCodeBlock(endBlock))
      end += codePrefixLength(endBlock);
    var list = blockList();
    var si = list.indexOf(startBlock);
    var ei = list.indexOf(endBlock);
    if (si < 0 || ei < 0 || ei < si)
      return null;
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var startAbs = blockStartOffset(blocks, gaps, si) + start;
    var endAbs = blockStartOffset(blocks, gaps, ei) + end;
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
      if (isCodeBlock(span.startBlock) || isCodeBlock(span.endBlock)
          || span.startBlock.classList.contains('table')
          || span.endBlock.classList.contains('table')
          || span.startBlock.classList.contains('hr')
          || span.endBlock.classList.contains('hr'))
        return '跨块替换不支持代码块/表格/分隔线边界';
      var list = blockList();
      for (var i = span.startIndex + 1; i < span.endIndex; i++) {
        var between = list[i];
        if (isCodeBlock(between) || between.classList.contains('table')
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
    if (isCodeBlock(block) && repl.indexOf('```') >= 0)
      return '替换文本含 ```，会破坏代码围栏，已跳过';
    return '';
  }

  function rerenderFromRaw(block, raw, wasEditing) {
    renderBlock(block, raw);
    if (wasEditing && !block.classList.contains('editing'))
      block.classList.add('editing');
    if (isCodeBlock(block))
      normalizeCodeScrolls(block);
  }

  // 跨块替换后整篇重建：一次撤销步、保持滚动位置，返回替换末尾所在的块与块内偏移。
  function rebuildFromSourceText(text, caret) {
    var scrollY = window.scrollY;
    var layout = splitSourceLayout(text);
    suppressEvents = true;
    mountBlocks(layout.blocks, layout.gaps, layout.trail);
    suppressEvents = false;
    var at = locateBlock(layout.blocks, layout.gaps, caret);
    commitHistory();
    scheduleTocRefresh();
    window.scrollTo(window.scrollX, scrollY);
    return { block: root.children[at.index] || null, offset: at.start };
  }

  return {
    findMatchSpan: findMatchSpan,
    replacementProblem: replacementProblem,
    rerenderFromRaw: rerenderFromRaw,
    rebuildFromSourceText: rebuildFromSourceText
  };
  })();

  var findMatchSpan = FindMatch.findMatchSpan;
  var replacementProblem = FindMatch.replacementProblem;
  var rerenderFromRaw = FindMatch.rerenderFromRaw;
  var rebuildFromSourceText = FindMatch.rebuildFromSourceText;
