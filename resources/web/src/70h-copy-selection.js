  var CopySelection = (function copySelectionModule() {

  // 选区 → 纯文本。块与块之间必须补一个换行：textContent 会把相邻块的文字
  // 直接粘在一起（跨两段复制曾得到「第一段第二段」）。块内仍按复制规则清理。
  // 复制、剪切与右键菜单共用这一个口径。
  function selectionPlainText() {
    // 自建跨块选区：原生选区是折叠的，必须按绝对区间自己取文本
    if (crossSel)
      return TableCross.crossSelectionPlainText();
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return '';
    var range = selection.getRangeAt(0);
    var blocks = selectedBlocks();
    var parts = [];
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var sub = document.createRange();
      sub.selectNodeContents(el);
      if (el.contains(range.startContainer))
        sub.setStart(range.startContainer, range.startOffset);
      if (el.contains(range.endContainer))
        sub.setEnd(range.endContainer, range.endOffset);
      parts.push(ClipboardPaste.cleanCopyFragment(sub.cloneContents()));
    }
    return parts.join('\n');
  }

  // 块内真正的语义元素（h1/ul/pre…）。段落块没有内层元素，包装时用 <p>。
  function blockSemantic(el) {
    if (!el || !el.querySelector)
      return null;
    return el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, ' +
                             ':scope > h5, :scope > h6, :scope > p, :scope > ul, ' +
                             ':scope > ol, :scope > blockquote, :scope > pre, ' +
                             ':scope > table');
  }

  // 外部应用没有本页 CSS，只靠 class 拿不到标题字号与列表符号，必须把计算样式
  // 内联。WKWebView 写剪贴板时会保留 style 属性、丢掉 class，这层正好兜住。
  var COPY_STYLE_PROPS = ['font-size', 'font-weight', 'font-style', 'font-family',
                          'color', 'text-decoration', 'list-style-type',
                          'margin-top', 'margin-bottom', 'padding-left',
                          'white-space', 'background-color'];

  function applyCopyStyle(source, target) {
    if (!source || !window.getComputedStyle || !target.style)
      return;
    var cs = window.getComputedStyle(source);
    for (var i = 0; i < COPY_STYLE_PROPS.length; i++) {
      var value = cs.getPropertyValue(COPY_STYLE_PROPS[i]);
      if (value)
        target.style.setProperty(COPY_STYLE_PROPS[i], value);
    }
  }

  // 代码高亮全靠 class，外部应用没有本页样式表，复制出去会退化成单色。
  // 克隆内容与原文按文档顺序一一对应，因此可以直接把每个 token 的计算颜色
  // 内联到克隆节点；与父级同色的 token（本来就没有专用颜色）保持继承，不硬造。
  function inlineCodeTokenColors(source, sub, shell) {
    if (!source || !source.querySelectorAll || !shell || !shell.querySelectorAll
        || !window.getComputedStyle || !sub)
      return;
    var candidates = source.querySelectorAll('[class*="tok-"]');
    var originals = [];
    for (var i = 0; i < candidates.length; i++) {
      if (sub.intersectsNode(candidates[i]))
        originals.push(candidates[i]);
    }
    var clones = shell.querySelectorAll('[class*="tok-"]');
    if (!originals.length || originals.length !== clones.length)
      return;
    for (var j = 0; j < originals.length; j++) {
      var own = window.getComputedStyle(originals[j]).color;
      var parentEl = originals[j].parentElement;
      var inherited = parentEl ? window.getComputedStyle(parentEl).color : '';
      if (own && own !== inherited)
        clones[j].style.color = own;
    }
  }

  // 选区 → HTML。与纯文本同口径（按块裁剪、跨块逐个取），但保留块级语义，
  // 粘到 Word / 邮件 / TextEdit 里仍有标题层级、列表符号与代码块的样子。
  // 复制走 HTML 是给“粘到外部应用”用的；粘回 Mote 仍只读 text/plain。
  function selectionHtml() {
    // 自建跨块选区：原生选区是折叠的，必须按绝对区间自己取 HTML
    if (crossSel)
      return crossSelectionHtml();
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return '';
    var range = selection.getRangeAt(0);
    var blocks = selectedBlocks();
    var holder = document.createElement('div');
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var sub = document.createRange();
      sub.selectNodeContents(el);
      if (el.contains(range.startContainer))
        sub.setStart(range.startContainer, range.startOffset);
      if (el.contains(range.endContainer))
        sub.setEnd(range.endContainer, range.endOffset);
      var fragment = sub.cloneContents();
      var inner = blockSemantic(el);
      var only = fragment.childNodes.length === 1 ? fragment.firstChild : null;
      var shell;
      // 整块选中时 cloneContents 已经带出内层语义标签（<h1>、<ul>…），不能再套
      // 一层；否则外壳要按语义元素重建。早先拿外层块 div 当外壳，内层 <h1> 不在
      // 选区里，HTML 里只剩 <div class="block h1">，外部应用拿不到标题层级。
      if (inner && only && only.nodeType === 1 && only.nodeName === inner.nodeName) {
        shell = only;
      } else {
        shell = document.createElement(inner ? inner.tagName.toLowerCase() : 'p');
        shell.appendChild(fragment);
      }
      applyCopyStyle(inner || el, shell);
      inlineCodeTokenColors(el, sub, shell);
      holder.appendChild(shell);
    }
    sanitizeCopyHtml(holder);
    return holder.innerHTML;
  }

  // 编辑器专用节点与属性对粘贴目标没有意义，甚至会把 contenteditable 一起带过去。
  function sanitizeCopyHtml(holder) {
    // 零宽标记（#、-、反引号等）在编辑器里靠 font-size:0 藏起来，粘到 Word /
    // 邮件时没有这份 CSS 就会原样露出来，必须连同 gutter 一起剥掉。
    var junk = holder.querySelectorAll('.mk, .gutter, .line-numbers, .code-tools, .code-lang');
    for (var i = junk.length - 1; i >= 0; i--) {
      if (junk[i].parentNode)
        junk[i].parentNode.removeChild(junk[i]);
    }
    var all = holder.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var e = all[j];
      e.removeAttribute('contenteditable');
      e.removeAttribute('spellcheck');
      e.removeAttribute('id');
      var attrs = e.attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        if (attrs[k].name.indexOf('data-') === 0)
          e.removeAttribute(attrs[k].name);
      }
      if (e.classList) {
        e.classList.remove('editing', 'focused', 'placeholder', 'empty');
        if (!e.classList.length)
          e.removeAttribute('class');
      }
    }
    // 行内代码在页内靠 CSS 取等宽字体，复制出去只剩 <code> 语义；Word 的 HTML
    // 导入不认 UA 默认等宽，会把它并进正文东亚字体（实测变宋体），这里显式内联
    // 等宽字体栈。代码块（<pre> 内）本来就有自己的样式，不动。
    var codes = holder.querySelectorAll('code');
    for (var c = 0; c < codes.length; c++) {
      if (!codes[c].closest || !codes[c].closest('pre'))
        codes[c].style.setProperty('font-family', 'Menlo, Consolas, monospace');
    }
  }

  // 「有没有可复制 / 可剪切的内容」的唯一判定：空段落块会算出 "\n"，因此纯空白
  // 一律视为没有内容。这里只做判断、不改写文本本身——选中含前后空白的真实文本
  // 仍按原样复制，不会因为判空白顺带 trim 掉用户内容。
  function clipboardTextIsBlank(text) {
    return !text || !text.trim();
  }

  // 原生 copy 事件：只在编辑区接管，源码模式交给 textarea 自己。
  // text/plain 给粘回 Mote 与纯文本编辑器；text/html 给 Word / 邮件这类目标，
  // macOS 由 WebKit 落到 NSPasteboard 的 public.html，Windows 由宿主写 CF_HTML。
  document.addEventListener('copy', function (event) {
    if (!event.clipboardData || mode === 'source')
      return;
    var text = selectionPlainText();
    if (clipboardTextIsBlank(text)) {
      // 不写剪贴板：否则空段落块的 "\n" 会覆盖用户上一次复制的内容
      event.preventDefault();
      Util.post({ type: 'status', message: '没有可复制的内容：先选中文字' });
      return;
    }
    event.clipboardData.setData('text/plain', text);
    var html = selectionHtml();
    if (html)
      event.clipboardData.setData('text/html', html);
    event.preventDefault();
  });

  // 剪切事件：macOS 走 AppKit 的 cut: 时进入这里（Windows 由宿主直接调
  // clipboardCopy）。纯空白选区要连同删除一起取消，两个平台行为才一致。
  document.addEventListener('cut', function (event) {
    if (mode === 'source')
      return;
    if (crossSel) {
      // 原生选区是折叠的，WebKit 不会自己剪切：算好内容写剪贴板再删区间
      event.preventDefault();
      var crossText = TableCross.crossSelectionPlainText();
      if (event.clipboardData) {
        if (!clipboardTextIsBlank(crossText))
          event.clipboardData.setData('text/plain', crossText);
        var crossHtml = crossSelectionHtml();
        if (crossHtml)
          event.clipboardData.setData('text/html', crossHtml);
      }
      replaceCrossSelection('');
      return;
    }
    if (!clipboardTextIsBlank(selectionPlainText()))
      return;
    event.preventDefault();
    Util.post({ type: 'status', message: '没有可剪切的内容：先选中文字' });
  });

  return {
    selectionPlainText: selectionPlainText,
    blockSemantic: blockSemantic,
    applyCopyStyle: applyCopyStyle,
    inlineCodeTokenColors: inlineCodeTokenColors,
    selectionHtml: selectionHtml,
    sanitizeCopyHtml: sanitizeCopyHtml,
    clipboardTextIsBlank: clipboardTextIsBlank
  };
  })();
