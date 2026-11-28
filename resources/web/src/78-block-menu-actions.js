  var BlockMenuActions = (function blockMenuActionsModule() {
  /* ---------- 块菜单动作 ---------- */

  function insertBlockNear(block, above) {
    if (!block || !block.parentNode)
      return;
    EditingSnapshot.commitHistory();
    var el = makeBlockEl('');
    if (above)
      root.insertBefore(el, block);
    else
      root.insertBefore(el, block.nextSibling);
    afterBlockStructureChange();
    el.classList.add('editing');
    el.focus();
    CaretCode.setCaret(el, 0);
    if (el.scrollIntoView)
      el.scrollIntoView({ block: 'nearest' });
    BlockHandle.setHandleBlock(el);
  }

  function duplicateBlock(block) {
    if (!block || !block.parentNode)
      return;
    EditingSnapshot.commitHistory();
    var el = makeBlockEl(rawOf(block));
    root.insertBefore(el, block.nextSibling);
    afterBlockStructureChange();
  }

  function removeBlock(block) {
    if (!block || !block.parentNode)
      return;
    EditingSnapshot.commitHistory();
    if (blockList().length <= 1) {
      // 最后一块不删结构：清空内容，保持可编辑；清空后的状态也要落一步，
      // 否则撤销会直接跳过这一步回到更早的历史，内容找不回来
      applyRawToBlock(block, '', 0, 0, true);
      EditingSnapshot.commitHistory();
      return;
    }
    var prev = block.previousElementSibling;
    var next = block.nextElementSibling;
    var focusEl = (prev && prev.classList.contains('block')) ? prev
      : ((next && next.classList.contains('block')) ? next : null);
    block.remove();
    if (blockHandleTarget === block)
      BlockHandle.setHandleBlock(focusEl);
    afterBlockStructureChange();
    if (focusEl) {
      focusEl.classList.add('editing');
      focusEl.focus();
      // 偏移必须按 raw 口径给：代码块的 textContent 不含围栏，直接给
      // textContent.length 会被换算成块首而不是块尾
      CaretEdit.placeBlockCaret(focusEl, rawOf(focusEl).length);
    }
  }

  function turnBlockTo(block, key) {
    var type = { h1: 'h1', h2: 'h2', h3: 'h3', paragraph: 'p',
      ul: 'ul', ol: 'ol', quote: 'quote', codeBlock: 'code' }[key];
    if (!type || !block || !block.parentNode)
      return;
    EditingSnapshot.commitHistory();
    var raw = rawOf(block);
    var before = kindOfRaw(raw);
    var next = convertRaw(raw, type, false);
    // 与 convertBlocks 同口径：列表/引用/表格/代码转正文逐行拆回独立段落，
    // 不在一个块里塞硬换行
    if (type === 'p' && (before === 'ul' || before === 'ol' || before === 'quote' ||
                         before === 'table' || before === 'code')) {
      var lines = contentOfRaw(raw, before).replace(/\n+$/, '').split('\n');
      if (lines.length > 1) {
        applyRawToBlock(block, lines[0], lines[0].length, lines[0].length, true);
        var anchor = block;
        for (var li = 1; li < lines.length; li++) {
          insertBlockAfter(anchor, lines[li], lines[li].length);
          anchor = anchor.nextElementSibling;
        }
        normalizeBlockGaps();
        Toc.scheduleTocRefresh();
        EditingSnapshot.commitHistory();   // 拆分合成一个撤销步
        return;
      }
    }
    applyRawToBlock(block, next, next.length, next.length, true);
    setTimeout(EditingSnapshot.commitHistory, 0);
  }

  return {
    insertBlockNear: insertBlockNear,
    duplicateBlock: duplicateBlock,
    removeBlock: removeBlock,
    turnBlockTo: turnBlockTo
  };
  })();
