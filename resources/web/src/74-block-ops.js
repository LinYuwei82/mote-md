  var BlockOps = (function blockOpsModule() {
  var blockHandle = null;
  var blockHandleTarget = null;   // 手柄当前停靠的块
  var blockHandleKeep = false;    // 指针停在手柄上，离开正文也不隐藏
  var blockMenu = null;
  var blockMenuTarget = null;
  var blockDrag = null;           // 正在拖拽的块
  var dragPending = null;         // 手柄按下的起点（尚未确认是拖拽还是单击）
  var insertLine = null;
  var InsertLine = (function insertLineModule() {
  /* ---------- 插入指示线 ---------- */

  function ensureInsertLine() {
    if (insertLine)
      return insertLine;
    insertLine = document.createElement('div');
    insertLine.id = 'block-insert-line';
    insertLine.setAttribute('aria-hidden', 'true');
    document.body.appendChild(insertLine);
    return insertLine;
  }

  // 指针纵坐标 → 落点参照块（插到它前面）；null 表示插到文档末尾。
  // 拖拽块自身跳过，不参与落点判定。
  function blockDropRef(clientY) {
    var list = BlockParse.blockList();
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === blockDrag)
        continue;
      var r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2)
        return el;
    }
    return null;
  }

  function positionInsertLine(ref) {
    var line = ensureInsertLine();
    if (!ref) {
      var list = BlockParse.blockList();
      var last = null;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] !== blockDrag) {
          last = list[i];
          break;
        }
      }
      if (!last) {
        line.style.display = 'none';
        return;
      }
      var lr = last.getBoundingClientRect();
      line.style.left = lr.left + 'px';
      line.style.width = Math.max(40, lr.width) + 'px';
      line.style.top = (lr.bottom + 2) + 'px';
      line.style.display = 'block';
      return;
    }
    var r = ref.getBoundingClientRect();
    line.style.left = r.left + 'px';
    line.style.width = Math.max(40, r.width) + 'px';
    line.style.top = (r.top - 2) + 'px';
    line.style.display = 'block';
  }

  return {
    blockDropRef: blockDropRef,
    positionInsertLine: positionInsertLine
  };
  })();

  var BlockHandle = (function blockHandleModule() {
  /* ---------- 手柄显示与定位 ---------- */

  function positionBlockHandle() {
    if (!blockHandle)
      return;
    var el = blockHandleTarget;
    if (!el || el.parentNode !== root || ViewState.mode() === 'source' || blockDrag
        || document.body.classList.contains('pdf-export')) {
      blockHandle.style.display = 'none';
      return;
    }
    var r = el.getBoundingClientRect();
    if (r.bottom < -8 || r.top > window.innerHeight + 8) {
      blockHandle.style.display = 'none';
      return;
    }
    var w = blockHandle.offsetWidth || 22;
    var left = r.left - w - 6;
    if (left < 2)
      left = 2;
    blockHandle.style.left = left + 'px';
    blockHandle.style.top = (r.top + 1) + 'px';
    blockHandle.style.display = 'block';
  }

  function setHandleBlock(el) {
    if (blockDrag)
      return;
    blockHandleTarget = el || null;
    positionBlockHandle();
  }

  function hideBlockHandle() {
    if (blockHandleKeep || blockDrag)
      return;
    blockHandleTarget = null;
    if (blockHandle)
      blockHandle.style.display = 'none';
  }

  function ensureBlockHandle() {
    if (blockHandle)
      return blockHandle;
    blockHandle = document.createElement('div');
    blockHandle.id = 'block-handle';
    blockHandle.textContent = '⋮⋮';
    blockHandle.setAttribute('aria-hidden', 'true');
    document.body.appendChild(blockHandle);
    blockHandle.addEventListener('mousedown', DragReorder.onHandleDown);
    blockHandle.addEventListener('mouseenter', function () { blockHandleKeep = true; });
    blockHandle.addEventListener('mouseleave', function () { blockHandleKeep = false; });
    return blockHandle;
  }

  return {
    positionBlockHandle: positionBlockHandle,
    setHandleBlock: setHandleBlock,
    hideBlockHandle: hideBlockHandle,
    ensureBlockHandle: ensureBlockHandle
  };
  })();

  var DragReorder = (function dragReorderModule() {
  /* ---------- 拖拽重排（指针事件，不依赖 HTML5 DnD） ---------- */

  function onHandleDown(event) {
    if (event.button !== 0)
      return;
    // 手柄不参与选字与聚焦：块保持原状，拖拽与菜单都由这里接管
    event.preventDefault();
    if (!blockHandleTarget || ViewState.mode() === 'source')
      return;
    BlockHandle.ensureBlockHandle();
    dragPending = { x: event.clientX, y: event.clientY };
    document.addEventListener('mousemove', onHandleMove, true);
    document.addEventListener('mouseup', onHandleUp, true);
  }

  function onHandleMove(event) {
    if (!dragPending)
      return;
    if (!blockDrag) {
      if (Math.abs(event.clientY - dragPending.y) < 4 && Math.abs(event.clientX - dragPending.x) < 4)
        return;
      blockDrag = blockHandleTarget;
      if (!blockDrag || blockDrag.parentNode !== root) {
        dragPending = null;
        return;
      }
      EditingSnapshot.commitHistory();   // 拖拽前的块序固定为一个撤销步骤
      blockDrag.classList.add('block-dragging');
      BlockMenu.closeBlockMenu();
      blockHandle.style.display = 'none';
    }
    event.preventDefault();
    InsertLine.positionInsertLine(InsertLine.blockDropRef(event.clientY));
    // 拖到视口上下边缘时自动滚动，长文档也能一路拖到底
    if (event.clientY < 40)
      window.scrollBy(0, -14);
    else if (event.clientY > window.innerHeight - 40)
      window.scrollBy(0, 14);
  }

  function onHandleUp(event) {
    document.removeEventListener('mousemove', onHandleMove, true);
    document.removeEventListener('mouseup', onHandleUp, true);
    if (blockDrag) {
      var ref = InsertLine.blockDropRef(event.clientY);
      var moved = false;
      if (ref) {
        if (ref !== blockDrag.nextElementSibling) {
          root.insertBefore(blockDrag, ref);
          moved = true;
        }
      } else if (root.lastElementChild !== blockDrag) {
        root.appendChild(blockDrag);
        moved = true;
      }
      blockDrag.classList.remove('block-dragging');
      blockDrag = null;
      if (insertLine)
        insertLine.style.display = 'none';
      if (moved)
        Menus.afterBlockStructureChange();
      BlockHandle.positionBlockHandle();
    } else if (dragPending && blockHandleTarget) {
      // 没有位移 = 单击：在手柄下方弹出块菜单
      var r = blockHandle.getBoundingClientRect();
      BlockMenu.openBlockMenu(blockHandleTarget, r.left, r.bottom + 4);
    }
    dragPending = null;
  }

  return {
    onHandleDown: onHandleDown,
    onHandleUp: onHandleUp
  };
  })();

  var BlockMenu = (function blockMenuModule() {
  /* ---------- 块菜单 ---------- */

  function closeBlockMenu() {
    MenuOverlay.removeMenu(blockMenu);
    blockMenu = null;
    blockMenuTarget = null;
  }

  function openBlockMenu(block, x, y) {
    if (!block || ViewState.mode() === 'source')
      return;
    Menus.closeTurnMenu();
    Menus.closeSlash(false);
    closeBlockMenu();
    blockMenuTarget = block;
    blockMenu = document.createElement('div');
    blockMenu.id = 'block-menu';
    var html = '';
    html += '<div class="turn-item" data-act="above">在上方插入</div>';
    html += '<div class="turn-item" data-act="below">在下方插入</div>';
    html += '<div class="turn-item" data-act="duplicate">复制副本</div>';
    html += '<div class="turn-item" data-act="delete">删除</div>';
    html += '<div class="turn-sep"></div>';
    html += '<div class="turn-title">转为</div>';
    Menus.TURN_ITEMS.forEach(function (item) {
      html += '<div class="turn-item" data-key="' + item.key + '">' + Util.escapeHtml(item.label) + '</div>';
    });
    blockMenu.innerHTML = html;
    // 按下不抢焦点、不动选区（与 turn-menu 同一处理）；动作在 mouseup 派发
    blockMenu.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    blockMenu.addEventListener('mouseup', function (event) {
      var hit = event.target.closest ? event.target.closest('.turn-item') : null;
      if (!hit)
        return;
      event.preventDefault();
      var target = blockMenuTarget;
      var act = hit.getAttribute('data-act');
      var key = hit.getAttribute('data-key');
      closeBlockMenu();
      if (!target || !target.parentNode)
        return;
      if (act === 'above')
        BlockMenuActions.insertBlockNear(target, true);
      else if (act === 'below')
        BlockMenuActions.insertBlockNear(target, false);
      else if (act === 'duplicate')
        BlockMenuActions.duplicateBlock(target);
      else if (act === 'delete')
        BlockMenuActions.removeBlock(target);
      else if (key)
        BlockMenuActions.turnBlockTo(target, key);
    });
    MenuOverlay.placeMenu(blockMenu, { left: x, top: y, bottom: y, right: x });
  }

  return {
    closeBlockMenu: closeBlockMenu,
    openBlockMenu: openBlockMenu
  };
  })();

  var BlockMenuActions = (function blockMenuActionsModule() {
  /* ---------- 块菜单动作 ---------- */

  function insertBlockNear(block, above) {
    if (!block || !block.parentNode)
      return;
    EditingSnapshot.commitHistory();
    var el = Menus.makeBlockEl('');
    if (above)
      root.insertBefore(el, block);
    else
      root.insertBefore(el, block.nextSibling);
    Menus.afterBlockStructureChange();
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
    var el = Menus.makeBlockEl(BlockParse.rawOf(block));
    root.insertBefore(el, block.nextSibling);
    Menus.afterBlockStructureChange();
  }

  function removeBlock(block) {
    if (!block || !block.parentNode)
      return;
    EditingSnapshot.commitHistory();
    if (BlockParse.blockList().length <= 1) {
      // 最后一块不删结构：清空内容，保持可编辑；清空后的状态也要落一步，
      // 否则撤销会直接跳过这一步回到更早的历史，内容找不回来
      BlockParse.applyRawToBlock(block, '', 0, 0, true);
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
    Menus.afterBlockStructureChange();
    if (focusEl) {
      focusEl.classList.add('editing');
      focusEl.focus();
      // 偏移必须按 raw 口径给：代码块的 textContent 不含围栏，直接给
      // textContent.length 会被换算成块首而不是块尾
      CaretEdit.placeBlockCaret(focusEl, BlockParse.rawOf(focusEl).length);
    }
  }

  function turnBlockTo(block, key) {
    var type = { h1: 'h1', h2: 'h2', h3: 'h3', paragraph: 'p',
      ul: 'ul', ol: 'ol', quote: 'quote', codeBlock: 'code' }[key];
    if (!type || !block || !block.parentNode)
      return;
    EditingSnapshot.commitHistory();
    var raw = BlockParse.rawOf(block);
    var before = BlockParse.kindOfRaw(raw);
    var next = BlockParse.convertRaw(raw, type, false);
    // 与 convertBlocks 同口径：列表/引用/表格/代码转正文逐行拆回独立段落，
    // 不在一个块里塞硬换行
    if (type === 'p' && (before === 'ul' || before === 'ol' || before === 'quote' ||
                         before === 'table' || before === 'code')) {
      var lines = BlockParse.contentOfRaw(raw, before).replace(/\n+$/, '').split('\n');
      if (lines.length > 1) {
        BlockParse.applyRawToBlock(block, lines[0], lines[0].length, lines[0].length, true);
        var anchor = block;
        for (var li = 1; li < lines.length; li++) {
          BlockConvert.insertBlockAfter(anchor, lines[li], lines[li].length);
          anchor = anchor.nextElementSibling;
        }
        Menus.normalizeBlockGaps();
        Toc.scheduleTocRefresh();
        EditingSnapshot.commitHistory();   // 拆分合成一个撤销步
        return;
      }
    }
    BlockParse.applyRawToBlock(block, next, next.length, next.length, true);
    setTimeout(EditingSnapshot.commitHistory, 0);
  }

  return {
    insertBlockNear: insertBlockNear,
    duplicateBlock: duplicateBlock,
    removeBlock: removeBlock,
    turnBlockTo: turnBlockTo
  };
  })();

  (function hoverFocusScrollModule() {
  /* ---------- 悬停 / 焦点 / 滚动联动 ---------- */

  document.addEventListener('mousemove', function (event) {
    if (blockDrag)
      return;
    var t = event.target;
    if (blockHandle && blockHandle.contains(t)) {
      blockHandleKeep = true;
      return;
    }
    if (blockMenu && blockMenu.contains(t))
      return;
    if (ViewState.mode() === 'source' || !root.contains(t)) {
      BlockHandle.hideBlockHandle();
      return;
    }
    var el = CaretCode.blockOf(t);
    if (el) {
      BlockHandle.ensureBlockHandle();
      BlockHandle.setHandleBlock(el);
    }
  });

  document.addEventListener('mouseleave', function (event) {
    // 拖拽中指针移出窗口时 mouseup 不会送达：按当前位置落块收尾，
    // 否则 blockDrag 卡住，手柄与指示线都会悬死
    if (blockDrag && dragPending) {
      DragReorder.onHandleUp(event);
      return;
    }
    BlockHandle.hideBlockHandle();
  });

  root.addEventListener('focusin', function (event) {
    var el = CaretCode.blockOf(event.target);
    if (el) {
      BlockHandle.ensureBlockHandle();
      BlockHandle.setHandleBlock(el);
    }
  });

  window.addEventListener('scroll', function () {
    if (blockDrag)
      return;
    BlockHandle.positionBlockHandle();
    BlockMenu.closeBlockMenu();
  }, true);

  window.addEventListener('resize', function () {
    BlockHandle.positionBlockHandle();
    BlockMenu.closeBlockMenu();
  });
  })();

  function reset() {
    blockHandleTarget = null;
    if (blockHandle)
      blockHandle.style.display = 'none';
  }

  // 点外关闭块菜单时，手柄自身也算「菜单区域」：手柄按下会弹菜单
  function containsNode(target) {
    return !!((blockMenu && blockMenu.contains(target))
      || (blockHandle && blockHandle.contains(target)));
  }

  function isBlockMenuOpen() {
    return !!blockMenu;
  }

  return {
    blockDropRef: InsertLine.blockDropRef,
    positionInsertLine: InsertLine.positionInsertLine,
    positionBlockHandle: BlockHandle.positionBlockHandle,
    setHandleBlock: BlockHandle.setHandleBlock,
    hideBlockHandle: BlockHandle.hideBlockHandle,
    ensureBlockHandle: BlockHandle.ensureBlockHandle,
    onHandleDown: DragReorder.onHandleDown,
    onHandleUp: DragReorder.onHandleUp,
    closeBlockMenu: BlockMenu.closeBlockMenu,
    openBlockMenu: BlockMenu.openBlockMenu,
    insertBlockNear: BlockMenuActions.insertBlockNear,
    duplicateBlock: BlockMenuActions.duplicateBlock,
    removeBlock: BlockMenuActions.removeBlock,
    turnBlockTo: BlockMenuActions.turnBlockTo,
    reset: reset,
    containsNode: containsNode,
    isBlockMenuOpen: isBlockMenuOpen
  };
  })();
