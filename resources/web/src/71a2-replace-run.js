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
      var value = sourceEl.value;
      sourceEl.value = value.slice(0, match.start) + repl + value.slice(match.end);
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
      var value = sourceEl.value;
      for (var i = findMatches.length - 1; i >= 0; i--)
        value = value.slice(0, findMatches[i].start) + repl + value.slice(findMatches[i].end);
      done = findMatches.length;
      sourceEl.value = value;
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
