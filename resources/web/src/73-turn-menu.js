  var TurnMenu = (function turnMenuModule() {
  /* ---------- 右键「转为」 ---------- */
  var TURN_ITEMS = [
    { key: 'paragraph', label: '正文' },
    { key: 'h1', label: '标题 1' },
    { key: 'h2', label: '标题 2' },
    { key: 'h3', label: '标题 3' },
    { key: 'ul', label: '无序列表' },
    { key: 'ol', label: '有序列表' },
    { key: 'quote', label: '引用' },
    { key: 'codeBlock', label: '代码块' }
  ];

  function closeTurnMenu() {
    MenuOverlay.removeMenu(turnMenu);
    turnMenu = null;
  }

  function openTurnMenu(x, y) {
    SlashMenu.closeSlash(false);
    closeTurnMenu();
    var selection = window.getSelection();
    // 剪切/复制要有非空选区才可用；粘贴是否可用取决于系统剪贴板，页面没有读取
    // 权限，只能保持可用（剪贴板为空时原生侧本来就什么都不做）。
    var hasRange = !!(selection && selection.rangeCount && !selection.isCollapsed);
    turnMenu = document.createElement('div');
    turnMenu.id = 'turn-menu';
    var html = '';
    html += '<div class="turn-item' + (hasRange ? '' : ' is-disabled') + '" data-edit="cut">剪切</div>';
    html += '<div class="turn-item' + (hasRange ? '' : ' is-disabled') + '" data-edit="copy">复制</div>';
    html += '<div class="turn-item" data-edit="paste">粘贴</div>';
    html += '<div class="turn-sep"></div>';
    html += '<div class="turn-title">转为</div>';
    TURN_ITEMS.forEach(function (item) {
      html += '<div class="turn-item" data-key="' + item.key + '">' + Util.escapeHtml(item.label) + '</div>';
    });
    turnMenu.innerHTML = html;
    turnMenu.addEventListener('mousedown', function (event) {
      var hit = event.target.closest ? event.target.closest('.turn-item') : null;
      if (!hit)
        return;
      // preventDefault 保住选区：菜单项在页面里，按下时不能挪掉光标/选区
      event.preventDefault();
      if (hit.classList.contains('is-disabled'))
        return;
      var command = hit.getAttribute('data-edit');
      closeTurnMenu();
      // 剪贴板三项交回宿主执行，与编辑菜单、快捷键完全同一条路径
      if (command)
        Util.post({ type: 'editCommand', command: command });
      else
        BlockConvert.formatAction(hit.getAttribute('data-key'));
    });
    MenuOverlay.placeMenu(turnMenu, { left: x, top: y, bottom: y, right: x });
  }

  // WebKit 在右键按下后、contextmenu 之前会把跨块选区折叠成光标，
  // 所以要在 mousedown 阶段先把整段选区存下来，供「转为」菜单使用。
  var lastRangeSelection = null;

  document.addEventListener('contextmenu', function (event) {
    if (mode === 'source')
      return;
    var el = CaretCode.blockOf(event.target);
    if (!el)
      return;
    event.preventDefault();
    var selection = window.getSelection();
    if (selection && selection.isCollapsed && lastRangeSelection
        && lastRangeSelection.intersectsNode(el)) {
      selection.removeAllRanges();
      selection.addRange(lastRangeSelection);
    }
    lastRangeSelection = null;
    // 多块选区右键时保留整段选区，否则「转为」只会作用于光标所在块。
    var rangeBlocks = BlockParse.selectedBlocks();
    var keepSelection = !!(selection && !selection.isCollapsed && rangeBlocks.length > 1
      && rangeBlocks.indexOf(el) >= 0);
    if (!keepSelection) {
      var host = selection && selection.rangeCount ? CaretCode.blockOf(selection.anchorNode) : null;
      if (host !== el) {
        el.classList.add('editing');
        el.focus();
        // 不能直接 setSelectionRange：表格末尾的偏移会落在尾部 | 标记之后，
        // 之后的输入就写到分隔符外面去了。placeBlockCaret 会带上
        // ensureCellCaret 把光标收回单元格可见文本里。
        CaretEdit.placeBlockCaret(el, el.textContent.length);
      }
    }
    openTurnMenu(event.clientX, event.clientY);
  });

  document.addEventListener('mousedown', function (event) {
    var sel = window.getSelection();
    lastRangeSelection = (event.button === 2 && sel && !sel.isCollapsed && sel.rangeCount)
      ? sel.getRangeAt(0).cloneRange()
      : null;
    if (turnMenu && !turnMenu.contains(event.target))
      closeTurnMenu();
    // 手柄自己的按下会弹菜单，这里不能把它当成「点外部」提前关掉
    if (blockMenu && !blockMenu.contains(event.target)
        && !(blockHandle && blockHandle.contains(event.target)))
      BlockMenu.closeBlockMenu();
    if (slashMenu && !slashMenu.contains(event.target) && !CaretCode.blockOf(event.target))
      SlashMenu.closeSlash(true);
    // 徽标自己的 mousedown 会先打开/切换下拉，这里不能把它当成「点外部」关掉
    if (langMenu && !langMenu.contains(event.target)
        && !(event.target.closest && event.target.closest('.code-lang')))
      LangMenu.closeLangMenu();
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape')
      return;
    // 组字期间 Esc 属于输入法（取消候选/整段上屏），浮层不能抢
    if (composing || langComposing)
      return;
    if (slashState) {
      event.preventDefault();
      SlashMenu.closeSlash(true);
    } else if (turnMenu) {
      event.preventDefault();
      closeTurnMenu();
    } else if (langMenu) {
      event.preventDefault();
      LangMenu.closeLangMenu();
    } else if (blockMenu) {
      event.preventDefault();
      BlockMenu.closeBlockMenu();
    }
  }, true);

  /* ---------------- 块操作手柄（⋮⋮：拖拽重排 + 块菜单） ----------------
     参照 wolai / Notion：指针悬停到任意块（或块获得焦点）时，块左缘出现 ⋮⋮
     手柄；按住手柄上下拖动可重排块，落点画插入指示线；单击手柄弹出块菜单
     （在上方/下方插入、复制副本、删除、转为）。手柄与菜单都挂在 body 上
     （position:fixed），不在 contenteditable 内部，因此不会污染块原文与
     dataset.raw；导出克隆的是 #editor，天然不含手柄。重排只移动 DOM 节点，
     dataset.raw / data-gap 跟着节点走，currentSource 由块序重新拼接，撤销走
     snapshotState 的 blocks/gaps 快照，与现有块模型完全一致。 */


  // 结构变动后的间隔归一：首块前不留空行；离开首位的老首块补回块间默认间隔
  function normalizeBlockGaps() {
    var list = BlockParse.blockList();
    for (var i = 0; i < list.length; i++) {
      var value = list[i].dataset.gap;
      if (value === undefined || value === '')
        continue;
      var n = parseInt(value, 10);
      if (isNaN(n))
        continue;
      if (i === 0 && n > 0)
        list[i].dataset.gap = '0';
      if (i > 0 && n === 0)
        list[i].dataset.gap = '2';
    }
  }

  // 所有块级结构操作（插入/删除/副本/重排）的统一收尾
  function afterBlockStructureChange() {
    normalizeBlockGaps();
    CrossRange.clearCrossSelection();
    EditingSnapshot.commitHistory();
    DocumentModel.scheduleDirty();
    Toc.scheduleTocRefresh();
    MenuOverlay.updatePlaceholder();
    MermaidInit.scheduleMermaid();
    // 结构一变，查找命中引用的旧文本节点可能已被重建（拖拽重排实测会失联），
    // 原地重画只会把高亮层清空：查找条开着就按当前关键词重扫，命中与位置一起刷新
    if (findBar)
      FindUi.scheduleFind();
  }

  function makeBlockEl(raw) {
    var el = document.createElement('div');
    el.className = 'block';
    el.setAttribute('contenteditable', 'true');
    RenderBlocks.renderBlock(el, raw);
    LayoutCode.normalizeCodeScrolls(el);
    return el;
  }
  return {
    closeTurnMenu: closeTurnMenu,
    normalizeBlockGaps: normalizeBlockGaps,
    afterBlockStructureChange: afterBlockStructureChange,
    makeBlockEl: makeBlockEl,
    TURN_ITEMS: TURN_ITEMS
  };
  })();
