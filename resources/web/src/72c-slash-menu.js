  var SlashMenu = (function slashMenuModule() {
  function filteredSlashItems() {
    if (!slashState)
      return [];
    var raw = rawOf(slashState.el);
    var query = raw.slice(slashState.start + 1, Math.min(slashState.end, raw.length)).trim().toLowerCase();
    if (!query)
      return SLASH_ITEMS;
    return SLASH_ITEMS.filter(function (item) {
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
        + '" data-key="' + item.key + '"><span class="slash-label">' + escapeHtml(item.label)
        + '</span><span class="slash-hint">' + escapeHtml(item.hint) + '</span></div>';
    });
    if (!list.length)
      html = '<div class="slash-empty">没有匹配的命令</div>';
    slashMenu.innerHTML = html;
    var active = slashMenu.querySelector('.slash-item.active');
    if (active && active.scrollIntoView)
      active.scrollIntoView({ block: 'nearest' });
  }

  function openSlash(el, start) {
    closeTurnMenu();
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
    placeMenu(slashMenu, caretClientRect());
  }

  function updateSlashFilter() {
    if (!slashState)
      return;
    renderSlashItems();
    if (slashMenu)
      placeMenu(slashMenu, caretClientRect());
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
    if (!el || el.classList.contains('table') || isCodeBlock(el))
      return;
    var raw = rawOf(el);
    var caret = caretOffset(el);
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
    removeMenu(slashMenu);
    slashMenu = null;
    if (!deleteToken || !state)
      return;
    var el = state.el;
    if (!el || !el.isConnected)
      return;
    var raw = rawOf(el);
    if (raw.charAt(state.start) !== '/')
      return;
    var end = Math.min(state.end, raw.length);
    var next = raw.slice(0, state.start) + raw.slice(end);
    commitHistory();
    applyRawToBlock(el, next, state.start, state.start, true);
    setTimeout(commitHistory, 0);
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
    var end = Math.min(slashState.end, rawOf(el).length);
    var base = rawOf(el).slice(0, start) + rawOf(el).slice(end);
    closeSlash(false);
    commitHistory();
    var key = item.key;

    if (key === 'code') {
      var body = base.replace(/\n+$/, '');
      var codeRaw_ = '```\n' + body + '\n```';
      var codeCaret = 4 + body.length;
      applyRawToBlock(el, codeRaw_, codeCaret, codeCaret, true);
    } else if (key === 'table') {
      applyRawToBlock(el, TABLE_TEMPLATE, 2, 2, true);
    } else if (key === 'hr') {
      applyRawToBlock(el, '---', 3, 3, true);
      insertBlockAfter(el, '', 0);
    } else if (key === 'image') {
      var token = '图片路径';
      var imageRaw = base + '![](' + token + ')';
      applyRawToBlock(el, imageRaw, base.length + 4, base.length + 4 + token.length, true);
    } else if (key === 'link') {
      var linkRaw = base ? '[' + base + '](url)' : '[链接文字](url)';
      applyRawToBlock(el, linkRaw, base ? base.length + 3 : 1,
        base ? base.length + 6 : 5, true);
    } else if (key === 'inlineCode') {
      var inlineRaw = '`' + base + '`';
      applyRawToBlock(el, inlineRaw, base ? 1 + base.length : 1,
        base ? 1 + base.length : 1, true);
    } else {
      var type = { h1: 'h1', h2: 'h2', h3: 'h3', ul: 'ul', ol: 'ol', quote: 'quote' }[key];
      if (!type) {
        setTimeout(commitHistory, 0);
        return;
      }
      var converted = buildBlockRaw(type, base);
      var shift = leadLength(converted, kindOfRaw(converted)) - leadLength(base, kindOfRaw(base));
      applyRawToBlock(el, converted, Math.max(0, start + shift), Math.max(0, start + shift), true);
    }
    scheduleDirty();
    scheduleTocRefresh();
    setTimeout(commitHistory, 0);
  }

  return {
    moveSlash: moveSlash,
    handleSlashInput: handleSlashInput,
    closeSlash: closeSlash,
    insertSlashItem: insertSlashItem
  };
  })();

  var moveSlash = SlashMenu.moveSlash;
  var handleSlashInput = SlashMenu.handleSlashInput;
  var closeSlash = SlashMenu.closeSlash;
  var insertSlashItem = SlashMenu.insertSlashItem;
