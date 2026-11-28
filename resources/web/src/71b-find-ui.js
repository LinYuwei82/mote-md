  var FindUi = (function findUiModule() {
  function scheduleFind() {
    if (findTimer)
      clearTimeout(findTimer);
    findTimer = setTimeout(function () {
      findTimer = 0;
      if (findInput)
        findScan(findInput.value);
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
        replaceCurrent();
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
      goFind(event.shiftKey ? -1 : 1);
    });
    document.getElementById('find-prev').addEventListener('click', function () { goFind(-1); });
    document.getElementById('find-next').addEventListener('click', function () { goFind(1); });
    document.getElementById('find-replace-one').addEventListener('click', replaceCurrent);
    document.getElementById('find-replace-all').addEventListener('click', replaceAll);
    document.getElementById('find-close').addEventListener('click', function () { closeFind(); });
  }

  function openFind() {
    if (findBar)
      return;
    // 查找条打开后焦点交给查找框，覆盖层选区先收起
    clearCrossSelection();
    findInSource = mode === 'source';
    if (findInSource) {
      findCaret = { source: true, start: sourceEl.selectionStart, end: sourceEl.selectionEnd };
    } else {
      var block = document.activeElement ? blockOf(document.activeElement) : null;
      // 关掉查找栏时走 placeBlockCaret（原文口径），这里也按原文口径取
      findCaret = block ? { block: block, offset: rawCaretOffset(block) } : null;
    }
    findJumped = null;

    buildFindBar();
    findBar.style.display = 'flex';
    findInput.focus();

    var picked = '';
    if (findInSource) {
      if (sourceEl.selectionEnd > sourceEl.selectionStart)
        picked = sourceEl.value.slice(sourceEl.selectionStart, sourceEl.selectionEnd);
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
    findScan(findInput.value);
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
    dropFindLayer();
    if (findBar && findBar.parentNode)
      findBar.parentNode.removeChild(findBar);
    findBar = findInput = findReplace = findCount = findNote = null;

    if (inSource) {
      sourceEl.focus();
      var target = jumped && jumped.source ? jumped : caret;
      if (target) {
        try {
          sourceEl.setSelectionRange(target.start, target.end === undefined ? target.start : target.end);
        } catch (error) { /* ignore */ }
        scrollSourceTo(target.start);
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
      selection.addRange(findSelectRange(jumped));
    } else if (caret && caret.block && caret.block.isConnected) {
      // 没跳转过：回到打开查找前的光标位置
      if (document.activeElement !== caret.block)
        caret.block.focus();
      placeBlockCaret(caret.block, caret.offset);
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
      goFind(event.shiftKey ? -1 : 1);
    }
  }, true);

  // 覆盖层是文档绝对坐标：只有代码块内部横向滚动会改变几何而不改变文档滚动量。
  // 窗口缩放会让绝对坐标失配，也重画一次。
  document.addEventListener('scroll', function (event) {
    if (!findLayer || !findMatches.length)
      return;
    if (event.target && event.target.closest && event.target.closest('.code-scroll'))
      paintFind();
  }, true);

  window.addEventListener('resize', function () {
    if (findLayer && findMatches.length)
      paintFind();
    // 覆盖层是文档绝对坐标，缩放/换行变化后必须按新几何重画
    if (crossSel)
      paintCrossSelection();
  });

  // 命中的块里图片晚一步解码完、字体替换完成时块高会变，但都不触发 resize。
  // load 不冒泡，必须用捕获阶段才能收到 <img> 的加载完成。
  document.addEventListener('load', function (event) {
    var target = event.target;
    if (target && target.nodeName === 'IMG') {
      scheduleFindPaint();
      if (crossSel)
        paintCrossSelection();
    }
  }, true);

  if (document.fonts) {
    if (document.fonts.ready && document.fonts.ready.then)
      document.fonts.ready.then(function () {
        scheduleFindPaint();
        if (crossSel)
          paintCrossSelection();
      });
    if (document.fonts.addEventListener)
      document.fonts.addEventListener('loadingdone', function () {
        scheduleFindPaint();
        if (crossSel)
          paintCrossSelection();
      });
  }

  window.addEventListener('scroll', function () {
    if (!tocVisible || mode !== 'wysiwyg' || spyScheduled)
      return;
    spyScheduled = true;
    requestAnimationFrame(function () {
      spyScheduled = false;
      updateActiveHeading();
    });
  });

  // 视口或字号变化后标题纵坐标失效，下一次滚动高亮时重算
  window.addEventListener('resize', function () { tocTops = null; });

  if (tocList) {
    tocList.addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('.toc-item') : null;
      if (!node)
        return;
      event.preventDefault();
      var item = tocItems[Number(node.getAttribute('data-toc'))];
      if (!item)
        return;
      item.el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -16);
      updateActiveHeading();
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
      postImageFile(file, 'drop');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      post({ type: 'drop', name: file.name, text: String(reader.result) });
    };
    reader.readAsText(file);
  });

  return {
    scheduleFind: scheduleFind,
    closeFind: closeFind
  };
  })();

  var scheduleFind = FindUi.scheduleFind;
  var closeFind = FindUi.closeFind;
