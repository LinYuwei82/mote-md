  /* ---------------- DOM 事件 ---------------- */

  // 点击渲染态时记录光标大致位置，切到源码态后尽量落在同一处
  document.addEventListener('mousedown', function (event) {
    // 任何一次按下都结束自建跨块选区：原生选区接管，覆盖层不能残留
    clearCrossSelection();
    var el = blockOf(event.target);
    if (!el || !document.caretRangeFromPoint) {
      pendingOffset = null;
      return;
    }

    // 语言徽标：单击打开语言选择器，不进入代码编辑态。捕获阶段 preventDefault
    // 后原生不会把焦点/光标挪进徽标；下拉挂在 body 上，不受代码块 overflow 影响。
    var badgeHit = isCodeBlock(el) && event.target.closest
      ? event.target.closest('.code-lang') : null;
    if (badgeHit) {
      event.preventDefault();
      pendingOffset = null;
      openLangMenu(el, badgeHit);
      return;
    }

    // 行号栏不可编辑：点它时把光标放到同一行的代码行首，绝不让光标落进栏里
    // （否则接下来的输入会写进行号栏或 <pre> 外层，结构会坏）。
    var gutter = isCodeBlock(el) && event.target.closest ? event.target.closest('.gutter') : null;
    if (gutter) {
      event.preventDefault();
      var code = codeEl(el);
      if (!code)
        return;
      var offset = codeLineStart(code, gutterLineAt(gutter, event.clientY));
      if (el.classList.contains('editing')) {
        setSelectionRange(code, offset);
      } else {
        pendingOffset = offset;
        el.focus();
      }
      return;
    }

    // 表格：点在格线、边框或格内标记上时，光标必须收回单元格里
    if (INLINE_PROTO && el.classList.contains('table')) {
      var tableHit = document.caretRangeFromPoint(event.clientX, event.clientY);
      var hitNode = tableHit ? tableHit.startContainer : null;
      var hitParent = hitNode ? (hitNode.nodeType === 1 ? hitNode : hitNode.parentNode) : null;
      var cell = hitParent && hitParent.closest ? hitParent.closest('th,td') : null;
      if (cell && cell.closest('.tbl-align'))
        cell = null;
      if (!cell) {
        var nearest = cellFromPoint(el, event.clientX, event.clientY);
        if (nearest) {
          event.preventDefault();
          if (!el.classList.contains('editing')) {
            pendingOffset = null;
            el.focus();
          }
          caretInCellEnd(nearest);
        }
        return;
      }
    }

    // 分隔线：点到横线本身（而不是叠在上面的原文）时，光标放回原文行尾
    if (INLINE_PROTO && el.classList.contains('hr') && el.classList.contains('editing')) {
      var hrSrc = el.querySelector('.hr-src');
      var hrHit = document.caretRangeFromPoint(event.clientX, event.clientY);
      var inSource = hrSrc && hrHit
        && (hrSrc === hrHit.startContainer || hrSrc.contains(hrHit.startContainer));
      if (hrSrc && !inSource) {
        event.preventDefault();
        caretAtEdge(hrSrc, false);
        return;
      }
    }

    if (el.classList.contains('editing')) {
      // 代码块已经在编辑态时，点在块内空白处（行号栏右侧、代码下方）可能让
      // 光标落到 <pre>/块外，后续输入会写坏结构：这里把光标收回 <code> 末尾。
      if (isCodeBlock(el) && document.caretRangeFromPoint) {
        var inner = codeEl(el);
        var hitRange = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (inner && hitRange && hitRange.startContainer !== inner
            && !inner.contains(hitRange.startContainer)) {
          event.preventDefault();
          setSelectionRange(inner, inner.textContent.length);
        }
      }
      pendingOffset = null;
      return;
    }
    var range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (!range) {
      pendingOffset = null;
      return;
    }
    // 代码块只统计 <code> 正文，行号栏的数字不能算进偏移
    var scope = isCodeBlock(el) ? codeEl(el) : el;
    if (!scope) {
      pendingOffset = null;
      return;
    }
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch (error) {
      pendingOffset = null;
      return;
    }
    pendingOffset = prefix.toString().length;
  }, true);

  root.addEventListener('focusin', function (event) {
    if (composing || suppressEvents)
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    enterEdit(el);
  });

  root.addEventListener('focusout', function (event) {
    if (suppressEvents)
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    if (event.relatedTarget && el.contains(event.relatedTarget))
      return;
    leaveEdit(el);
  });

  // 任务复选框：按下时阻止聚焦与选区折叠，点击只切换该行的勾选标记。
  root.addEventListener('mousedown', function (event) {
    var box = event.target;
    // 复制按钮不抢焦点：preventDefault 后选区/光标都留在原处，既不会把代码块
    // 切进编辑态，也不会触发 focusin 里的编辑流程。
    if (box && box.closest && box.closest('.code-copy')) {
      event.preventDefault();
      return;
    }
    if (box && box.classList && box.classList.contains('task-check'))
      event.preventDefault();
  });

  root.addEventListener('click', function (event) {
    var target = event.target;
    var copyBtn = target && target.closest ? target.closest('.code-copy') : null;
    if (copyBtn) {
      event.preventDefault();
      copyCodeBlock(copyBtn);
      return;
    }
    var anchor = target && target.closest ? target.closest('a.md-link') : null;
    if (anchor) {
      // 链接永远不让 WebView 自己导航：普通点击只落到「进入编辑」，
      // Cmd/Ctrl+Click 交给外壳决定（浏览器 / 应用内打开 .md）。
      event.preventDefault();
      var href = anchor.getAttribute('data-href') || anchor.getAttribute('href') || '';
      // 文档内锚点自己跳，不交给外壳：外壳没有标题锚点，只会提示「暂不支持」
      if (href.charAt(0) === '#') {
        if (!scrollToAnchor(href))
          post({ type: 'status', message: '锚点链接 ' + href + ' 未找到对应标题' });
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        post({ type: 'openLink', href: href });
      }
      return;
    }
    var box = target;
    if (!box || !box.classList || !box.classList.contains('task-check'))
      return;
    event.preventDefault();
    toggleTaskCheckbox(box);
  });

  root.addEventListener('input', function (event) {
    if (suppressEvents)
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    if (findBar)
      scheduleFind();
    if (isCodeBlock(el)) {
      // 徽标被原生删除（整块选中后删除）：语义等于清空语言，补回空徽标，
      // 用户可再点开选择器重选；徽标不可编辑，光标放回正文首行。
      if (!el.querySelector('.code-lang')) {
        el.dataset.lang = '';
        el.dataset.raw = codeRaw(el);
        var revived = ensureLangBadge(el);
        var codeStart = codeEl(el);
        if (revived && codeStart)
          setSelectionRange(codeStart, 0);
        scheduleDirty();
        scheduleCommit();
        return;
      }
      if (composing) {
        // 组合输入期间不重建 DOM（会打断输入法），只同步原文；结构等
        // compositionend 再一次性整理，光标位置交给输入法自己维护。
        el.dataset.raw = codeRaw(el, codeText(el));
        el._codeStale = true;
        return;
      }
      // 只重建 <code> 的行内 span，文本、字体、行高、宽度都不变；随后恢复光标
      syncCode(el, true);
      scheduleDirty();
      scheduleCommit();
      return;
    }
    if (composing)
      return;
    el.dataset.raw = el.textContent;
    updatePlaceholder();
    handleSlashInput(el);
    scheduleDirty();
    scheduleCommit();
    scheduleTocRefresh();
  });

  // 组合输入期间不落历史步骤，也不设置合并定时器；compositionend 时整段提交，
  // 这样中文候选上屏要么整体进入一步，要么整体回退，不会被切成多个碎片。
  root.addEventListener('compositionstart', function () {
    if (suppressEvents)
      return;
    // 组合输入不在原型范围，但也不能「选了却没删」：先按整篇源码删掉跨块选区，
    // 候选上屏就落在替换点上；若输入法因此中断，用户重新输入即可。
    if (crossSel)
      replaceCrossSelection('');
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    commitHistory();   // 组合输入前的已输入内容先单独成步
    composing = true;
  });

  root.addEventListener('compositionend', function (event) {
    composing = false;
    var el = blockOf(event.target);
    if (el) {
      if (isCodeBlock(el))
        syncCode(el, true);   // 上屏后补一次着色，会话期间没有动过 DOM 结构
      else
        el.dataset.raw = el.textContent;
      scheduleDirty();
    }
    commitHistory();   // 上屏内容整体作为一步
  });

  // 源码模式：textarea 自己的原生撤销也会被 beforeinput 拦下，统一走自建栈
  sourceEl.addEventListener('input', function () {
    if (suppressEvents)
      return;
    if (findBar)
      scheduleFind();
    scheduleDirty();
    scheduleCommit();
    scheduleTocRefresh();
  });

  sourceEl.addEventListener('compositionstart', function () {
    if (suppressEvents)
      return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    commitHistory();
    composing = true;
  });

  sourceEl.addEventListener('compositionend', function () {
    composing = false;
    commitHistory();
  });

  sourceEl.addEventListener('paste', function (event) {
    var clipboard = event.clipboardData || window.clipboardData;
    var picture = clipboard ? clipboardImageFile(clipboard) : null;
    if (picture) {
      // 源码态没有渲染节点：仍先落盘，由原生回调 insertImage 插到 textarea 光标处
      event.preventDefault();
      postImageFile(picture, 'paste');
      return;
    }
    commitHistory();
    setTimeout(commitHistory, 0);
  });

  // 撤销/重做挂到 document 上，未聚焦任何块时也能用；并拦住 WebKit 自带的
  // 原生撤销，避免和自建历史各走一套
  document.addEventListener('beforeinput', function (event) {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo')
      event.preventDefault();
    // 跨块选区上的输入：折叠光标只覆盖焦点一个字符，必须先按整篇源码替换区间
    if (crossSel && !suppressEvents && mode === 'wysiwyg') {
      if (event.inputType === 'insertText' && typeof event.data === 'string') {
        event.preventDefault();
        replaceCrossSelection(event.data);
        return;
      }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
        replaceCrossSelection('\n');
        return;
      }
      // 其余输入类型不由这里接管：先收起自建选区，避免原生操作折叠光标
      clearCrossSelection();
    }
    // 表格单元格内输入裸 |：转成转义的 \|，否则下次重排会被当成列分隔符、
    // 把整表撑出多余一列。渲染时 \| 显示为 |（反斜杠零宽），raw 保留转义。
    if (event.inputType === 'insertText' && event.data === '|' && !suppressEvents) {
      var el = blockOf(event.target);
      if (el && el.classList.contains('table') && activeCell(el)) {
        event.preventDefault();
        document.execCommand('insertText', false, '\\|');
      }
    }
  }, true);

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (composing)
        return;
      var key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey)
          redo();
        else
          undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        post({ type: 'save', text: currentSource() });
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        post({ type: 'open' });
        return;
      }
    }
  }, true);

