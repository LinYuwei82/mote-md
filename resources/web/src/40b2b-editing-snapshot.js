  // 当前块内选区 → 整篇绝对偏移。失焦（没有活动编辑块）时 has 为 false
  function editingSelection() {
    var active = document.activeElement;
    var el = active ? blockOf(active) : null;
    var selection = window.getSelection();
    if (!el || !el.classList.contains('editing') || !selection.rangeCount)
      return { index: -1, start: 0, end: 0 };
    var code = isCodeBlock(el) ? codeEl(el) : null;
    var scope = code || el;
    var range = selection.getRangeAt(0);
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch (error) {
      prefix.selectNodeContents(scope);
    }
    // 代码块补上 "```lang\n" 前缀，才是与 dataset.raw 一致的块内偏移
    var start = prefix.toString().length + (code ? codePrefixLength(el) : 0);
    return { index: blockIndex(el), start: start, end: start + range.toString().length };
  }

  function absoluteOffsets(blocks, sel) {
    if (sel.index < 0)
      return { start: 0, end: 0, has: false };
    var base = blockStartOffset(blocks, collectGaps(), sel.index);
    return { start: base + sel.start, end: base + sel.end, has: true };
  }

  // 快照：wysiwyg 只保留块数组与块间空行（保住文首/文末空行），source 只保留
  // 纯文本。wysiwyg 的整篇文本由 layoutText 按需拼出，不额外存副本。
  function snapshotState() {
    if (mode === 'source') {
      var text = sourceEl.value;
      return {
        text: text, blocks: null, gaps: null, trail: trailingNewlineCount(text),
        start: sourceEl.selectionStart, end: sourceEl.selectionEnd,
        hasSel: document.activeElement === sourceEl
      };
    }
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var sel = editingSelection();
    var offsets = absoluteOffsets(blocks, sel);
    return {
      text: null,
      blocks: blocks, gaps: gaps, trail: trailingNewlines,
      start: offsets.start, end: offsets.end, hasSel: offsets.has
    };
  }

  function stateText(snap) {
    if (typeof snap.text === 'string')
      return snap.text;
    return layoutText(snap.blocks, snap.gaps, snap.trail);
  }

  function sameState(a, b) {
    // 同一模式的 wysiwyg 快照逐块比较即可，不必先把整篇拼成字符串
    if (a.blocks && b.blocks) {
      if (a.blocks.length !== b.blocks.length || a.trail !== b.trail)
        return false;
      for (var i = 0; i < a.blocks.length; i++)
        if (a.blocks[i] !== b.blocks[i])
          return false;
      // 块间空行也是文档内容：只改空行数量同样要落一个撤销步
      var gapsA = a.gaps || [];
      var gapsB = b.gaps || [];
      if (gapsA.length !== gapsB.length)
        return false;
      for (var g = 0; g < gapsA.length; g++)
        if (gapsA[g] !== gapsB[g])
          return false;
      return true;
    }
    return stateText(a) === stateText(b);
  }

  // 提交一个撤销步骤；文本未变化时只更新当前步的选区，避免进出编辑态
  // 或纯光标移动产生多余的历史记录
  function commitHistory() {
    // 批量转换期间（含焦点在块间移动触发的提交）不落历史，结尾统一提交一次
    if (suppressEvents || commitBatch > 0)
      return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    var snap = snapshotState();
    var current = history[historyIndex];
    if (current && sameState(current, snap)) {
      current.start = snap.start;
      current.end = snap.end;
      current.hasSel = snap.hasSel;
      scheduleDirty();
      return;
    }
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > MAX_HISTORY)
      history.splice(0, history.length - MAX_HISTORY);
    historyIndex = history.length - 1;
    scheduleDirty();
  }

  function scheduleCommit() {
    if (suppressEvents || composing || commitBatch > 0)
      return;
    if (commitTimer)
      clearTimeout(commitTimer);
    commitTimer = setTimeout(function () {
      commitTimer = null;
      commitHistory();
    }, COALESCE_MS);
  }

  // gaps 省略时全部按默认间隔（新建块之间的 2 个换行），供只关心文本的调用方使用
  function mountBlocks(blocks, gaps, trail, deferHi, skipNormalize) {
    var _t0 = window.MOTE_PERF ? performance.now() : 0;
    // 整篇重建后旧的绝对偏移全部失效，跨块选区必须先清掉
    clearCrossSelection();
    closeLangMenu();
    // 块菜单/手柄指向的旧节点即将全部脱离 DOM：撤销、重做、整篇载入都要收拢，
    // 否则菜单会悬空浮在重建后的文档上（动作虽有 parentNode 兜底不会误伤）
    closeBlockMenu();
    blockHandleTarget = null;
    if (blockHandle)
      blockHandle.style.display = 'none';
    root.innerHTML = '';
    var _t1 = window.MOTE_PERF ? performance.now() : 0;
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < blocks.length; i++) {
      var el = document.createElement('div');
      el.className = 'block';
      el.setAttribute('contenteditable', 'true');
      if (gaps)
        el.dataset.gap = String(gapBefore(gaps, i));
      renderBlock(el, blocks[i], deferHi);
      fragment.appendChild(el);
    }
    root.appendChild(fragment);
    var _t2 = window.MOTE_PERF ? performance.now() : 0;
    if (typeof trail === 'number')
      trailingNewlines = trail > 0 ? trail : 0;
    // 全部挂载完成、文档结构稳定后再归一化，避免逐个元素强制布局；
    // 新页首挂（skipNormalize）时浏览器本来就按含滚动条的高度排版，跳过这次补偿。
    if (!skipNormalize)
      normalizeCodeScrolls();
    var _t3 = window.MOTE_PERF ? performance.now() : 0;
    postWordCount();
    scheduleMermaid();
    flushDeferredCode();
    var _t4 = window.MOTE_PERF ? performance.now() : 0;
    if (window.MOTE_PERF) {
      post({type:'log', message:'PERF mountBlocks cleanup:' + (_t1-_t0).toFixed(1)
        + ' | mount:' + (_t2-_t1).toFixed(1) + ' | norm:' + (_t3-_t2).toFixed(1)
        + ' | wc:' + (_t4-_t3).toFixed(1) + ' | blocks:' + blocks.length});
    }
  }

  // 绝对偏移 → 所在块下标与块内偏移（undo/redo 恢复选区用）
  function locateBlock(blocks, gaps, absStart) {
    var base = 0;
    for (var i = 0; i < blocks.length; i++) {
      base += gapBefore(gaps, i);
      var stop = base + blocks[i].length;
      if (absStart <= stop || i === blocks.length - 1)
        return { index: i, start: Math.max(0, absStart - base) };
      base = stop;
    }
    return { index: blocks.length - 1, start: 0 };
  }

  function rebuildFromSnapshot(snap) {
    suppressEvents = true;
    var scrollY = window.scrollY;

    if (mode === 'source') {
      sourceEl.value = stateText(snap);
      trailingNewlines = snap.trail > 0 ? snap.trail : 0;
    } else {
      var layout = snap.blocks
        ? { blocks: snap.blocks.slice(), gaps: snap.gaps || [], trail: snap.trail }
        : splitSourceLayout(stateText(snap));
      var blocks = layout.blocks;
      mountBlocks(blocks, layout.gaps, layout.trail);

      if (snap.hasSel) {
        var base = 0;
        var index = -1;
        var start = 0;
        var end = 0;
        for (var i = 0; i < blocks.length; i++) {
          base += gapBefore(layout.gaps, i);
          var stop = base + blocks[i].length;
          if (snap.start <= stop || i === blocks.length - 1) {
            index = i;
            start = Math.max(0, snap.start - base);
            end = Math.max(start, Math.min(snap.end, stop) - base);
            break;
          }
          base = stop;
        }
        if (index >= 0 && root.children[index]) {
          var target = root.children[index];
          if (inPlaceEditable(target)) {
            renderBlock(target, blocks[index]);
            normalizeCodeScrolls(target);
            target.classList.add('editing');
            target.focus();
            placeBlockCaret(target, start, end);
          } else {
            target.classList.add('editing');
            target.textContent = blocks[index];
            target.focus();
            setSelectionRange(target, start, end);
          }
        }
      }
    }

    suppressEvents = false;
    if (mode === 'source' && snap.hasSel) {
      try {
        sourceEl.focus();
        sourceEl.setSelectionRange(snap.start, snap.end);
      } catch (error) { /* ignore */ }
    }
    window.scrollTo(0, scrollY);
    scheduleDirty();
    refreshToc();
    // 撤销/重做会整篇重建，旧的命中区间已经失效；查找条开着就重扫一遍
    if (findBar)
      scheduleFind();
  }

  function undo() {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
      commitHistory();
    }
    if (historyIndex <= 0) {
      post({ type: 'log', message: 'undo skipped index=' + historyIndex + ' size=' + history.length });
      return;
    }
    historyIndex--;
    post({ type: 'log', message: 'undo -> index=' + historyIndex + ' size=' + history.length });
    rebuildFromSnapshot(history[historyIndex]);
  }

  function redo() {
    if (historyIndex < 0 || historyIndex >= history.length - 1) {
      post({ type: 'log', message: 'redo skipped index=' + historyIndex + ' size=' + history.length });
      return;
    }
    historyIndex++;
    post({ type: 'log', message: 'redo -> index=' + historyIndex + ' size=' + history.length });
    rebuildFromSnapshot(history[historyIndex]);
  }

