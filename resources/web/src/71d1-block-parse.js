  // 原文 → 块类型。与 renderBlock 的判定顺序保持一致。
  function kindOfRaw(raw) {
    raw = String(raw === undefined || raw === null ? '' : raw);
    if (/^```[^\n`]*\n?[\s\S]*?```\s*$/.test(raw))
      return 'code';
    var heading = raw.match(/^(#{1,6})\s+/);
    if (heading && raw.indexOf('\n') < 0)
      return 'h' + heading[1].length;
    var lines = raw.split('\n');
    if (lines.length && lines.every(function (line) { return /^\s*[-*+]\s+/.test(line); }))
      return 'ul';
    if (lines.length && lines.every(function (line) { return /^\s*\d+[.)]\s+/.test(line); }))
      return 'ol';
    if (lines.length && lines.every(function (line) { return /^\s*>/.test(line); }))
      return 'quote';
    if (TableParse.isTableSource(lines))
      return 'table';
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw.trim()))
      return 'hr';
    return 'p';
  }

  // 去掉结构前缀后的正文内容（代码块取围栏内正文）
  function contentOfRaw(raw, kind) {
    raw = String(raw === undefined || raw === null ? '' : raw);
    kind = kind || kindOfRaw(raw);
    if (kind === 'code') {
      var fence = raw.match(/^```([^\n`]*)\n?([\s\S]*?)\n?```\s*$/);
      return fence ? fence[2].replace(/\n$/, '') : raw;
    }
    // hr 必须在标题分支之前判：'hr' 首字母也是 h，会被 charAt(0)==='h' 误捕
    if (kind === 'hr')
      // 分割线没有正文内容：转成正文/标题时得到空内容，而不是字面量 '---'
      return '';
    if (kind.charAt(0) === 'h')
      return raw.replace(/^#{1,6}\s+/, '');
    if (kind === 'ul')
      return raw.split('\n').map(function (line) { return line.replace(/^\s*[-*+]\s+/, ''); }).join('\n');
    if (kind === 'ol')
      return raw.split('\n').map(function (line) { return line.replace(/^\s*\d+[.)]\s+/, ''); }).join('\n');
    if (kind === 'quote')
      return raw.split('\n').map(function (line) { return line.replace(/^\s*>\s?/, ''); }).join('\n');
    if (kind === 'table') {
      // 表格内容 = 各行单元格文字（跳过第 2 行对齐行）。竖线与对齐行是结构，
      // 不是内容：缺这个分支时「转为正文」会原样返回而变成无效果。
      var rows = raw.split('\n');
      var texts = [];
      for (var ri = 0; ri < rows.length; ri++) {
        if (ri === 1)
          continue;
        texts.push(TableParse.tableCells(rows[ri]).join(' '));
      }
      return texts.join('\n');
    }
    return raw;
  }

  // 正文内容 → 目标类型的原文。前缀只加一次，已在内容里的前缀由调用方先剥掉。
  function buildBlockRaw(type, content) {
    content = String(content === undefined || content === null ? '' : content);
    var lines = content.split('\n');
    if (type === 'code')
      return '```\n' + content.replace(/\n+$/, '') + '\n```';
    // 只认 h1–h6：'hr' 也以 h 开头，不能只判断首字母，否则会走进标题分支并
    // 用 Number('r') 构造 Array，直接抛 RangeError。
    if (/^h[1-6]$/.test(type))
      // 标题只能是一行：多行内容用空格并成一行，避免出现 `# a\nb` 这种半标题
      return new Array(Number(type.slice(1)) + 1).join('#') + ' ' + content.replace(/\n+/g, ' ');
    if (type === 'ul')
      return lines.map(function (line) { return '- ' + line; }).join('\n');
    if (type === 'ol')
      return lines.map(function (line, index) { return (index + 1) + '. ' + line; }).join('\n');
    if (type === 'quote')
      return lines.map(function (line) { return '> ' + line; }).join('\n');
    if (type === 'hr')
      return '---';
    return content;
  }

  // 单块转换。toggle=false（「转为」菜单）时已是目标类型则保持不动；
  // toggle=true（快捷键/斜杠）时同样目标类型再执行一次回到正文。
  function convertRaw(raw, type, toggle) {
    var prev = kindOfRaw(raw);
    if (prev === type)
      return toggle ? contentOfRaw(raw, prev) : raw;
    if (type === 'p' && prev === 'p')
      return raw;
    return buildBlockRaw(type, contentOfRaw(raw, prev));
  }

  // 首行结构前缀长度：转换后按差值平移光标，避免标题/列表前缀把光标挤走
  function leadLength(raw, kind) {
    var match;
    if (kind && kind.charAt(0) === 'h' && (match = raw.match(/^#{1,6}\s+/)))
      return match[0].length;
    if ((kind === 'ul' || kind === 'ol') && (match = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+/)))
      return match[0].length;
    if (kind === 'quote' && (match = raw.match(/^\s*>\s?/)))
      return match[0].length;
    if (kind === 'code' && (match = raw.match(/^```[^\n`]*\n/)))
      return match[0].length;
    return 0;
  }

  // 编辑中的块以 textContent 为准（input 已逐次同步 dataset.raw，但组合输入
  // 结束前可能有半帧差）；其余块一律用 dataset.raw。
  function rawOf(el) {
    if (LayoutCode.isCodeBlock(el))
      return el.dataset.raw === undefined ? LayoutCode.codeRaw(el, LayoutCode.codeText(el)) : el.dataset.raw;
    if (el.classList.contains('editing'))
      return el.textContent;
    return el.dataset.raw === undefined ? el.textContent : el.dataset.raw;
  }

  function blockList() {
    return Array.prototype.filter.call(root.children, function (el) {
      return el.classList && el.classList.contains('block');
    });
  }

  // 选区覆盖的块（含首尾）。跨块多选时用于「一次转换多块」。
  // 三击/拖选会让选区边界落在 #editor 本身（而不是某个块里），
  // 此时按子节点下标取相邻块，否则多选转换会被误判成“没有块”。
  function blockAtBoundary(node, offset, preferPrevious) {
    var el = CaretCode.blockOf(node);
    if (el)
      return el;
    if (node !== root)
      return null;
    var kids = blockList();
    if (!kids.length)
      return null;
    if (preferPrevious) {
      for (var i = Math.min(offset, kids.length) - 1; i >= 0; i--) {
        if (kids[i].parentNode === root)
          return kids[i];
      }
      return kids[0];
    }
    for (var j = Math.max(0, offset); j < kids.length; j++) {
      if (kids[j].parentNode === root)
        return kids[j];
    }
    return kids[kids.length - 1];
  }

  function selectedBlocks() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return [];
    var range = selection.getRangeAt(0);
    var all = blockList();
    var first = blockAtBoundary(range.startContainer, range.startOffset, false)
      || blockAtBoundary(selection.anchorNode, 0, false);
    var last = blockAtBoundary(range.endContainer, range.endOffset, true)
      || first;
    if (!first)
      return [];
    var a = all.indexOf(first);
    var b = all.indexOf(last);
    if (a < 0)
      return [first];
    if (b < 0)
      b = a;
    return all.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  // 渲染一个新原文并恢复编辑态；start/end 是「块原文」口径的偏移。
  function applyRawToBlock(el, raw, start, end, editing) {
    RenderBlocks.renderBlock(el, raw);
    LayoutCode.normalizeCodeScrolls(el);
    if (editing) {
      el.classList.add('editing');
      el.focus();
      var limit = raw.length;
      var from = Math.max(0, Math.min(start === undefined || start === null ? limit : start, limit));
      var to = Math.max(from, Math.min(end === undefined || end === null ? from : end, limit));
      CaretEdit.placeBlockCaret(el, from, to);
    }
    updatePlaceholder();
    DocumentModel.scheduleDirty();
    Toc.scheduleTocRefresh();
  }

  // 多块合并型转换（列表/引用/代码块）：把选中块的内容按行拼进一个块。
  var MERGE_TYPES = { ul: 1, ol: 1, quote: 1, code: 1 };

  // 跨块选区是虚拟覆盖层，DOM 光标折叠在焦点块；selectedBlocks 只读 DOM 选区
  // 会漏掉选区覆盖的其他块。这里按整篇源码偏移把覆盖到的块收集出来。
  function crossSelBlocks() {
    var bounds = TableCross.crossBounds();
    if (!bounds)
      return null;
    var els = blockList();
    var out = [];
    var offset = 0;
    for (var i = 0; i < els.length; i++) {
      offset += DocumentModel.blockGap(els[i], i === 0);
      var len = rawOf(els[i]).length;
      if (offset + len > bounds.from && offset < bounds.to)
        out.push(els[i]);
      offset += len;
    }
    return out;
  }
