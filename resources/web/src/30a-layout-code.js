  var LayoutCode = (function layoutCodeModule() {
  /* ---------------- Markdown 渲染 ---------------- */

  // 按空行切块，同时记录块间空行：改动前只取块文本，连续多个空行会被归并成
  // 固定的 2 个换行。gaps[i] 是第 i 块之前的换行数（gaps[0] 即文首空行），
  // trail 是最后一块之后的换行数；围栏代码块内部的空行不切块也不计入间隔。
  function splitSourceLayout(text) {
    var source = String(text).replace(/\r\n?/g, '\n');
    var lines = source.split('\n');
    var blocks = [];
    var gaps = [];
    var current = [];
    var pending = 0;      // 刚才跨过的空行数，等下一块出现时归到它的间隔里
    var inFence = false;
    var started = false;
    var listKind = null;  // 当前块的列表标记类型：'ul' / 'ol'

    function flush() {
      if (!current.length)
        return;
      // 内容之间：k 个空行对应 k+1 个换行；文首没有前一块，空行数就是换行数
      gaps.push(started ? pending + 1 : pending);
      blocks.push(current.join('\n'));
      current = [];
      pending = 0;
      started = true;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*```/.test(line))
        inFence = !inFence;
      if (!inFence && line.trim() === '') {
        flush();
        pending++;
        listKind = null;
        continue;
      }
      if (!inFence) {
        var marker = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+/);
        var kind = marker ? (marker[1] ? 'ul' : 'ol') : null;
        // 有序列表和无序列表紧挨着（中间没有空行）时，标记类型一变就断开成两块；
        // 否则整段会被当成普通段落，列表标记和缩进都丢了。
        if (kind && listKind && kind !== listKind)
          flush();
        listKind = kind;
      } else {
        listKind = null;
      }
      current.push(line);
    }
    flush();

    var trail = pending;
    if (!blocks.length) {
      // 整篇没有正文：保留一个空块，换行全部算文末（lines.length - 1 才是
      // 真实的换行数，末尾 split 出的空串不算一个换行）
      blocks.push('');
      gaps.push(0);
      trail = Math.max(0, lines.length - 1);
    }
    return { blocks: blocks, gaps: gaps, trail: trail };
  }

  function trailingNewlineCount(text) {
    var match = /(\n*)$/.exec(String(text));
    return match ? match[1].length : 0;
  }

  function isCodeBlock(el) {
    return !!(el && el.classList && el.classList.contains('code'));
  }

  function codeEl(el) {
    return el ? el.querySelector('code') : null;
  }

  function codeText(el) {
    var code = codeEl(el);
    return code ? code.textContent : '';
  }

  // 代码块原文 = 围栏 + 正文。围栏不进 DOM（连零宽标记也不需要），正文与语言
  // 分别存在 <code> 文本和 dataset.lang 里，编辑过程中逐次重新拼接。
  function codeRaw(el, text) {
    var lang = el.dataset.lang || '';
    text = text === undefined ? codeText(el) : String(text);
    return '```' + lang + '\n' + text + (text ? '\n```' : '```');
  }

  // dataset.raw 中正文的起始下标（"```lang\n" 的长度），用于整篇偏移 ↔ 块内偏移
  function codePrefixLength(el) {
    var match = /^```[^\n]*\n?/.exec(el.dataset.raw || '');
    return match ? match[0].length : 0;
  }

  function updateGutter(el, text) {
    var gutter = el.querySelector('.gutter');
    if (!gutter)
      return;
    var value = String(text === undefined ? codeText(el) : text);
    var count = 1;
    for (var i = value.indexOf('\n'); i >= 0; i = value.indexOf('\n', i + 1))
      count++;
    // 行号只跟行数有关：行数不变就连 DOM 都不碰（读 innerHTML 本身要整段序列化）
    if (gutter._count === count)
      return;
    var html = '';
    for (var n = 0; n < count; n++)
      html += (n ? '<br>' : '') + (n + 1);
    gutter.innerHTML = html;
    gutter._count = count;
  }

  // 行号栏是「1<br>2<br>3」结构，每个文本节点恰好是一行。点行号时按纵向命中
  // 判断点了第几行：横向命中点（框右侧 +2）在长行时会落到 <code> 外面，取不到
  // 代码里的偏移，只能退化成块首。
  function gutterLineAt(gutter, y) {
    var line = -1;
    var best = Infinity;
    var index = -1;
    for (var node = gutter.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 3)
        continue;
      index++;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rect = range.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom)
        return index;
      var distance = y < rect.top ? rect.top - y : y - rect.bottom;
      if (distance < best) {
        best = distance;
        line = index;
      }
    }
    return line < 0 ? 0 : line;
  }

  // 第 line 行（0 起）在 <code> 文本里的起始下标
  function codeLineStart(code, line) {
    var text = code.textContent;
    var offset = 0;
    for (var i = 0; i < line; i++) {
      var next = text.indexOf('\n', offset);
      if (next < 0)
        return text.length;
      offset = next + 1;
    }
    return offset;
  }

  // 代码块右上角浮层的两个图标：与页面同用线性描边 + currentColor，
  // 复制按钮平时半透明，hover 才显形；成功后短暂换成对勾。
  var COPY_ICON = '<svg class="i-copy" viewBox="0 0 16 16" width="12" height="12"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">'
    + '<rect x="5.4" y="5.4" width="7.8" height="7.8" rx="1.6"></rect>'
    + '<path d="M10.6 5.4V4.2A1.8 1.8 0 0 0 8.8 2.4H4.2A1.8 1.8 0 0 0 2.4 4.2v4.6'
    + 'a1.8 1.8 0 0 0 1.8 1.8h1.2"></path></svg>';
  var DONE_ICON = '<svg class="i-done" viewBox="0 0 16 16" width="12" height="12"'
    + ' fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">'
    + '<path d="M3.2 8.6l3 3 6.6-6.8"></path></svg>';

  function renderCode(el, code, lang, defer) {
    // 结尾的 \n 属于正文（末行之后的空行），不能再剥掉，否则编辑-重排往返会
    // 悄悄少一行；围栏前那个 \n 已由 renderBlock 的匹配式吃掉。
    var lines = String(code).split('\n');
    var colored;
    if (defer && hasLangSpec(lang)) {
      // 未识别语言本来就只有转义成本，不值得延迟
      colored = lines.map(escapeHtml);
      if (!deferredCode)
        deferredCode = [];
      deferredCode.push({ el: el, code: lines.join('\n'), lang: lang });
    } else {
      colored = highlightCode(el, lines.join('\n'), lang);
    }
    var gutter = '';
    for (var i = 0; i < lines.length; i++)
      gutter += (i ? '<br>' : '') + (i + 1);
    // 行号是独立的一栏（contenteditable=false + user-select:none），它在滚动容器
    // 之外：横向滚动只作用于代码，行号与分隔线始终留在左侧。不用 position:sticky
    // ——sticky 与横向滚动条共存时，WebKit 在整篇重建后会把块高少算一个滚动条。
    //
    // 代码块顶部头栏（.code-tools）在代码块内部：语言徽标靠左，复制按钮绝对定位
    // 在代码块内部右上角。头栏是独立一行，横向滚动只发生在下方 .code-scroll 里，
    // 按钮不会跟着滚走；语言名过长时徽标自身截断（max-width），按钮固定在右上角。
    // 徽标可点开语言选择器，紧跟的空 span 是纯 CSS 画的展开箭头（无文本，
    // 不进 textContent/剪贴板），打开时由 aria-expanded 触发旋转。
    // 按钮在渲染态即可点，不必先进入编辑。
    // 文本不进 <code>、也不进 dataset.raw 的正文部分——原文首行围栏由 dataset.lang 拼回。
    return '<pre class="code-block">'
      + '<div class="code-tools" contenteditable="false">'
      + '<span class="code-lang" contenteditable="false" spellcheck="false"'
      + ' role="button" aria-haspopup="listbox" aria-expanded="false"'
      + (lang ? ' title="' + escapeHtml(lang) + '"' : '')
      + ' aria-label="代码语言">' + escapeHtml(lang || '') + '</span>'
      + '<span class="code-lang-caret" aria-hidden="true"></span>'
      + '<button type="button" class="code-copy" tabindex="-1"'
      + ' aria-label="复制代码" title="复制代码">' + COPY_ICON + DONE_ICON + '</button>'
      + '</div>'
      + '<div class="gutter" contenteditable="false" aria-hidden="true">' + gutter + '</div>'
      + '<div class="code-scroll"><code>' + colored.join('\n') + '</code></div></pre>';
  }

  // 代码块复制按钮：只写 <code> 里的正文（行号栏、语言徽标都不在 <code> 内），
  // 多行与制表符原样保留。走与复制/剪切同一条 clipboardWrite 回路，不另造剪贴板
  // 逻辑；成功只在按钮上做短暂反馈，不弹对话框，也不进入编辑态、不动撤销栈。
  function copyCodeBlock(btn) {
    var block = btn && btn.closest ? btn.closest('.block.code') : null;
    if (!block)
      return;
    post({ type: 'clipboardWrite', text: codeText(block) });
    btn.classList.add('copied');
    if (btn._copiedTimer)
      clearTimeout(btn._copiedTimer);
    btn._copiedTimer = setTimeout(function () {
      btn.classList.remove('copied');
      btn._copiedTimer = null;
    }, 1200);
  }

  // WebKit 在整篇重建（撤销/重做、预览↔源码）后，不会把横向滚动条的高度算进
  // .code-scroll 的 border box，块高会比初次渲染少一个滚动条（本机实测 15px）。
  // 关键是要动 overflow-y：横向滚动条是画在纵轴这块空间里的，只改 overflow-x
  // 不会让 WebKit 重新计算滚动条占位；改成 auto 再还原即可触发一次正确布局。
  // 优化：两段式批量——先全部写 auto（不强制布局），单次读 offsetHeight 触发
  // 一次布局，再全部还原。把 N 次强制重排压缩成 1 次（9000+ 块场景从 ~5.5s 降到
  // 几十毫秒）。
  function normalizeCodeScrolls(scope) {
    var list = (scope || root).querySelectorAll('.code-scroll');
    if (!list.length)
      return;
    var original = new Array(list.length);
    for (var i = 0; i < list.length; i++) {
      original[i] = list[i].style.overflowY;
      list[i].style.overflowY = 'auto';
    }
    void list[0].offsetHeight;
    for (var i = 0; i < list.length; i++) {
      list[i].style.overflowY = original[i];
    }
  }

  // 语言是否有着色规则（无规则的高亮本来就只是转义，不必延迟）。
  function hasLangSpec(lang) {
    var key = LANG_ALIAS[String(lang || '').trim().toLowerCase()] || '';
    return !!key && !!SPEC[key];
  }

  // 补画一个延迟代码块：文本已被编辑改动就跳过（编辑路径自己会重着色）；
  // 光标正落在其中也跳过，避免打断选区——编辑路径随后会接管着色。
  // 只换 innerHTML 里的 span（几何不变），不读滚动位置：读 scrollLeft 会
  // 在批量补画时反复强制布局。
  function drawDeferredCode(entry) {
    var el = entry.el;
    var code = el.isConnected ? codeEl(el) : null;
    if (!code || code.textContent !== entry.code)
      return;
    var sel = window.getSelection();
    if (sel && sel.anchorNode && code.contains(sel.anchorNode))
      return;
    code.innerHTML = highlightCode(el, entry.code, entry.lang).join('\n');
    el._codeDrawn = (el.dataset.lang || '') + '\n' + entry.code;
  }

  // 整篇挂载后结算延迟高亮：前 FIRST_PAINT_BLOCKS 块（约覆盖首屏）立即补画，
  // 其余在浏览器空闲时分批补画（每批 80 块）。不用 IntersectionObserver：
  // 上千个 observe() 会强制整篇布局并阻塞 setMarkdown；空闲分批既不打断
  // 交互，也保证滚到之前基本画完。
  var FIRST_PAINT_BLOCKS = 30;
  function flushDeferredCode() {
    if (deferredCodeTimer) {
      clearTimeout(deferredCodeTimer);
      deferredCodeTimer = 0;
    }
    var list = deferredCode;
    deferredCode = null;
    if (!list || !list.length)
      return;
    var head = list.length < FIRST_PAINT_BLOCKS ? list.length : FIRST_PAINT_BLOCKS;
    for (var i = 0; i < head; i++)
      drawDeferredCode(list[i]);
    if (list.length <= head)
      return;
    var cursor = head;
    function pump() {
      deferredCodeTimer = 0;
      var end = Math.min(cursor + 80, list.length);
      while (cursor < end) {
        drawDeferredCode(list[cursor]);
        cursor++;
      }
      // 帧间隔让路：每批约几毫秒，主线程仍能响应输入与绘制
      if (cursor < list.length)
        deferredCodeTimer = setTimeout(pump, 16);
    }
    deferredCodeTimer = setTimeout(pump, 16);
  }

  return {
    splitSourceLayout: splitSourceLayout,
    trailingNewlineCount: trailingNewlineCount,
    isCodeBlock: isCodeBlock,
    codeEl: codeEl,
    codeText: codeText,
    codeRaw: codeRaw,
    codePrefixLength: codePrefixLength,
    updateGutter: updateGutter,
    gutterLineAt: gutterLineAt,
    codeLineStart: codeLineStart,
    renderCode: renderCode,
    copyCodeBlock: copyCodeBlock,
    normalizeCodeScrolls: normalizeCodeScrolls,
    flushDeferredCode: flushDeferredCode
  };
  })();

  var splitSourceLayout = LayoutCode.splitSourceLayout;
  var trailingNewlineCount = LayoutCode.trailingNewlineCount;
  var isCodeBlock = LayoutCode.isCodeBlock;
  var codeEl = LayoutCode.codeEl;
  var codeText = LayoutCode.codeText;
  var codeRaw = LayoutCode.codeRaw;
  var codePrefixLength = LayoutCode.codePrefixLength;
  var updateGutter = LayoutCode.updateGutter;
  var gutterLineAt = LayoutCode.gutterLineAt;
  var codeLineStart = LayoutCode.codeLineStart;
  var renderCode = LayoutCode.renderCode;
  var copyCodeBlock = LayoutCode.copyCodeBlock;
  var normalizeCodeScrolls = LayoutCode.normalizeCodeScrolls;
  var flushDeferredCode = LayoutCode.flushDeferredCode;
