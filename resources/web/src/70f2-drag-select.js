  // 在冒泡阶段记录锚点：块内的特殊按下（徽标、行号栏、表格格线）已经
  // preventDefault，不能再起拖选
  document.addEventListener('mousedown', function (event) {
    dragCross = null;
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey
        || mode !== 'wysiwyg')
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    var hit = crossHitAt(event.clientX, event.clientY);
    if (!hit || hit.el !== el)
      return;
    dragCross = {
      anchor: hit.abs,
      el: el,
      x: event.clientX,
      y: event.clientY,
      goalX: event.clientX
    };
  });

  document.addEventListener('mousemove', function (event) {
    if (!dragCross || event.buttons !== 1)
      return;
    updateCrossDrag(event.clientX, event.clientY);
  });

  document.addEventListener('mouseup', function () {
    if (!dragCross)
      return;
    dragCross = null;
    stopDragScroll();
  });

  root.addEventListener('keydown', function (event) {
    var el = blockOf(event.target);
    if (!el)
      return;

    // 组合输入（中文等）期间按键属于输入法：方向键选候选、回车/Esc 上屏或取消，
    // 一个都不能被下面的浮层或块级逻辑吃掉。判断必须放在最前面。
    if (composing)
      return;

    // 斜杠浮层打开时先吃掉导航键：上下选择、Enter/Tab 插入、Esc 删除已输入的 /
    if (slashState) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSlash(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertSlashItem();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        slashState.end = caretOffset(slashState.el);
        closeSlash(true);
        return;
      }
    }

    // 跨块选区（原型）：编辑键先在整篇源码上生效，避免落到折叠光标上只改一个字符
    var plainKeys = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (crossSel) {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        replaceCrossSelection('');
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceCrossSelection('\n');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clearCrossSelection();
        return;
      }
    }

    // Shift+↑/↓ 扩展选区：块首/块尾升级为跨块选区，之后由覆盖层显示
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && event.shiftKey && plainKeys
        && extendCrossSelection(el, event.key === 'ArrowUp')) {
      event.preventDefault();
      return;
    }

    // Shift+←/→ 跨块：块首/块尾或已有跨块选区时逐字扩展，其余交回原生
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        && event.shiftKey && plainKeys
        && extendCrossSelectionHorizontal(el, event.key === 'ArrowLeft')) {
      event.preventDefault();
      return;
    }

    // 横向/翻页/制表键会让原生选区离开覆盖层范围：先收起，交回原生。
    // 普通字符键不能在这里清除：输入要经过 beforeinput 才能按整篇源码替换选区。
    if (crossSel && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                     || event.key === 'Home' || event.key === 'End'
                     || event.key === 'PageUp' || event.key === 'PageDown'
                     || event.key === 'Tab'
                     || ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey)))
      clearCrossSelection();

    // 上下方向键跨块：只在块首/块尾接管，块内与表格/代码块内部导航保持原生。
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      var navSelection = window.getSelection();
      if (navSelection && navSelection.rangeCount
          && navSelection.getRangeAt(0).collapsed
          && el.contains(navSelection.getRangeAt(0).startContainer)
          && moveCaretAcrossBlock(el, event.key === 'ArrowUp')) {
        event.preventDefault();
        return;
      }
    }

    // 原生跨块选区上的退格/删除先接管（全选删除不能是死键）
    if ((event.key === 'Backspace' || event.key === 'Delete')
        && !event.metaKey && !event.ctrlKey && deleteNativeCrossSelection()) {
      event.preventDefault();
      return;
    }

    var inTable = el.classList.contains('table');

    if (inTable && event.key === 'Tab') {
      event.preventDefault();
      moveTableCell(el, event.shiftKey ? -1 : 1);
      return;
    }

    if (inTable && event.key === 'Enter') {
      // Cmd/Ctrl+Enter 在当前行下方加一行、加 Shift 在上方加一行（光标落新行
      // 同列首格）；裸回车既不新增行也不插入换行，避免一次误触改掉表格结构。
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && !event.altKey)
        insertTableRow(el, !event.shiftKey);
      return;
    }

    if (inTable && (event.key === 'Backspace' || event.key === 'Delete')) {
      var tableSel = window.getSelection();
      if (tableSel.rangeCount && !tableSel.getRangeAt(0).collapsed
          && rangeCrossesCells(el, tableSel.getRangeAt(0))) {
        event.preventDefault();
        clearSelectedCellText(el, tableSel.getRangeAt(0));
        return;
      }
      if (atCellEdge(el, event.key === 'Backspace', event))
        return;
    }

    if (INLINE_PROTO && (event.key === 'Backspace' || event.key === 'Delete')) {
      var backward = event.key === 'Backspace';
      var neighbour = markerAdjacent(el, backward ? -1 : 1);
      if (neighbour) {
        event.preventDefault();
        // 块内行首退格：换行标记右侧退格 = 并入上一行，不能只是跨过标记
        if (backward && neighbour.classList.contains('mk-nl')) {
          joinPrevLine(el);
          return;
        }
        // 标记不可见：直接删掉它另一侧同一行内的可见字符，而不是把光标停在
        // 标记边上（那样看起来像没反应）。跨行/跨列表项时退回“跨过标记”。
        var caret = window.getSelection().getRangeAt(0);
        var prefix = neighbour.classList.contains('mk-head')
          || neighbour.classList.contains('mk-bullet')
          || neighbour.classList.contains('mk-quote');
        if (!prefix && deleteVisibleChar(el, caret, backward, neighbour))
          return;
        collapseAt(neighbour, backward);
        return;
      }
      // 标记在光标前方挡住原生删除时，自己删掉光标另一侧的可见字符。
      // 删不动也必须 preventDefault：原生删除会紧贴着 contenteditable=false
      // 的原子对象执行，可能把它或相邻结构一起带走。
      var blocking = markerAdjacent(el, backward ? 1 : -1);
      if (blocking) {
        event.preventDefault();
        var range = window.getSelection().getRangeAt(0);
        // 光标在块最前、挡住删除的是结构前缀标记（标题 # / 列表项符 / 引用 >）：
        // 块首没有可见字符可删，退格不能成死键。上一块同类型就合并，
        // 否则剥掉前缀还原成正文（再按一次退格即可与上一段相接）。
        if (backward && caretOffset(el) === 0 &&
            (blocking.classList.contains('mk-head') || blocking.classList.contains('mk-bullet') ||
             blocking.classList.contains('mk-quote'))) {
          var prevBlock = el.previousElementSibling;
          if (prevBlock && prevBlock.classList.contains('block') && blockType(prevBlock) === blockType(el))
            mergeBack(el);
          else {
            var blockRaw = rawOf(el);
            commitHistory();
            applyRawToBlock(el, contentOfRaw(blockRaw, kindOfRaw(blockRaw)), 0, 0, true);
            setTimeout(commitHistory, 0);
          }
          return;
        }
        deleteVisibleChar(el, range, backward, blocking);
        return;
      }
    }

    if (INLINE_PROTO && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // 正常方向键会跳过零宽原子；只有程序化选区落进标记内部时才需要纠正。
      var inside = caretInsideMarker();
      if (inside) {
        event.preventDefault();
        collapseAt(inside, event.key === 'ArrowLeft');
        return;
      }
      // 块首（或行首）紧贴不可编辑原子对象时，WebKit 的左/右箭头会原地不动，
      // 光标看起来“卡”在折叠标记边上。这里显式跨过紧贴光标的标记。
      var adjacent = markerAdjacent(el, event.key === 'ArrowLeft' ? -1 : 1);
      if (adjacent) {
        event.preventDefault();
        collapseAt(adjacent, event.key === 'ArrowLeft');
        return;
      }
    }

    if (event.key === 'Enter') {
      if (isCodeBlock(el)) {
        // 代码块里的回车只加一行，不切块；Shift+Enter 同样按换行处理
        event.preventDefault();
        if (insertCodeText(el, '\n')) {
          scheduleDirty();
          scheduleCommit();
        }
        return;
      }
      if (el.classList.contains('hr')) {
        // 分割线没有可拆的文本：直接走 splitBlock 会把 --- 变成两个空段，
        // 分割线凭空消失。回车应在其后插入一个空正文块，分割线留在原地。
        event.preventDefault();
        commitHistory();
        insertBlockAfter(el, '', 0);
        commitHistory();
        scheduleDirty();
        return;
      }
      if (!event.shiftKey) {
        event.preventDefault();
        splitBlock(el);
        return;
      }
    }

    // 表格单元格外没有“块首”这个概念：光标停在首格行首时不能把整张表并进
    // 上一段（caretOffset(el) 会恰好等于 0）。
    if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !inTable
        && caretOffset(el) === 0) {
      var prevSib = el.previousElementSibling;
      if (prevSib && prevSib.classList.contains('block')) {
        event.preventDefault();
        mergeBack(el);
        return;
      }
      // 首块是结构块（无上一块可并）：块首退格剥前缀还原正文，避免死键
      if (!prevSib) {
        var kind1 = blockType(el);
        if (kind1 === 'ul' || kind1 === 'ol' || kind1 === 'quote'
            || kind1 === 'code' || kind1.charAt(0) === 'h') {
          event.preventDefault();
          commitHistory();
          applyRawToBlock(el, contentOfRaw(rawOf(el), kind1), 0, 0, true);
          setTimeout(commitHistory, 0);
          return;
        }
      }
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey)
        outdentCurrentLine(el);
      else
        indentCurrentLine(el);
    }
  }, true);

  /* ---------------- 图片：粘贴 / 拖入 ----------------
     页面拿不到文件真实路径（WebKit 安全限制），所以图片一律以 base64 交给原生层，
