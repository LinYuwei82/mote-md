  /* ---------- 源码模式：同一套规则作用于 textarea 文本 ---------- */

  // 段落起点：回退到空白行之后。连续多个空行要整段跨过，不能只退两格，
  // 否则保存了 3 个换行的文档在源码模式下转换会吃掉一个换行。
  function paragraphStart(text, position) {
    var gap = text.lastIndexOf('\n\n', Math.max(0, position - 1));
    if (gap < 0)
      return 0;
    while (gap < text.length && text.charAt(gap) === '\n')
      gap++;
    return gap;
  }

  function paragraphEnd(text, position) {
    var gap = text.indexOf('\n\n', position);
    if (gap < 0)
      return text.length;
    while (gap > 0 && text.charAt(gap - 1) === '\n')
      gap--;
    return gap;
  }

  function sourceParagraph(text, start, end) {
    var from = paragraphStart(text, start);
    var to = paragraphEnd(text, end);
    return { start: from, end: to, text: text.slice(from, to) };
  }

  function applySourceText(text, start, end) {
    sourceEl.value = text;
    sourceEl.focus();
    sourceEl.setSelectionRange(start, end);
    sourceEl.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(commitHistory, 0);
  }

  function sourceInline(kind) {
    var text = sourceEl.value;
    var start = sourceEl.selectionStart;
    var end = sourceEl.selectionEnd;
    var out = inlineTransform(text, start, end, kind);
    if (out.raw === text)
      return;
    commitHistory();
    applySourceText(out.raw, out.start, out.end);
  }

  function sourceConvert(type, toggle) {
    var text = sourceEl.value;
    var start = sourceEl.selectionStart;
    var end = sourceEl.selectionEnd;
    // 多行选区：按当前段落范围整体转换（与块模型一致）
    var range = (start === end || /^\s*$/.test(text.slice(start, end)))
      ? sourceParagraph(text, start, end)
      : { start: paragraphStart(text, start), end: paragraphEnd(text, end) };
    if (range.end < 0)
      range.end = text.length;
    if (range.start < 0)
      range.start = 0;
    var raw = text.slice(range.start, range.end);
    var next = convertRaw(raw, type, toggle);
    if (next === raw)
      return;
    var shift = leadLength(next, kindOfRaw(next)) - leadLength(raw, kindOfRaw(raw));
    commitHistory();
    applySourceText(text.slice(0, range.start) + next + text.slice(range.end),
      Math.max(range.start, start + shift), Math.max(range.start, end + shift));
  }


  /* ---------- 空白文档占位提示 ----------
     提示用 CSS ::before 绘制，不属于 textContent，因此绝不会写进 dataset.raw；
     只在「整篇只有一个空块」时出现，正常文档里回车产生的新空块不受影响。 */
  function updatePlaceholder() {
    if (!root)
      return;
    var blocks = blockList();
    var bare = mode !== 'source' && blocks.length === 1
      && String(rawOf(blocks[0])).trim() === '';
    if (bare !== root.classList.contains('bare'))
      root.classList.toggle('bare', bare);
  }

  /* ---------- 斜杠命令浮层 ----------
     浮层挂在 body 上（不在 #editor 里），提示文字不进入文档 DOM；
     插入统一走 convertRaw / applyRawToBlock，与快捷键、右键菜单同一套实现。 */
  var SLASH_ITEMS = [
    { key: 'code', label: '代码块', hint: '```', words: 'code daima codeblock 代码块' },
    { key: 'inlineCode', label: '行内代码', hint: '`', words: 'inline code hangnei 行内代码' },
    { key: 'table', label: '表格', hint: '|', words: 'table biaoge 表格' },
    { key: 'h1', label: '标题 1', hint: '#', words: 'h1 heading biaoti 标题1 一级标题' },
    { key: 'h2', label: '标题 2', hint: '##', words: 'h2 heading biaoti 标题2 二级标题' },
    { key: 'h3', label: '标题 3', hint: '###', words: 'h3 heading biaoti 标题3 三级标题' },
    { key: 'ul', label: '无序列表', hint: '-', words: 'ul bullet list wuxu 无序列表' },
    { key: 'ol', label: '有序列表', hint: '1.', words: 'ol number list youxu 有序列表' },
    { key: 'quote', label: '引用', hint: '>', words: 'quote yinyong 引用' },
    { key: 'hr', label: '分隔线', hint: '---', words: 'hr divider fengexian 分隔线' },
    { key: 'image', label: '图片', hint: '![]', words: 'image picture tupian 图片' },
    { key: 'link', label: '链接', hint: '[]()', words: 'link lianjie 链接' }
  ];

  var slashState = null;   // { el, start, end, index }
  var slashMenu = null;
  var turnMenu = null;

  function removeMenu(node) {
    if (node && node.parentNode)
      node.parentNode.removeChild(node);
  }

  function caretClientRect() {
    var selection = window.getSelection();
    if (selection && selection.rangeCount) {
      var range = selection.getRangeAt(0).cloneRange();
      range.collapse(true);
      var rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height || rect.top))
        return rect;
    }
    var el = slashState ? slashState.el : null;
    if (el)
      return el.getBoundingClientRect();
    return null;
  }

  function placeMenu(node, rect) {
    var x = rect ? rect.left : 40;
    var y = rect ? rect.bottom + 6 : 80;
    document.body.appendChild(node);
    var width = node.offsetWidth;
    var height = node.offsetHeight;
    if (x + width > window.innerWidth - 8)
      x = Math.max(8, window.innerWidth - width - 8);
    if (y + height > window.innerHeight - 8)
      y = Math.max(8, (rect ? rect.top : 80) - height - 6);
    // 锚点本身可能在窗口外（页面滚动/极端窗口尺寸），仍把面板钳进可视区
    x = Math.max(8, x);
    y = Math.max(8, y);
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  }

  /* ---------------- 代码块语言选择器 ----------------
     下拉挂在 body 上（position:fixed），因此不会被 .code-scroll / pre 的
     overflow 裁掉，也不参与代码块排版。点徽标开、再点同一个徽标或点外部关闭，
    支持搜索过滤、方向键/Enter/Esc 与自定义语言。 */

  var langMenu = null;       // 挂在 body 上的下拉面板
  var langMenuState = null;  // { el, badge, items, active }
  var langComposing = false; // 搜索框自己的输入法组字状态

  function langItems(query) {
    var raw = String(query || '').trim();
    var q = raw.toLowerCase();
    var items = LANG_PICKS.filter(function (item) {
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
    var group = LANG_ALIAS[current] || '';
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
      if (groupHit < 0 && group && LANG_ALIAS[value] === group) {
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
        + '<span class="lang-name">' + escapeHtml(item.name) + '</span>'
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
    applyCodeLang(el, item.value);
    scheduleDirty();
    scheduleCommit();
  }

  function closeLangMenu() {
    var state = langMenuState;
    langMenuState = null;
    langComposing = false;
    removeMenu(langMenu);
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
    closeSlash(false);
    closeTurnMenu();
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
    placeMenu(langMenu, badge.getBoundingClientRect());
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

