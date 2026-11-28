  var CaretCode = (function caretCodeModule() {
  function blockOf(node) {
    while (node && node !== root) {
      if (node.classList && node.classList.contains('block'))
        return node;
      node = node.parentNode;
    }
    return null;
  }

  function setCaret(el, offset) {
    // 折叠标记模式下，偏移必须按零宽原子取整，否则光标会落进 <i> 里
    if (INLINE_PROTO) {
      setSelectionRange(el, offset);
      return;
    }
    var range = document.createRange();
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var remaining = offset;
    var node = null;

    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        range.setStart(node, remaining);
        range.collapse(true);
        break;
      }
      remaining -= node.nodeValue.length;
    }
    if (!node) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 任意 DOM 位置 → 相对 root 的字符偏移（只数字符，不计元素）。位置不在
  // root 内时返回 -1。
  function offsetIn(rootEl, container, offset) {
    var range = document.createRange();
    range.selectNodeContents(rootEl);
    try {
      range.setEnd(container, offset);
    } catch (error) {
      return -1;
    }
    return range.toString().length;
  }

  // 当前选区在某个元素内的字符范围；选区不在该元素内时返回 null
  function rangeIn(rootEl) {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (range.startContainer !== rootEl && !rootEl.contains(range.startContainer))
      return null;
    if (range.endContainer !== rootEl && !rootEl.contains(range.endContainer))
      return null;
    var start = offsetIn(rootEl, range.startContainer, range.startOffset);
    var end = offsetIn(rootEl, range.endContainer, range.endOffset);
    if (start < 0 || end < 0)
      return null;
    return { start: start, end: Math.max(start, end) };
  }

  // 徽标可能被原生编辑整块删掉（整块选中后退格/删除时，WebKit 会把不可编辑的
  // span 一起移除）。此时补回一个徽标，否则语言就再也改不回来。
  function ensureLangBadge(el) {
    var badge = el.querySelector('.code-lang');
    if (badge)
      return badge;
    var pre = el.querySelector('pre.code-block');
    if (!pre)
      return null;
    badge = document.createElement('span');
    badge.className = 'code-lang';
    badge.setAttribute('contenteditable', 'false');
    badge.setAttribute('spellcheck', 'false');
    badge.setAttribute('role', 'button');
    badge.setAttribute('aria-haspopup', 'listbox');
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-label', '代码语言');
    badge.textContent = el.dataset.lang || '';
    badge.title = el.dataset.lang || '';
    var tools = pre.querySelector('.code-tools');
    if (tools)
      tools.insertBefore(badge, tools.firstChild);
    else
      pre.insertBefore(badge, pre.firstChild);
    return badge;
  }

  // 整段替换 <code> 的 innerHTML 会把 .code-scroll 的横向滚动位置冲回 0，长行
  // 已经滚到右边时视野会跳回行首。替换前后保存/恢复；没滚动过就不写回，省掉
  // 一次强制布局。
  function setCodeHtml(el, code, html) {
    var scroller = el.querySelector('.code-scroll');
    var left = scroller ? scroller.scrollLeft : 0;
    var top = scroller ? scroller.scrollTop : 0;
    code.innerHTML = html;
    if (scroller && (left || top)) {
      scroller.scrollLeft = left;
      scroller.scrollTop = top;
    }
  }

  // 重着色 + 按字符偏移复位光标。用 lang+正文当签名：已经画过的这版内容不再
  // 整段替换（徽标合并重着色、连续 input 都会撞到）。
  function drawCode(el) {
    var code = codeEl(el);
    if (!code)
      return null;
    var text = code.textContent;
    var sig = (el.dataset.lang || '') + '\n' + text;
    if (el._codeDrawn === sig)
      return code;
    var range = rangeIn(code);
    setCodeHtml(el, code, highlightCode(el, text, el.dataset.lang).join('\n'));
    el._codeDrawn = sig;
    if (range)
      setSelectionRange(code, range.start, range.end);
    return code;
  }

  // 改语言：同步 dataset.lang → 原文首行围栏，并立即按新语言重着色。
  // 重着色只重建 <code> 的行内 span（只变颜色，不变字号/行高/宽度），
  // 因此块几何不变；光标在正文里时按字符偏移恢复。
  function applyCodeLang(el, value) {
    // 语言标识不允许空白与反引号（会破坏首行围栏），直接剔除；
    // 保证「徽标显示 === dataset.lang === 围栏内容」三者一致。
    var lang = String(value === undefined || value === null ? '' : value)
      .replace(/[\s`]/g, '');
    var badge = el.querySelector('.code-lang');
    if (badge && badge.textContent !== lang) {
      badge.textContent = lang;
      badge.title = lang;
    }
    el.dataset.lang = lang;
    el.dataset.raw = codeRaw(el);
    el._codeStale = false;
    if (codeEl(el))
      drawCode(el);
    scheduleMermaid();
  }

  // 把代码正文重新着色：只重建 <code> 的行内 span（文本不变，字体/行高/宽度
  // 都不变），随后按字符偏移把光标放回原处。组合输入期间不调用。
  function syncCode(el, highlight) {
    var code = codeEl(el);
    if (!code)
      return;
    var text = code.textContent;
    el.dataset.raw = codeRaw(el, text);
    updateGutter(el, text);
    el._codeStale = false;
    if (highlight)
      drawCode(el);
  }

  // 在代码正文的选区处插入纯文本（回车、粘贴共用）。返回值表示是否处理成功；
  // 成功时同步原文/行号并保持光标在插入内容之后。
  function insertCodeText(el, text) {
    var code = codeEl(el);
    if (!code)
      return false;
    var range = rangeIn(code);
    var value = code.textContent;
    if (!range)
      range = { start: value.length, end: value.length };
    var next = value.slice(0, range.start) + text + value.slice(range.end);
    el.dataset.raw = codeRaw(el, next);
    updateGutter(el, next);
    el._codeStale = false;
    setCodeHtml(el, code, highlightCode(el, next, el.dataset.lang).join('\n'));
    el._codeDrawn = (el.dataset.lang || '') + '\n' + next;
    setSelectionRange(code, range.start + text.length);
    return true;
  }

  return {
    blockOf: blockOf,
    setCaret: setCaret,
    offsetIn: offsetIn,
    rangeIn: rangeIn,
    ensureLangBadge: ensureLangBadge,
    applyCodeLang: applyCodeLang,
    syncCode: syncCode,
    insertCodeText: insertCodeText
  };
  })();

  var blockOf = CaretCode.blockOf;
  var setCaret = CaretCode.setCaret;
  var offsetIn = CaretCode.offsetIn;
  var rangeIn = CaretCode.rangeIn;
  var ensureLangBadge = CaretCode.ensureLangBadge;
  var applyCodeLang = CaretCode.applyCodeLang;
  var syncCode = CaretCode.syncCode;
  var insertCodeText = CaretCode.insertCodeText;
