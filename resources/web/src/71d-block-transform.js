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
    if (isTableSource(lines))
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
        texts.push(tableCells(rows[ri]).join(' '));
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
    if (isCodeBlock(el))
      return el.dataset.raw === undefined ? codeRaw(el, codeText(el)) : el.dataset.raw;
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
    var el = blockOf(node);
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
    renderBlock(el, raw);
    normalizeCodeScrolls(el);
    if (editing) {
      el.classList.add('editing');
      el.focus();
      var limit = raw.length;
      var from = Math.max(0, Math.min(start === undefined || start === null ? limit : start, limit));
      var to = Math.max(from, Math.min(end === undefined || end === null ? from : end, limit));
      placeBlockCaret(el, from, to);
    }
    updatePlaceholder();
    scheduleDirty();
    scheduleTocRefresh();
  }

  // 多块合并型转换（列表/引用/代码块）：把选中块的内容按行拼进一个块。
  var MERGE_TYPES = { ul: 1, ol: 1, quote: 1, code: 1 };

  // 跨块选区是虚拟覆盖层，DOM 光标折叠在焦点块；selectedBlocks 只读 DOM 选区
  // 会漏掉选区覆盖的其他块。这里按整篇源码偏移把覆盖到的块收集出来。
  function crossSelBlocks() {
    var bounds = crossBounds();
    if (!bounds)
      return null;
    var els = blockList();
    var out = [];
    var offset = 0;
    for (var i = 0; i < els.length; i++) {
      offset += blockGap(els[i], i === 0);
      var len = rawOf(els[i]).length;
      if (offset + len > bounds.from && offset < bounds.to)
        out.push(els[i]);
      offset += len;
    }
    return out;
  }

  function convertBlocks(type, toggle) {
    if (mode === 'source') {
      sourceConvert(type, toggle);
      return;
    }
    var blocks;
    if (crossSel) {
      blocks = crossSelBlocks();
      if (!blocks || !blocks.length)
        return;
      clearCrossSelection();   // 结构即将改变，覆盖层失效
    } else {
      blocks = selectedBlocks();
      if (!blocks.length)
        return;
    }
    var target = blocks[0];
    var selection = rangeIn(target);

    if (blocks.length > 1 && MERGE_TYPES[type]) {
      var content = blocks.map(function (el) {
        return contentOfRaw(rawOf(el), kindOfRaw(rawOf(el)));
      }).join('\n');
      var merged = buildBlockRaw(type, content);
      commitHistory();
      for (var i = blocks.length - 1; i >= 1; i--)
        blocks[i].remove();
      applyRawToBlock(target, merged, merged.length, merged.length, true);
      setTimeout(commitHistory, 0);
      return;
    }

    // 单块（或标题/正文这种按块独立转换的多选）
    var changed = false;
    var multi = blocks.length > 1;
    // 列表/引用 → 正文会把每行还原成独立段落，也算一次批量改动
    var splitting = type === 'p';
    commitHistory();
    if (multi || splitting)
      commitBatch++;
    blocks.forEach(function (el) {
      var raw = rawOf(el);
      var before = kindOfRaw(raw);
      var next = convertRaw(raw, type, toggle);
      if (next === raw)
        return;
      changed = true;
      // 列表/引用/表格/代码回正文：逐行拆回独立段落，避免一个块里塞进硬换行
      if (type === 'p' && (before === 'ul' || before === 'ol' || before === 'quote' ||
                           before === 'table' || before === 'code')) {
        var lines = contentOfRaw(raw, before).replace(/\n+$/, '').split('\n');
        if (lines.length > 1) {
          applyRawToBlock(el, lines[0], lines[0].length, lines[0].length, true);
          var anchor = el;
          for (var li = 1; li < lines.length; li++) {
            insertBlockAfter(anchor, lines[li], lines[li].length);
            anchor = anchor.nextElementSibling;
          }
          return;
        }
      }
      var shift = leadLength(next, kindOfRaw(next)) - leadLength(raw, before);
      // 只有选区所在的块沿用选区偏移，其余块光标放末尾
      var hasCaret = selection && el === target;
      var start = hasCaret ? Math.max(0, selection.start + shift) : next.length;
      var end = hasCaret ? Math.max(start, selection.end + shift) : next.length;
      applyRawToBlock(el, next, start, end, true);
    });
    if (multi || splitting)
      commitBatch--;
    if (!changed) {
      commitHistory();
      return;
    }
    // 多块/拆分转换合成一个撤销步：一次 Cmd+Z 全部还原
    if (multi || splitting)
      commitHistory();
    else
      setTimeout(commitHistory, 0);
  }

  // 光标 / 选区落在行内时，给当前块套（或取消）行内标记。
  function inlineTransform(raw, start, end, kind) {
    var open = '**';
    if (kind === 'italic')
      open = '*';
    else if (kind === 'inlineCode')
      open = '`';
    if (kind === 'link') {
      // 光标/选区可能落在链接文字上，也可能落在 (url) 里；两种位置都应能整体取消。
      var lb = raw.lastIndexOf('[', start - 1);
      if (lb >= 0) {
        var rb = raw.indexOf(']', lb + 1);
        if (rb > lb && rb <= end + 1 && raw.slice(rb, rb + 2) === '](') {
          var close = raw.indexOf(')', rb + 2);
          if (close > 0) {
            var textStart = lb + 1;
            var textEnd = rb;
            var textLen = textEnd - textStart;
            return {
              raw: raw.slice(0, lb) + raw.slice(textStart, textEnd) + raw.slice(close + 1),
              // 去掉 '[' 后整段左移一位，链接文字的新起点就是 lb
              start: lb, end: lb + textLen
            };
          }
        }
      }
      if (end > start)
        return {
          raw: raw.slice(0, start) + '[' + raw.slice(start, end) + '](url)' + raw.slice(end),
          start: start + 1, end: end + 1
        };
      return {
        raw: raw.slice(0, start) + '[链接文字](url)' + raw.slice(start),
        start: start + 7, end: start + 10
      };
    }
    var closeMark = open;
    var before = raw.slice(Math.max(0, start - open.length), start);
    var after = raw.slice(end, end + closeMark.length);
    // 斜体不能把 ** 的一半当成自己的开/闭标记
    var starConfused = kind === 'italic'
      && (raw.slice(Math.max(0, start - 2), start) === '**' || raw.slice(end, end + 2) === '**');
    if (!starConfused && before === open && after === closeMark) {
      return {
        raw: raw.slice(0, start - open.length) + raw.slice(start, end) + raw.slice(end + closeMark.length),
        start: start - open.length, end: Math.max(start - open.length, end - open.length)
      };
    }
    // 选区自身首尾就是成对标记（全选加粗行再按加粗）：整段脱掉，不能套第二层
    if (!starConfused && start + open.length * 2 <= end
        && raw.slice(start, start + open.length) === open
        && raw.slice(end - closeMark.length, end) === closeMark
        && raw.slice(start + open.length, end - closeMark.length).indexOf(open) < 0) {
      return {
        raw: raw.slice(0, start) + raw.slice(start + open.length, end - closeMark.length) + raw.slice(end),
        start: start, end: Math.max(start, end - open.length - closeMark.length)
      };
    }
    if (start === end)
      return {
        raw: raw.slice(0, start) + open + closeMark + raw.slice(start),
        start: start + open.length, end: start + open.length
      };
    return {
      raw: raw.slice(0, start) + open + raw.slice(start, end) + closeMark + raw.slice(end),
      start: start + open.length, end: end + open.length
    };
  }

  function toggleInline(kind) {
    if (mode === 'source') {
      sourceInline(kind);
      return;
    }
    var blocks = selectedBlocks();
    if (!blocks.length)
      return;
    var el = blocks[0];
    if (isCodeBlock(el) || el.classList.contains('table') || el.classList.contains('hr')) {
      post({ type: 'status', message: '当前块不支持行内格式' });
      return;
    }
    var selection = rangeIn(el);
    if (!selection)
      return;
    var raw = rawOf(el);
    var out = inlineTransform(raw, selection.start, selection.end, kind);
    if (out.raw === raw)
      return;
    commitHistory();
    applyRawToBlock(el, out.raw, out.start, out.end, true);
    setTimeout(commitHistory, 0);
  }

  var TABLE_TEMPLATE = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |';

  // 在当前块之后插入一个新块；caret 为块原文偏移
  function insertBlockAfter(el, raw, caret) {
    var block = document.createElement('div');
    block.className = 'block';
    block.setAttribute('contenteditable', 'true');
    renderBlock(block, raw);
    if (el && el.parentNode === root)
      root.insertBefore(block, el.nextSibling);
    else
      root.appendChild(block);
    normalizeCodeScrolls(block);
    block.classList.add('editing');
    block.focus();
    placeBlockCaret(block, caret === undefined ? raw.length : caret);
    if (block.scrollIntoView)
      block.scrollIntoView({ block: 'nearest' });
    updatePlaceholder();
  }

  // 表格 / 分隔线：不改动已有内容，在当前块之后插入
  function insertTableBlock() {
    var blocks = selectedBlocks();
    var el = blocks.length ? blocks[blocks.length - 1] : root.lastElementChild;
    commitHistory();
    var elKind = el && el.classList.contains('block') ? kindOfRaw(rawOf(el)) : '';
    // hr/表格的内容按定义可能为空，但它们是实打实的结构块：不能当成空块被替换掉
    var empty = el && el.classList.contains('block')
      && elKind !== 'hr' && elKind !== 'table'
      && contentOfRaw(rawOf(el), elKind).trim() === '';
    if (empty) {
      applyRawToBlock(el, TABLE_TEMPLATE, 2, 2, true);
    } else {
      insertBlockAfter(el, TABLE_TEMPLATE, 2);
    }
    scheduleDirty();
    scheduleTocRefresh();
    setTimeout(commitHistory, 0);
  }

  function insertHrBlock() {
    var blocks = selectedBlocks();
    var el = blocks.length ? blocks[blocks.length - 1] : root.lastElementChild;
    commitHistory();
    var elKind = el && el.classList.contains('block') ? kindOfRaw(rawOf(el)) : '';
    // hr/表格的内容按定义可能为空，但它们是实打实的结构块：不能当成空块被替换掉
    var empty = el && el.classList.contains('block')
      && elKind !== 'hr' && elKind !== 'table'
      && contentOfRaw(rawOf(el), elKind).trim() === '';
    if (empty) {
      applyRawToBlock(el, '---', 3, 3, true);
      insertBlockAfter(el, '', 0);
    } else {
      insertBlockAfter(el, '---', 3);
      insertBlockAfter(el.nextSibling, '', 0);
    }
    scheduleDirty();
    scheduleTocRefresh();
    setTimeout(commitHistory, 0);
  }

  // 统一动作名：原生菜单、斜杠菜单、快捷键都只传这些字符串
  function formatAction(name) {
    if (name === 'bold' || name === 'italic' || name === 'inlineCode' || name === 'link') {
      toggleInline(name);
      return;
    }
    if (name === 'table') {
      insertTableBlock();
      return;
    }
    if (name === 'hr') {
      insertHrBlock();
      return;
    }
    var type = { h1: 'h1', h2: 'h2', h3: 'h3', paragraph: 'p', ul: 'ul', ol: 'ol', quote: 'quote', codeBlock: 'code' }[name];
    if (!type)
      return;
    // 快捷键/菜单是切换语义：同类型再按一次回正文（codeBlock 回正文=去围栏）
    convertBlocks(type, true);
  }

