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

  // 未转义 | 的下标。逐字符扫描而不是用正则后行断言：后者在 WebKit 16.4 之前
  // 是解析期语法错误，整份脚本都会加载失败。
  function pipeIndexes(line) {
    var out = [];
    for (var i = 0; i < line.length; i++) {
      // 前面是反斜杠的 \| 是单元格内容（Markdown 转义），不是列分隔符
      if (line.charAt(i) === '|' && line.charAt(i - 1) !== '\\')
        out.push(i);
    }
    return out;
  }

  // 按未转义的 | 切分，转义的 \| 原样留在片段里。
  function splitPipes(text) {
    var pipes = pipeIndexes(text);
    var out = [];
    var from = 0;
    for (var p = 0; p < pipes.length; p++) {
      out.push(text.slice(from, pipes[p]));
      from = pipes[p] + 1;
    }
    out.push(text.slice(from));
    return out;
  }

  function tableCells(line) {
    var trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    // 转义的 \| 不是分隔符；切分后再把单元格里的 \| 还原成 |
    return splitPipes(trimmed).map(function (cell) {
      return cell.trim().replace(/\\\|/g, '|');
    });
  }

  function isTableSource(lines) {
    return lines.length >= 2 && lines[0].indexOf('|') >= 0
      && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1]) && lines[1].indexOf('-') >= 0;
  }

  // 表格行拆成「前导边框 + 单元格 + 分隔符 + 尾随空白」，满足
  // lead + Σ(text + sep) + tail === line。单元格被就地编辑后仍能拼回逐字原文，
  // 不依赖 textContent 已丢失的 | 与对齐行。
  function splitTableLine(line) {
    var pipes = pipeIndexes(line);
    if (!pipes.length)
      return { lead: '', cells: [{ text: line, sep: '' }], tail: '' };

    var lead = '';
    var cellStart = 0;
    var seps = pipes.slice();
    if (line.slice(0, pipes[0]).trim() === '') {   // 起始竖线是边框
      lead = line.slice(0, pipes[0] + 1);
      cellStart = pipes[0] + 1;
      seps = seps.slice(1);
    }
    var trail = -1;
    if (seps.length && line.slice(pipes[pipes.length - 1] + 1).trim() === '')
      trail = pipes[pipes.length - 1];              // 末尾竖线是边框

    var cells = [];
    var from = cellStart;
    for (var s = 0; s < seps.length; s++) {
      if (seps[s] === trail)
        break;
      cells.push({ text: line.slice(from, seps[s]), sep: '|' });
      from = seps[s] + 1;
    }
    var end = trail >= 0 ? trail : line.length;
    cells.push({ text: line.slice(from, end), sep: trail >= 0 ? '|' : '' });
    return { lead: lead, cells: cells, tail: trail >= 0 ? line.slice(trail + 1) : '' };
  }

  function tableAlignments(line) {
    return tableCells(line).map(function (cell) {
      var left = cell.charAt(0) === ':';
      var right = cell.charAt(cell.length - 1) === ':';
      return left && right ? 'center' : (right ? 'right' : (left ? 'left' : ''));
    });
  }

  // 表格里的 | / 对齐行 / 换行都是零宽标记：参与 textContent（dataset.raw 靠它
  // 逐字还原原文），但不占版面；pipe 标记不带 <i>，编辑时不会浮出淡色标签。
  function pipeMarker(text) {
    return '<span class="mk mk-pipe" contenteditable="false">' + escapeHtml(text) + '</span>';
  }

  function tableRowHtml(line, align, tag, withNewline) {
    var row = splitTableLine(line);
    var html = '<tr>';
    for (var c = 0; c < row.cells.length; c++) {
      var cell = row.cells[c];
      var style = align[c] ? ' style="text-align:' + align[c] + '"' : '';
      html += '<' + tag + style + '>';
      if (c === 0 && row.lead)
        html += pipeMarker(row.lead);
      // 单元格内容里的转义 \|：反斜杠收进零宽标记（textContent 保留 \ 逐字），
      // 竖线可见渲染。这样显示是 |，而 splitTableLine 仍认得它是内容不是分隔符。
      var cellText = cell.text;
      if (cellText.indexOf('\\|') >= 0) {
        var segs = cellText.split('\\|');
        for (var g = 0; g < segs.length; g++) {
          if (g > 0)
            html += '<span class="mk mk-pipeesc" contenteditable="false">\\</span>|';
          html += renderInline(segs[g]);
        }
      } else {
        html += renderInline(cellText);
      }
      if (cell.sep)
        html += pipeMarker(cell.sep);
      if (c === row.cells.length - 1) {
        if (row.tail)
          html += pipeMarker(row.tail);
        if (withNewline)
          html += newlineMarker();
      }
      html += '</' + tag + '>';
    }
    return html + '</tr>';
  }

  // 列宽算法：WKWebView 的 auto 布局会把表格剩余空间「按列均分」，内容短的
  // 表格必然趋向等宽；Chromium（Typora）则按内容加权。引擎差异无法用 CSS
  // 消除，所以这里直接测量每列可见文本的最大内容宽度，按比例注入 colgroup
  // 百分比，任何引擎下列宽都由内容决定。
  var measureCtx = null;
  function measureTextWidth(text, bold) {
    if (!measureCtx)
      measureCtx = document.createElement('canvas').getContext('2d');
    var cs = getComputedStyle(document.body);
    var px = (parseFloat(cs.fontSize) || 16) * 0.95;   // table { font-size: 0.95em }
    measureCtx.font = (bold ? '600 ' : '300 ') + px + 'px ' + (cs.fontFamily || 'sans-serif');
    return measureCtx.measureText(text).width;
  }

  // 单元格原文 → 可见纯文本：链接/图片取文字、行内代码与强调去符号。
  // 注意：不要命名为 cellVisibleText——2058 行已有同名 DOM 节点版本，
  // 同作用域函数声明会相互覆盖。
  function stripMarkdownForWidth(text) {
    return text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|~~|\*|_)/g, '')
      .replace(/\\\|/g, '|')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
  }

  // 单元格渲染宽度 = 内容 + 两侧空格 + padding。DOM 里是 `|␣内容␣|`：
  // 空格夹在 pipe 标记与文本之间，不在行首/行尾，不参与折叠，必须计入；
  // 否则窄列会差着这两个空格刚好折行（不可断词被挤到下一行）。
  function cellEdgeWidth(text, bold) {
    return measureTextWidth(stripMarkdownForWidth(text), bold)
      + 2 * measureTextWidth(' ', bold) + COL_CELL_PAD_PX;
  }

  // 参照 wolai / Notion 的列宽策略，落实标准 auto 表格布局算法：
  //   · hi = max-content：最长行宽，封顶（超长内容换行，不无限吃掉其他列）；
  //   · lo = min-content：最长不可断段宽（长英文词/URL 不拦腰截断；
  //     CJK 可逐字断行，不抬高 lo）；
  //   · 空间充裕按内容比例拉伸；空间紧张先保 lo，再按增长空间 (hi-lo)
  //     分配剩余；连 lo 都放不下时保持 lo 宽、表格横向溢出滚动
  //     （wolai/Notion 都是滚动而不是把词压碎）。
  var COL_MIN_PX = 90;      // 短列保护：不被挤压到逐字换行
  var COL_MAX_PX = 460;     // 长列封顶
  var COL_CELL_PAD_PX = 24; // th/td 左右 padding 12px
  var COL_SAFETY_PX = 4;    // 百分比→像素取整误差余量，防不可断词差 1px 被折行
  var COL_FALLBACK_W = 685; // 块尚未入文档时的 #editor 内容宽（50rem - 2×3.6rem）

  // 最长不可断段宽度：CJK 每个字、空白两侧都可断行，其余连续非空白段不可断。
  var CJK_BREAK = '-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿';
  var MIN_UNIT_RE = new RegExp('[' + CJK_BREAK + ']|[^\\s' + CJK_BREAK + ']+', 'g');

  function minContentWidth(text, bold) {
    var plain = stripMarkdownForWidth(text);
    var units = plain.match(MIN_UNIT_RE);
    var best = 0;
    for (var i = 0; units && i < units.length; i++)
      best = Math.max(best, measureTextWidth(units[i], bold));
    return best + 2 * measureTextWidth(' ', bold) + COL_CELL_PAD_PX + COL_SAFETY_PX;
  }

  function tableColgroupHtml(head, bodyLines, availW) {
    var n = head.cells.length;
    if (!n)
      return { colgroup: '', minWidth: 0 };
    var lo = [];
    var hi = [];
    for (var c = 0; c < n; c++) {
      lo[c] = COL_MIN_PX;
      hi[c] = COL_MIN_PX;
    }
    function considerCells(cells, bold) {
      for (var k = 0; k < cells.length && k < n; k++) {
        hi[k] = Math.max(hi[k], cellEdgeWidth(cells[k].text, bold));
        lo[k] = Math.max(lo[k], minContentWidth(cells[k].text, bold));
      }
    }
    considerCells(head.cells, true);
    for (var r = 0; r < bodyLines.length; r++)
      considerCells(splitTableLine(bodyLines[r]).cells, false);
    var sumLo = 0;
    var sumHi = 0;
    for (var m = 0; m < n; m++) {
      hi[m] = Math.max(COL_MIN_PX, Math.min(hi[m], COL_MAX_PX));
      lo[m] = Math.max(COL_MIN_PX, Math.min(lo[m], COL_MAX_PX));
      if (lo[m] > hi[m])
        hi[m] = lo[m];
      sumLo += lo[m];
      sumHi += hi[m];
    }
    var W = availW > 100 ? availW : COL_FALLBACK_W;
    var widths = [];
    var base;
    if (sumHi <= W) {
      for (var a = 0; a < n; a++)
        widths[a] = hi[a];
      base = sumHi;              // 百分比铺满容器 = 按内容比例拉伸
    } else if (sumLo <= W) {
      var grow = 0;
      for (var b = 0; b < n; b++)
        grow += hi[b] - lo[b];
      var extra = W - sumLo;
      for (var d = 0; d < n; d++)
        widths[d] = grow > 0
          ? lo[d] + extra * (hi[d] - lo[d]) / grow
          : lo[d] + extra / n;   // 全列都到上限：剩余空间均分
      base = W;
    } else {
      for (var e = 0; e < n; e++)
        widths[e] = lo[e];
      base = sumLo;              // 溢出：保持 min-content 宽，横向滚动
    }
    var out = '<colgroup>';
    for (var f = 0; f < n; f++)
      out += '<col style="width:' + (widths[f] / base * 100).toFixed(2) + '%"/>';
    return { colgroup: out + '</colgroup>', minWidth: sumLo > W ? Math.ceil(sumLo) : 0 };
  }

  function renderTable(lines, el) {
    var align = tableAlignments(lines[1]);
    var head = splitTableLine(lines[0]);
    var body = [];
    for (var r = 2; r < lines.length; r++) {
      if (lines[r].trim())
        body.push(lines[r]);
    }
    // 对齐行不参与渲染（display:none，零高度），但原文按 DOM 顺序留在表头与表体
    // 之间，textContent 才能逐字还原 `| a | b |\n|---|...|`。
    var layout = tableColgroupHtml(head, body, el ? el.clientWidth : 0);
    var html = '<table class="md-table"'
      + (layout.minWidth ? ' style="min-width:' + layout.minWidth + 'px"' : '')
      + '>' + layout.colgroup + '<thead>'
      + tableRowHtml(lines[0], align, 'th', true)
      + '<tr class="tbl-align" aria-hidden="true"><td colspan="' + Math.max(1, head.cells.length) + '">'
      + escapeHtml(lines[1]) + (body.length ? newlineMarker() : '') + '</td></tr>'
      + '</thead><tbody>';
    for (var b = 0; b < body.length; b++)
      html += tableRowHtml(body[b], align, 'td', b < body.length - 1);
    return html + '</tbody></table>';
  }

  function tableCellList(el) {
    var out = [];
    var rows = el.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].classList.contains('tbl-align'))
        continue;
      for (var c = 0; c < rows[r].children.length; c++)
        out.push(rows[r].children[c]);
    }
    return out;
  }

  // 最后一格按 Tab 追加一行：否则 Tab 在表格里走到尽头就无路可走，而回车又被
  // 定义为“不改结构”，表格将无法扩行。
  function appendTableRow(el) {
    var body = el.querySelector('tbody');
    var headRow = el.querySelector('thead tr');
    if (!body || !headRow)
      return false;
    var count = headRow.children.length;
    if (!count)
      return false;
    commitHistory();
    // 原来的最后一行没有换行标记（它就是原文最后一行）。追加前先补一个，
    // 否则新行会拼进上一行的 textContent，dataset.raw 里两行会变成同一行。
    var existing = body.children;
    if (existing.length) {
      var lastCell = existing[existing.length - 1].lastElementChild;
      if (lastCell)
        lastCell.insertAdjacentHTML('beforeend', newlineMarker());
    }
    var lines = String(el.dataset.raw || '').split('\n');
    var align = tableAlignments(lines[1] || '');
    var line = '|' + new Array(count + 1).join('  |');
    body.insertAdjacentHTML('beforeend', tableRowHtml(line, align, 'td', false));
    el.dataset.raw = el.textContent;
    scheduleDirty();
    scheduleCommit();
    commitHistory();
    return true;
  }

  // 在当前行上方/下方插入一个空行（Cmd+Shift+Enter / Cmd+Enter）。关键是让每行
  // 的换行标记与原文逐字对齐：原文里除末行外每行都以 \n 结尾，所以——
  //   · 插到下方：当前行保留自己的 \n；新行只在成为新末行时不带 \n，否则带。
  //   · 插到上方：新行必带 \n；当前行若原本是末行（原本无 \n）需补一个。
  // 任何一行漏掉 \n，相邻两行就会在 textContent 里粘连，下次重渲染被解析成
  // 同一行（列数翻倍）。光标始终落在新行同列的单元格末尾。
  function insertTableRow(el, below) {
    var cell = activeCell(el);
    if (!cell)
      return false;
    var row = cell.parentNode;
    if (!row || row.tagName !== 'TR' || row.classList.contains('tbl-align'))
      return false;
    var count = el.querySelector('thead tr').children.length;
    if (!count)
      return false;
    var lines = String(el.dataset.raw || '').split('\n');
    var align = tableAlignments(lines[1] || '');
    var line = '|' + new Array(count + 1).join('  |');
    commitHistory();
    var newRow = null;
    if (below) {
      // 当前行的换行标记始终保留（它是当前行的行尾）。新行只在"插到末行之后"
      // 时不带换行标记（它成为新末行）；其余情况新行后面还有行，必须带。
      var last = row.lastElementChild;
      var isLast = !(last && last.querySelector(':scope > .mk-nl'));
      if (row.parentNode.tagName === 'THEAD') {
        // 表头行下方同样不可插（新行会夹在表头与对齐行之间，原文第 2 行不再是
        // 对齐行），改为落到对齐行之后、表体首行。
        var tbody = el.querySelector('tbody');
        var hasBody = tbody.children.length > 0;
        tbody.insertAdjacentHTML('afterbegin', tableRowHtml(line, align, 'td', hasBody));
        newRow = tbody.firstElementChild;
      } else {
        row.insertAdjacentHTML('afterend', tableRowHtml(line, align, 'td', !isLast));
        if (isLast)
          last.insertAdjacentHTML('beforeend', newlineMarker());
        newRow = row.nextElementSibling;
      }
    } else {
      // 新行插到当前行上方，自身必须带换行标记（它后面还有当前行/对齐行）。
      // 当前行若原本是末行（没有换行标记），插入后不再是末行，必须补上，
      // 否则新行会拼进它的 textContent。表头行上方不可插（表头必须与对齐行
      // 相邻），此时新行改落表体首行——同样在表头"之上"，光标也落在那里。
      var had = row.lastElementChild && row.lastElementChild.querySelector(':scope > .mk-nl');
      var inHead = row.parentNode.tagName === 'THEAD';
      if (inHead) {
        var body = el.querySelector('tbody');
        body.insertAdjacentHTML('afterbegin', tableRowHtml(line, align, 'td', true));
        newRow = body.firstElementChild;
      } else {
        row.insertAdjacentHTML('beforebegin', tableRowHtml(line, align, 'td', true));
        if (!had) {
          var tail = row.lastElementChild;
          if (tail)
            tail.insertAdjacentHTML('beforeend', newlineMarker());
        }
        newRow = row.previousElementSibling;
      }
    }
    el.dataset.raw = el.textContent;
    caretInCellEnd(newRow.children[Math.min(cell.cellIndex, newRow.children.length - 1)]);
    scheduleDirty();
    scheduleCommit();
    commitHistory();
    return true;
  }

  function moveTableCell(el, delta) {
    var cells = tableCellList(el);
    if (!cells.length)
      return;
    var index = cells.indexOf(activeCell(el));
    if (index < 0)
      index = 0;
    var next = index + delta;
    if (next < 0)
      next = 0;
    if (next >= cells.length) {
      if (delta > 0 && appendTableRow(el)) {
        cells = tableCellList(el);
        next = index + 1;
      } else {
        next = cells.length - 1;
      }
    }
    caretInCellEnd(cells[next]);
  }

  // 任务列表项：复选框只是控件，"[ ] " / "[x] " 仍以零宽标记留在 DOM 里，
  // 保证 textContent 与 dataset.raw 逐字相等；控件本身无文本，复制不会带出额外字符。
  function renderListItem(line, lead, index) {
    var rest = line.slice(lead.length);
    var task = /^\[([ xX])\]\s+/.exec(rest);
    var indent = /^\s*/.exec(lead)[0].length;
    // 缩进子项在扁平列表里用左边距表达层级（原文的前导空格仍由标记承载）
    var style = indent ? ' style="margin-left:' + (indent * 0.6) + 'em"' : '';
    var head = (index && INLINE_PROTO ? newlineMarker() : '')
      + (INLINE_PROTO ? marker(lead, 'bullet') : '');
    if (!task)
      return '<li' + style + '>' + head + renderInline(rest) + '</li>';
    return '<li class="task"' + style + '>' + head
      // 任务标记不做成原子对象：编辑态它显示为可见文本，光标可以进入并用键盘
      // 把 [ ] 改成 [x]；渲染态 font-size:0 隐藏，由复选框代替。文字包一层 <i>，
      // 编辑态才能绝对定位压到复选框那块占位上，做到进出编辑态零位移。
      + (INLINE_PROTO ? '<span class="mk mk-task"><i>' + escapeHtml(task[0]) + '</i></span>' : '')
      + '<input type="checkbox" class="task-check" contenteditable="false" tabindex="-1"'
      + (task[1] === ' ' ? '' : ' checked') + '>'
      + renderInline(rest.slice(task[0].length)) + '</li>';
  }

  // 点击复选框：只改写该行的 [ ] / [x]，重新渲染并落一个撤销步。
  // 控件本身不承载文本，dataset.raw 与 textContent 仍由 .mk 标记保持一致。
  function toggleTaskCheckbox(box) {
    var li = box.closest ? box.closest('li') : null;
    var el = li ? blockOf(li) : null;
    if (!li || !el || !el.classList.contains('block'))
      return;
    var lines = rawOf(el).split('\n');
    var index = Array.prototype.indexOf.call(el.querySelectorAll('li'), li);
    if (index < 0 || index >= lines.length)
      return;
    var next = lines[index].replace(/^(\s*[-*+]\s+)\[([ xX])\]/, function (all, lead, mark) {
      return lead + (mark === ' ' ? '[x]' : '[ ]');
    });
    if (next === lines[index])
      return;
    lines[index] = next;
    commitHistory();
    applyRawToBlock(el, lines.join('\n'), undefined, undefined, false);
    setTimeout(commitHistory, 0);
  }

  function renderBlock(el, raw, deferHi) {
    raw = String(raw === undefined || raw === null ? '' : raw);
    var kind = 'p';
    var html = '';

    var fence = raw.match(/^```([^\n`]*)\n?([\s\S]*?)\n?```\s*$/);
    var heading = raw.match(/^(#{1,6})(\s+)(.+)$/);
    var lines = raw.split('\n');

    if (fence) {
      kind = 'code';
      el.dataset.lang = fence[1];
      html = renderCode(el, fence[2], fence[1], deferHi);
    } else if (heading && lines.length === 1) {
      var level = heading[1].length;
      kind = 'h' + level;
      // 前缀按原文原样折叠（含 # 后的空白），否则 textContent 少一个空格，
      // 离开编辑态时块类型会悄悄变掉
      var prefix = INLINE_PROTO ? marker(heading[1] + heading[2], 'head') : '';
      html = '<h' + level + '>' + prefix + renderInline(heading[3]) + '</h' + level + '>';
    } else if (isTableSource(lines)) {
      kind = 'table';
      html = renderTable(lines, el);
    } else if (lines.length && lines.every(function (line) { return /^\s*[-*+]\s+/.test(line); })) {
      kind = 'ul';
      html = '<ul>';
      lines.forEach(function (line, index) {
        var lead = /^\s*[-*+]\s+/.exec(line)[0];
        html += renderListItem(line, lead, index);
      });
      html += '</ul>';
    } else if (lines.length && lines.every(function (line) { return /^\s*\d+[.)]\s+/.test(line); })) {
      kind = 'ol';
      html = '<ol>';
      lines.forEach(function (line, index) {
        var lead = /^\s*\d+[.)]\s+/.exec(line)[0];
        html += renderListItem(line, lead, index);
      });
      html += '</ol>';
    } else if (lines.length && lines.every(function (line) { return /^\s*>/.test(line); })) {
      kind = 'quote';
      html = '<blockquote>';
      lines.forEach(function (line, index) {
        var lead = /^\s*>\s?/.exec(line)[0];
        if (index)
          html += '<br>' + (INLINE_PROTO ? newlineMarker() : '');
        html += (INLINE_PROTO ? marker(lead, 'quote') : '') + renderInline(line.slice(lead.length));
      });
      html += '</blockquote>';
    } else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw.trim())) {
      kind = 'hr';
      html = '<hr>';
    } else {
      html = lines.map(renderInline).join(INLINE_PROTO ? '<br>' + newlineMarker() : '<br>');
    }

    el.dataset.raw = raw;
    el.className = 'block ' + kind;
    el.innerHTML = html || '<br>';
  }

