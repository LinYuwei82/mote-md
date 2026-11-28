  function findBuildDocument() {
    var blocks = blockList();
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
      var runs = findRuns(block);
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
          var a = findPoint(head.run, at - head.at, false);
          var z = findPoint(tail.run, last - tail.at + 1, true);
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
    var text = sourceEl.value;
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
    findInSource = mode === 'source';
    if (!query) {
      dropFindLayer();
      updateFindCount();
      return;
    }
    var needle = query.toLowerCase();
    if (findInSource)
      findScanSource(query, needle);
    else
      findScanBlocks(query, needle);
    if (!findMatches.length) {
      dropFindLayer();
      updateFindCount();
      return;
    }
    findActive = 0;
    paintFind();
    updateFindCount();
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
      var tail = findPoint(match.startRun, match.startRun.text.length, true);
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
    var block = blockOf(match.range.startContainer) || match.block;
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
    var line = sourceEl.value.slice(0, start).split('\n').length;
    var lineHeight = parseFloat(getComputedStyle(sourceEl).lineHeight) || 22;
    var visible = sourceEl.clientHeight / lineHeight;
    sourceEl.scrollTop = Math.max(0, (line - visible / 2) * lineHeight);
  }

  function goFind(delta) {
    if (!findMatches.length)
      return;
    findActive = (findActive + delta + findMatches.length) % findMatches.length;
    var match = findMatches[findActive];

    if (findInSource) {
      sourceEl.focus();
      try {
        sourceEl.setSelectionRange(match.start, match.end);
      } catch (error) { /* ignore */ }
      scrollSourceTo(match.start);
      findJumped = match;
      updateFindCount();
      return;
    }

    var rects = findRects(match);
    if (rects.length) {
      window.scrollBy(0, rects[0].top - window.innerHeight * 0.38);
      revealFindMatch(match, rects[0]);
    }
    // 覆盖层用「视口矩形 + 滚动量」换算成文档坐标；代码块内部横向滚动不改变
    // 文档滚动量，所以必须等横向滚动落定后再画。
    paintFind();
    var wantCaret = !!findCaret || !!root.querySelector('.block.editing');
    if (wantCaret && applyFindCaret(match))
      findJumped = match;
    updateFindCount();
  }

