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

