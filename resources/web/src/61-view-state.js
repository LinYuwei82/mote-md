  var ViewState = (function viewStateModule() {
  /* ---------------- 缩放与视图状态 ---------------- */

  function applyZoom() {
    document.documentElement.style.fontSize = (16.5 * zoomLevel).toFixed(2) + 'px';
  }

  // 主题只切换 CSS 变量（data-theme），不触碰 DOM 内容与尺寸：
  // 正文、代码高亮、目录、查找、浮层、状态栏颜色都走同一套变量。
  function setTheme(mode) {
    var el = document.documentElement;
    if (mode === 'dark' || mode === 'light')
      el.setAttribute('data-theme', mode);
    else
      el.removeAttribute('data-theme');
  }

  function clampZoom(value) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value * 100) / 100));
  }

  function setZoom(value) {
    var next = clampZoom(value);
    if (next === zoomLevel)
      return;
    zoomLevel = next;
    applyZoom();
    scheduleFindPaint();
    postView();
  }

  function postView() {
    post({
      type: 'view',
      toc: tocVisible,
      source: mode === 'source',
      zoom: zoomLevel
    });
  }

  function currentCaretOffset() {
    if (mode === 'source')
      return sourceEl.selectionStart;
    var el = blockOf(document.activeElement);
    if (!el || !el.classList.contains('editing'))
      return 0;
    var blocks = collectBlocks();
    return absoluteOffsets(blocks, editingSelection()).start;
  }

  function setMode(next) {
    if (next === mode)
      return;
    // 自建跨块选区只在渲染态有效：切模式前先收起覆盖层
    clearCrossSelection();
    // 查找/替换绑定当前模式的命中（DOM 区间或 textarea 区间），切模式前先关掉
    if (findBar)
      closeFind();
    closeLangMenu();
    // 块手柄与块菜单是渲染态浮层：切到源码模式必须一并收起，
    // 否则菜单悬空且动作会作用到即将被重建的旧 DOM 上
    closeBlockMenu();
    if (blockHandle)
      blockHandle.style.display = 'none';
    blockHandleTarget = null;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    commitHistory();

    var text = currentSource();
    var caret = currentCaretOffset();

    suppressEvents = true;
    if (next === 'source') {
      mode = 'source';
      sourceEl.value = text;
      document.body.classList.add('source-mode');
      suppressEvents = false;
      try {
        sourceEl.focus();
        sourceEl.setSelectionRange(Math.min(caret, text.length), Math.min(caret, text.length));
      } catch (error) { /* ignore */ }
    } else {
      mode = 'wysiwyg';
      var layout = splitSourceLayout(text);
      var blocks = layout.blocks;
      mountBlocks(blocks, layout.gaps, layout.trail);
      document.body.classList.remove('source-mode');
      suppressEvents = false;

      var base = 0;
      for (var i = 0; i < blocks.length; i++) {
        base += gapBefore(layout.gaps, i);
        var stop = base + blocks[i].length;
        if (caret <= stop || i === blocks.length - 1) {
          var target = root.children[i];
          if (target) {
            if (inPlaceEditable(target)) {
              renderBlock(target, blocks[i]);
              target.classList.add('editing');
              target.focus();
              var rel = Math.max(0, caret - base);
              placeBlockCaret(target, rel, rel);
            } else {
              target.classList.add('editing');
              target.textContent = blocks[i];
              target.focus();
              setSelectionRange(target, Math.max(0, Math.min(caret - base, blocks[i].length)));
            }
          }
          break;
        }
        base = stop;
      }
    }

    // 同一份文本：这里只同步选区，不会新增撤销步骤
    commitHistory();
    scheduleDirty();
    refreshToc();
    postView();
  }

  return {
    applyZoom: applyZoom,
    setTheme: setTheme,
    setZoom: setZoom,
    postView: postView,
    setMode: setMode
  };
  })();

  var applyZoom = ViewState.applyZoom;
  var setTheme = ViewState.setTheme;
  var setZoom = ViewState.setZoom;
  var postView = ViewState.postView;
  var setMode = ViewState.setMode;
