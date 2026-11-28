  var ViewState = (function viewStateModule() {
  /* ---------------- 缩放与视图状态 ---------------- */

  var mode = 'wysiwyg';         // 'wysiwyg' | 'source'
  var zoomLevel = 1;            // 1 = 100%，基准 16.5px（≈ 旧版 16.5pt）

  function applyZoom() {
    document.documentElement.style.fontSize = (16.5 * zoomLevel).toFixed(2) + 'px';
  }

  // 主题只切换 CSS 变量（data-theme），不触碰 DOM 内容与尺寸：
  // 正文、代码高亮、目录、查找、浮层、状态栏颜色都走同一套变量。
  function setTheme(theme) {
    var el = document.documentElement;
    if (theme === 'dark' || theme === 'light')
      el.setAttribute('data-theme', theme);
    else
      el.removeAttribute('data-theme');
  }

  function clampZoom(value) {
    return Math.max(Config.ZOOM_MIN, Math.min(Config.ZOOM_MAX, Math.round(value * 100) / 100));
  }

  function setZoom(value) {
    var next = clampZoom(value);
    if (next === zoomLevel)
      return;
    zoomLevel = next;
    applyZoom();
    Find.scheduleFindPaint();
    postView();
  }

  function postView() {
    Util.post({
      type: 'view',
      toc: Toc.isVisible(),
      source: mode === 'source',
      zoom: zoomLevel
    });
  }

  function currentCaretOffset() {
    if (mode === 'source')
      return sourceEl.selectionStart;
    var el = CaretCode.blockOf(document.activeElement);
    if (!el || !el.classList.contains('editing'))
      return 0;
    var blocks = DocumentModel.collectBlocks();
    return EditingSnapshot.absoluteOffsets(blocks, EditingSnapshot.editingSelection()).start;
  }

  function setMode(next) {
    if (next === mode)
      return;
    // 自建跨块选区只在渲染态有效：切模式前先收起覆盖层
    Cross.clearCrossSelection();
    // 查找/替换绑定当前模式的命中（DOM 区间或 textarea 区间），切模式前先关掉
    if (Find.isOpen())
      Find.closeFind();
    Menus.closeLangMenu();
    // 块手柄与块菜单是渲染态浮层：切到源码模式必须一并收起，
    // 否则菜单悬空且动作会作用到即将被重建的旧 DOM 上
    BlockOps.closeBlockMenu();
    BlockOps.reset();
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    EditingSnapshot.commitHistory();

    var text = DocumentModel.currentSource();
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
      var layout = LayoutCode.splitSourceLayout(text);
      var blocks = layout.blocks;
      EditingSnapshot.mountBlocks(blocks, layout.gaps, layout.trail);
      document.body.classList.remove('source-mode');
      suppressEvents = false;

      var base = 0;
      for (var i = 0; i < blocks.length; i++) {
        base += DocumentModel.gapBefore(layout.gaps, i);
        var stop = base + blocks[i].length;
        if (caret <= stop || i === blocks.length - 1) {
          var target = root.children[i];
          if (target) {
            if (CellEdit.inPlaceEditable(target)) {
              RenderBlocks.renderBlock(target, blocks[i]);
              target.classList.add('editing');
              target.focus();
              var rel = Math.max(0, caret - base);
              CaretEdit.placeBlockCaret(target, rel, rel);
            } else {
              target.classList.add('editing');
              target.textContent = blocks[i];
              target.focus();
              CaretOffset.setSelectionRange(target, Math.max(0, Math.min(caret - base, blocks[i].length)));
            }
          }
          break;
        }
        base = stop;
      }
    }

    // 同一份文本：这里只同步选区，不会新增撤销步骤
    EditingSnapshot.commitHistory();
    DocumentModel.scheduleDirty();
    Toc.refreshToc();
    postView();
  }

  return {
    applyZoom: applyZoom,
    setTheme: setTheme,
    setZoom: setZoom,
    postView: postView,
    setMode: setMode,
    mode: function () { return mode; },
    getZoomLevel: function () { return zoomLevel; }
  };
  })();
