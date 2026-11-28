  var Menus = (function menusModule() {
  var slashState = null;   // { el, start, end, index }
  var slashMenu = null;
  var turnMenu = null;
  var langMenu = null;       // 挂在 body 上的下拉面板
  var langComposing = false; // 搜索框自己的输入法组字状态
  var LangMenu = (function langMenuModule() {
  /* ---------------- 代码块语言选择器 ----------------
     下拉挂在 body 上（position:fixed），因此不会被 .code-scroll / pre 的
     overflow 裁掉，也不参与代码块排版。点徽标开、再点同一个徽标或点外部关闭，
    支持搜索过滤、方向键/Enter/Esc 与自定义语言。 */

  var langMenuState = null;  // { el, badge, items, active }

  function langItems(query) {
    var raw = String(query || '').trim();
    var q = raw.toLowerCase();
    var items = HighlightLangs.LANG_PICKS.filter(function (item) {
      if (!q)
        return true;
      return (item.name + ' ' + item.value + ' ' + item.words).toLowerCase().indexOf(q) >= 0;
    });
    if (raw) {
      // 输入不在清单里的名字时，末尾补一条「自定义语言」，Enter 可直接写入。
      // 若已能匹配到某个语言（名称/别名/关键词以输入开头），就不再加这条，
      // 避免输入 py 时同时出现 Python 和「自定义 py」；中文关键词（如「脚本」）
      // 是在搜索已有语言，也不作为自定义语言名。
      var covered = items.some(function (item) {
        if (item.name.toLowerCase().indexOf(q) === 0 || item.value.toLowerCase().indexOf(q) === 0)
          return true;
        return item.words.toLowerCase().split(/\s+/).some(function (word) {
          return word.indexOf(q) === 0;
        });
      }) || /[^\x00-\x7F]/.test(raw);
      if (!covered) {
        items = items.slice();
        items.push({
          name: items.length
            ? '使用自定义语言 “' + raw + '”'
            : '没有匹配的语言，按 Enter 使用 “' + raw + '”',
          value: raw,
          custom: true
        });
      }
    }
    return items;
  }

  // 当前语言在候选里的下标：先按名称/别名精确匹配；自定义写法（如 py）若只
  // 对应到唯一一个高亮器（python），也把那一项视为当前语言。js 这一组有
  // JavaScript/TypeScript/JSX/TSX 四项，无法判断具体是哪一个，就不标。
  function langCurrentIndex(items, current) {
    current = String(current || '').toLowerCase();
    var groupHit = -1;
    var group = HighlightLangs.LANG_ALIAS[current] || '';
    var count = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.custom)
        continue;
      var value = String(item.value).toLowerCase();
      if (!current) {
        if (!value)
          return i;
        continue;
      }
      if (value === current || item.name.toLowerCase() === current)
        return i;
      if (groupHit < 0 && group && HighlightLangs.LANG_ALIAS[value] === group) {
        groupHit = i;
        count++;
      }
    }
    return count === 1 ? groupHit : -1;
  }

  function renderLangItems() {
    if (!langMenu || !langMenuState)
      return;
    var list = langMenu.querySelector('.lang-list');
    var items = langMenuState.items || [];
    if (langMenuState.active >= items.length)
      langMenuState.active = Math.max(0, items.length - 1);
    var currentIndex = langCurrentIndex(items, langMenuState.el.dataset.lang);
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var isCurrent = i === currentIndex;
      var cls = 'lang-item' + (i === langMenuState.active ? ' active' : '')
        + (isCurrent ? ' is-current' : '');
      html += '<div class="' + cls + '" role="option" data-index="' + i + '"'
        + ' aria-selected="' + (i === langMenuState.active ? 'true' : 'false') + '">'
        + '<span class="lang-name">' + Util.escapeHtml(item.name) + '</span>'
        + (isCurrent ? '<span class="lang-check">✓</span>' : '')
        + '</div>';
    }
    if (!items.length)
      html = '<div class="lang-empty">没有匹配的语言</div>';
    list.innerHTML = html;
    // 只滚列表自身，不用 scrollIntoView：后者可能把整页滚一下，
    // 既会改变徽标位置，也会触发 scroll 监听把下拉关掉。
    var active = list.querySelector('.lang-item.active');
    if (active) {
      var top = active.offsetTop;
      var bottom = top + active.offsetHeight;
      if (top < list.scrollTop)
        list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight)
        list.scrollTop = bottom - list.clientHeight;
    }
  }

  function moveLangItem(delta) {
    if (!langMenuState || !langMenuState.items.length)
      return;
    var count = langMenuState.items.length;
    langMenuState.active = (langMenuState.active + delta + count) % count;
    renderLangItems();
  }

  function chooseLangItem(index) {
    var state = langMenuState;
    if (!state || index < 0 || index >= state.items.length)
      return;
    var item = state.items[index];
    var el = state.el;
    closeLangMenu();
    if (!el || !el.isConnected)
      return;
    if ((el.dataset.lang || '') === item.value)
      return;
    // 与原来的改语言一致：更新 dataset.lang/围栏并重着色，再走同一条
    // 置脏与合并入撤销栈的路径。
    CaretCode.applyCodeLang(el, item.value);
    DocumentModel.scheduleDirty();
    EditingSnapshot.scheduleCommit();
  }

  function closeLangMenu() {
    var state = langMenuState;
    langMenuState = null;
    langComposing = false;
    MenuOverlay.removeMenu(langMenu);
    langMenu = null;
    if (state && state.badge)
      state.badge.setAttribute('aria-expanded', 'false');
  }

  function openLangMenu(el, badge) {
    // 再点同一个徽标：关闭
    if (langMenuState && langMenuState.el === el) {
      closeLangMenu();
      return;
    }
    SlashMenu.closeSlash(false);
    TurnMenu.closeTurnMenu();
    closeLangMenu();
    var items = langItems('');
    langMenuState = { el: el, badge: badge, items: items, active: 0 };
    var currentIndex = langCurrentIndex(items, el.dataset.lang);
    if (currentIndex >= 0)
      langMenuState.active = currentIndex;
    langMenu = document.createElement('div');
    langMenu.id = 'lang-menu';
    langMenu.innerHTML = '<input id="lang-search" type="text" placeholder="搜索语言…"'
      + ' autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="搜索语言">'
      + '<div class="lang-list" role="listbox"></div>';
    var input = langMenu.querySelector('#lang-search');
    input.addEventListener('input', function () {
      if (!langMenuState)
        return;
      langMenuState.items = langItems(input.value);
      langMenuState.active = 0;
      renderLangItems();
    });
    // 输入法组字期间 Enter/Esc/方向键属于输入法，不能抢。
    input.addEventListener('compositionstart', function () {
      langComposing = true;
    });
    input.addEventListener('compositionend', function () {
      langComposing = false;
      if (!langMenuState)
        return;
      langMenuState.items = langItems(input.value);
      langMenuState.active = 0;
      renderLangItems();
    });
    input.addEventListener('keydown', function (event) {
      if (langComposing || composing)
        return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        moveLangItem(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (langMenuState)
          chooseLangItem(langMenuState.active);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeLangMenu();
      }
    });
    langMenu.addEventListener('mousedown', function (event) {
      var hit = event.target.closest ? event.target.closest('.lang-item') : null;
      if (!hit)
        return;
      // preventDefault 保住搜索框焦点，选完再统一关闭
      event.preventDefault();
      chooseLangItem(Number(hit.getAttribute('data-index')));
    });
    renderLangItems();
    MenuOverlay.placeMenu(langMenu, badge.getBoundingClientRect());
    badge.setAttribute('aria-expanded', 'true');
    // 真实点击的 mouseup/click 可能把焦点交回页面；同步聚焦后再补一次，
    // 确保搜索框在整次点击结束后仍然拿到焦点。不用 focusout 关下拉：
    // 点击外部由 document 的 mousedown 负责，避免这里和焦点回落互相打架。
    var focusSearch = function () {
      if (!langMenu || !input.isConnected)
        return;
      try {
        input.focus({ preventScroll: true });
      } catch (error) {
        input.focus();
      }
    };
    focusSearch();
    setTimeout(focusSearch, 0);
  }

  // 页面滚动/窗口尺寸变化后徽标位置会变，直接关闭比追着重新定位更稳，
  // 也确保下拉不会停在离徽标很远的地方。
  window.addEventListener('resize', closeLangMenu);
  document.addEventListener('scroll', function (event) {
    // 候选列表自己的滚动不能把下拉关掉（方向键移动高亮时会滚列表）
    if (langMenu && event.target && langMenu.contains(event.target))
      return;
    closeLangMenu();
  }, true);
  return {
    closeLangMenu: closeLangMenu,
    openLangMenu: openLangMenu
  };
  })();

  var SlashMenu = (function slashMenuModule() {
  function filteredSlashItems() {
    if (!slashState)
      return [];
    var raw = BlockParse.rawOf(slashState.el);
    var query = raw.slice(slashState.start + 1, Math.min(slashState.end, raw.length)).trim().toLowerCase();
    if (!query)
      return MenuOverlay.SLASH_ITEMS;
    return MenuOverlay.SLASH_ITEMS.filter(function (item) {
      return item.words.toLowerCase().indexOf(query) >= 0
        || item.label.toLowerCase().indexOf(query) >= 0;
    });
  }

  function renderSlashItems() {
    if (!slashMenu || !slashState)
      return;
    var list = filteredSlashItems();
    if (slashState.index >= list.length)
      slashState.index = Math.max(0, list.length - 1);
    var html = '';
    list.forEach(function (item, index) {
      html += '<div class="slash-item' + (index === slashState.index ? ' active' : '')
        + '" data-key="' + item.key + '"><span class="slash-label">' + Util.escapeHtml(item.label)
        + '</span><span class="slash-hint">' + Util.escapeHtml(item.hint) + '</span></div>';
    });
    if (!list.length)
      html = '<div class="slash-empty">没有匹配的命令</div>';
    slashMenu.innerHTML = html;
    var active = slashMenu.querySelector('.slash-item.active');
    if (active && active.scrollIntoView)
      active.scrollIntoView({ block: 'nearest' });
  }

  function openSlash(el, start) {
    TurnMenu.closeTurnMenu();
    slashState = { el: el, start: start, end: start + 1, index: 0 };
    slashMenu = document.createElement('div');
    slashMenu.id = 'slash-menu';
    slashMenu.addEventListener('mousedown', function (event) {
      var hit = event.target.closest ? event.target.closest('.slash-item') : null;
      if (hit) {
        event.preventDefault();
        slashState.index = Array.prototype.indexOf.call(slashMenu.children, hit);
        insertSlashItem();
      }
    });
    renderSlashItems();
    MenuOverlay.placeMenu(slashMenu, MenuOverlay.caretClientRect(slashState.el));
  }

  function updateSlashFilter() {
    if (!slashState)
      return;
    renderSlashItems();
    if (slashMenu)
      MenuOverlay.placeMenu(slashMenu, MenuOverlay.caretClientRect(slashState.el));
  }

  function moveSlash(delta) {
    var list = filteredSlashItems();
    if (!slashState || !list.length)
      return;
    slashState.index = (slashState.index + delta + list.length) % list.length;
    renderSlashItems();
  }

  // 输入时维护「/ + 查询词」的范围；斜杠只在空行/行首触发。
  function handleSlashInput(el) {
    if (!el || el.classList.contains('table') || LayoutCode.isCodeBlock(el))
      return;
    var raw = BlockParse.rawOf(el);
    var caret = CaretOffset.caretOffset(el);
    if (!slashState) {
      if (raw.charAt(caret - 1) !== '/')
        return;
      var atLineStart = caret - 1 === 0 || raw.charAt(caret - 2) === '\n';
      if (!atLineStart)
        return;
      openSlash(el, caret - 1);
      slashState.end = caret;
      updateSlashFilter();
      return;
    }
    slashState.end = caret;
    if (raw.charAt(slashState.start) !== '/' || el !== slashState.el) {
      closeSlash(false);
      return;
    }
    updateSlashFilter();
  }

  function closeSlash(deleteToken) {
    var state = slashState;
    slashState = null;
    MenuOverlay.removeMenu(slashMenu);
    slashMenu = null;
    if (!deleteToken || !state)
      return;
    var el = state.el;
    if (!el || !el.isConnected)
      return;
    var raw = BlockParse.rawOf(el);
    if (raw.charAt(state.start) !== '/')
      return;
    var end = Math.min(state.end, raw.length);
    var next = raw.slice(0, state.start) + raw.slice(end);
    EditingSnapshot.commitHistory();
    BlockParse.applyRawToBlock(el, next, state.start, state.start, true);
    setTimeout(EditingSnapshot.commitHistory, 0);
  }

  function isOpen() {
    return !!slashState;
  }

  // Esc：尾端先同步到当前光标，再按「删除已输入的 /」关闭
  function cancelSlash() {
    slashState.end = CaretOffset.caretOffset(slashState.el);
    closeSlash(true);
  }

  function insertSlashItem() {
    if (!slashState)
      return;
    var list = filteredSlashItems();
    var item = list[slashState.index];
    if (!item)
      return;
    var el = slashState.el;
    var start = slashState.start;
    var end = Math.min(slashState.end, BlockParse.rawOf(el).length);
    var base = BlockParse.rawOf(el).slice(0, start) + BlockParse.rawOf(el).slice(end);
    closeSlash(false);
    EditingSnapshot.commitHistory();
    var key = item.key;

    if (key === 'code') {
      var body = base.replace(/\n+$/, '');
      var codeRaw_ = '```\n' + body + '\n```';
      var codeCaret = 4 + body.length;
      BlockParse.applyRawToBlock(el, codeRaw_, codeCaret, codeCaret, true);
    } else if (key === 'table') {
      BlockParse.applyRawToBlock(el, BlockConvert.TABLE_TEMPLATE, 2, 2, true);
    } else if (key === 'hr') {
      BlockParse.applyRawToBlock(el, '---', 3, 3, true);
      BlockConvert.insertBlockAfter(el, '', 0);
    } else if (key === 'image') {
      var token = '图片路径';
      var imageRaw = base + '![](' + token + ')';
      BlockParse.applyRawToBlock(el, imageRaw, base.length + 4, base.length + 4 + token.length, true);
    } else if (key === 'link') {
      var linkRaw = base ? '[' + base + '](url)' : '[链接文字](url)';
      BlockParse.applyRawToBlock(el, linkRaw, base ? base.length + 3 : 1,
        base ? base.length + 6 : 5, true);
    } else if (key === 'inlineCode') {
      var inlineRaw = '`' + base + '`';
      BlockParse.applyRawToBlock(el, inlineRaw, base ? 1 + base.length : 1,
        base ? 1 + base.length : 1, true);
    } else {
      var type = { h1: 'h1', h2: 'h2', h3: 'h3', ul: 'ul', ol: 'ol', quote: 'quote' }[key];
      if (!type) {
        setTimeout(EditingSnapshot.commitHistory, 0);
        return;
      }
      var converted = BlockParse.buildBlockRaw(type, base);
      var shift = BlockParse.leadLength(converted, BlockParse.kindOfRaw(converted)) - BlockParse.leadLength(base, BlockParse.kindOfRaw(base));
      BlockParse.applyRawToBlock(el, converted, Math.max(0, start + shift), Math.max(0, start + shift), true);
    }
    DocumentModel.scheduleDirty();
    Toc.scheduleTocRefresh();
    setTimeout(EditingSnapshot.commitHistory, 0);
  }

  return {
    moveSlash: moveSlash,
    handleSlashInput: handleSlashInput,
    closeSlash: closeSlash,
    insertSlashItem: insertSlashItem,
    isOpen: isOpen,
    cancelSlash: cancelSlash
  };
  })();

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
    if (!BlockOps.containsNode(event.target))
      BlockOps.closeBlockMenu();
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
    } else if (BlockOps.isBlockMenuOpen()) {
      event.preventDefault();
      BlockOps.closeBlockMenu();
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
    Cross.clearCrossSelection();
    EditingSnapshot.commitHistory();
    DocumentModel.scheduleDirty();
    Toc.scheduleTocRefresh();
    MenuOverlay.updatePlaceholder();
    MermaidInit.scheduleMermaid();
    // 结构一变，查找命中引用的旧文本节点可能已被重建（拖拽重排实测会失联），
    // 原地重画只会把高亮层清空：查找条开着就按当前关键词重扫，命中与位置一起刷新
    if (Find.isOpen())
      Find.scheduleFind();
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

  return {
    openLangMenu: LangMenu.openLangMenu,
    closeLangMenu: LangMenu.closeLangMenu,
    moveSlash: SlashMenu.moveSlash,
    handleSlashInput: SlashMenu.handleSlashInput,
    closeSlash: SlashMenu.closeSlash,
    insertSlashItem: SlashMenu.insertSlashItem,
    isSlashOpen: SlashMenu.isOpen,
    cancelSlash: SlashMenu.cancelSlash,
    closeTurnMenu: TurnMenu.closeTurnMenu,
    normalizeBlockGaps: TurnMenu.normalizeBlockGaps,
    afterBlockStructureChange: TurnMenu.afterBlockStructureChange,
    makeBlockEl: TurnMenu.makeBlockEl,
    TURN_ITEMS: TurnMenu.TURN_ITEMS
  };
  })();
