  var Composition = (function compositionHistoryModule() {
  // 组合输入期间不落历史步骤，也不设置合并定时器；compositionend 时整段提交，
  // 这样中文候选上屏要么整体进入一步，要么整体回退，不会被切成多个碎片。
  var composing = false;
  root.addEventListener('compositionstart', function () {
    if (suppressEvents)
      return;
    // 组合输入不在原型范围，但也不能「选了却没删」：先按整篇源码删掉跨块选区，
    // 候选上屏就落在替换点上；若输入法因此中断，用户重新输入即可。
    if (Cross.isActive())
      Cross.replaceCrossSelection('');
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    EditingSnapshot.commitHistory();   // 组合输入前的已输入内容先单独成步
    composing = true;
  });

  root.addEventListener('compositionend', function (event) {
    composing = false;
    var el = CaretCode.blockOf(event.target);
    if (el) {
      if (LayoutCode.isCodeBlock(el))
        CaretCode.syncCode(el, true);   // 上屏后补一次着色，会话期间没有动过 DOM 结构
      else
        el.dataset.raw = el.textContent;
      DocumentModel.scheduleDirty();
    }
    EditingSnapshot.commitHistory();   // 上屏内容整体作为一步
  });

  // 源码模式：textarea 自己的原生撤销也会被 beforeinput 拦下，统一走自建栈
  sourceEl.addEventListener('input', function () {
    if (suppressEvents)
      return;
    if (Find.isOpen())
      Find.scheduleFind();
    DocumentModel.scheduleDirty();
    EditingSnapshot.scheduleCommit();
    Toc.scheduleTocRefresh();
  });

  sourceEl.addEventListener('compositionstart', function () {
    if (suppressEvents)
      return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    EditingSnapshot.commitHistory();
    composing = true;
  });

  sourceEl.addEventListener('compositionend', function () {
    composing = false;
    EditingSnapshot.commitHistory();
  });

  sourceEl.addEventListener('paste', function (event) {
    var clipboard = event.clipboardData || window.clipboardData;
    var picture = clipboard ? ClipboardPaste.clipboardImageFile(clipboard) : null;
    if (picture) {
      // 源码态没有渲染节点：仍先落盘，由原生回调 insertImage 插到 textarea 光标处
      event.preventDefault();
      ClipboardPaste.postImageFile(picture, 'paste');
      return;
    }
    EditingSnapshot.commitHistory();
    setTimeout(EditingSnapshot.commitHistory, 0);
  });

  // 撤销/重做挂到 document 上，未聚焦任何块时也能用；并拦住 WebKit 自带的
  // 原生撤销，避免和自建历史各走一套
  document.addEventListener('beforeinput', function (event) {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo')
      event.preventDefault();
    // 跨块选区上的输入：折叠光标只覆盖焦点一个字符，必须先按整篇源码替换区间
    if (Cross.isActive() && !suppressEvents && mode === 'wysiwyg') {
      if (event.inputType === 'insertText' && typeof event.data === 'string') {
        event.preventDefault();
        Cross.replaceCrossSelection(event.data);
        return;
      }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
        Cross.replaceCrossSelection('\n');
        return;
      }
      // 其余输入类型不由这里接管：先收起自建选区，避免原生操作折叠光标
      Cross.clearCrossSelection();
    }
    // 表格单元格内输入裸 |：转成转义的 \|，否则下次重排会被当成列分隔符、
    // 把整表撑出多余一列。渲染时 \| 显示为 |（反斜杠零宽），raw 保留转义。
    if (event.inputType === 'insertText' && event.data === '|' && !suppressEvents) {
      var el = CaretCode.blockOf(event.target);
      if (el && el.classList.contains('table') && CellEdit.activeCell(el)) {
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
          EditingSnapshot.redo();
        else
          EditingSnapshot.undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        EditingSnapshot.redo();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        Util.post({ type: 'save', text: DocumentModel.currentSource() });
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        Util.post({ type: 'open' });
        return;
      }
    }
  }, true);

  return {
    isComposing: function () { return composing; }
  };
  })();
