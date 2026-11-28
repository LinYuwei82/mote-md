  var BlockConvert = (function blockConvertModule() {
  function convertBlocks(type, toggle) {
    if (ViewState.mode() === 'source') {
      SourceConvert.sourceConvert(type, toggle);
      return;
    }
    var blocks;
    if (Cross.isActive()) {
      blocks = BlockParse.crossSelBlocks();
      if (!blocks || !blocks.length)
        return;
      Cross.clearCrossSelection();   // 结构即将改变，覆盖层失效
    } else {
      blocks = BlockParse.selectedBlocks();
      if (!blocks.length)
        return;
    }
    var target = blocks[0];
    var selection = CaretCode.rangeIn(target);

    if (blocks.length > 1 && BlockParse.MERGE_TYPES[type]) {
      var content = blocks.map(function (el) {
        return BlockParse.contentOfRaw(BlockParse.rawOf(el), BlockParse.kindOfRaw(BlockParse.rawOf(el)));
      }).join('\n');
      var merged = BlockParse.buildBlockRaw(type, content);
      EditingSnapshot.commitHistory();
      for (var i = blocks.length - 1; i >= 1; i--)
        blocks[i].remove();
      BlockParse.applyRawToBlock(target, merged, merged.length, merged.length, true);
      setTimeout(EditingSnapshot.commitHistory, 0);
      return;
    }

    // 单块（或标题/正文这种按块独立转换的多选）
    var changed = false;
    var multi = blocks.length > 1;
    // 列表/引用 → 正文会把每行还原成独立段落，也算一次批量改动
    var splitting = type === 'p';
    EditingSnapshot.commitHistory();
    if (multi || splitting)
      commitBatch++;
    blocks.forEach(function (el) {
      var raw = BlockParse.rawOf(el);
      var before = BlockParse.kindOfRaw(raw);
      var next = BlockParse.convertRaw(raw, type, toggle);
      if (next === raw)
        return;
      changed = true;
      // 列表/引用/表格/代码回正文：逐行拆回独立段落，避免一个块里塞进硬换行
      if (type === 'p' && (before === 'ul' || before === 'ol' || before === 'quote' ||
                           before === 'table' || before === 'code')) {
        var lines = BlockParse.contentOfRaw(raw, before).replace(/\n+$/, '').split('\n');
        if (lines.length > 1) {
          BlockParse.applyRawToBlock(el, lines[0], lines[0].length, lines[0].length, true);
          var anchor = el;
          for (var li = 1; li < lines.length; li++) {
            insertBlockAfter(anchor, lines[li], lines[li].length);
            anchor = anchor.nextElementSibling;
          }
          return;
        }
      }
      var shift = BlockParse.leadLength(next, BlockParse.kindOfRaw(next)) - BlockParse.leadLength(raw, before);
      // 只有选区所在的块沿用选区偏移，其余块光标放末尾
      var hasCaret = selection && el === target;
      var start = hasCaret ? Math.max(0, selection.start + shift) : next.length;
      var end = hasCaret ? Math.max(start, selection.end + shift) : next.length;
      BlockParse.applyRawToBlock(el, next, start, end, true);
    });
    if (multi || splitting)
      commitBatch--;
    if (!changed) {
      EditingSnapshot.commitHistory();
      return;
    }
    // 多块/拆分转换合成一个撤销步：一次 Cmd+Z 全部还原
    if (multi || splitting)
      EditingSnapshot.commitHistory();
    else
      setTimeout(EditingSnapshot.commitHistory, 0);
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
    if (ViewState.mode() === 'source') {
      SourceConvert.sourceInline(kind);
      return;
    }
    var blocks = BlockParse.selectedBlocks();
    if (!blocks.length)
      return;
    var el = blocks[0];
    if (LayoutCode.isCodeBlock(el) || el.classList.contains('table') || el.classList.contains('hr')) {
      Util.post({ type: 'status', message: '当前块不支持行内格式' });
      return;
    }
    var selection = CaretCode.rangeIn(el);
    if (!selection)
      return;
    var raw = BlockParse.rawOf(el);
    var out = inlineTransform(raw, selection.start, selection.end, kind);
    if (out.raw === raw)
      return;
    EditingSnapshot.commitHistory();
    BlockParse.applyRawToBlock(el, out.raw, out.start, out.end, true);
    setTimeout(EditingSnapshot.commitHistory, 0);
  }

  var TABLE_TEMPLATE = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |';

  // 在当前块之后插入一个新块；caret 为块原文偏移
  function insertBlockAfter(el, raw, caret) {
    var block = document.createElement('div');
    block.className = 'block';
    block.setAttribute('contenteditable', 'true');
    RenderBlocks.renderBlock(block, raw);
    if (el && el.parentNode === root)
      root.insertBefore(block, el.nextSibling);
    else
      root.appendChild(block);
    LayoutCode.normalizeCodeScrolls(block);
    block.classList.add('editing');
    block.focus();
    CaretEdit.placeBlockCaret(block, caret === undefined ? raw.length : caret);
    if (block.scrollIntoView)
      block.scrollIntoView({ block: 'nearest' });
    MenuOverlay.updatePlaceholder();
  }

  // 表格 / 分隔线：不改动已有内容，在当前块之后插入
  function insertTableBlock() {
    var blocks = BlockParse.selectedBlocks();
    var el = blocks.length ? blocks[blocks.length - 1] : root.lastElementChild;
    EditingSnapshot.commitHistory();
    var elKind = el && el.classList.contains('block') ? BlockParse.kindOfRaw(BlockParse.rawOf(el)) : '';
    // hr/表格的内容按定义可能为空，但它们是实打实的结构块：不能当成空块被替换掉
    var empty = el && el.classList.contains('block')
      && elKind !== 'hr' && elKind !== 'table'
      && BlockParse.contentOfRaw(BlockParse.rawOf(el), elKind).trim() === '';
    if (empty) {
      BlockParse.applyRawToBlock(el, TABLE_TEMPLATE, 2, 2, true);
    } else {
      insertBlockAfter(el, TABLE_TEMPLATE, 2);
    }
    DocumentModel.scheduleDirty();
    Toc.scheduleTocRefresh();
    setTimeout(EditingSnapshot.commitHistory, 0);
  }

  function insertHrBlock() {
    var blocks = BlockParse.selectedBlocks();
    var el = blocks.length ? blocks[blocks.length - 1] : root.lastElementChild;
    EditingSnapshot.commitHistory();
    var elKind = el && el.classList.contains('block') ? BlockParse.kindOfRaw(BlockParse.rawOf(el)) : '';
    // hr/表格的内容按定义可能为空，但它们是实打实的结构块：不能当成空块被替换掉
    var empty = el && el.classList.contains('block')
      && elKind !== 'hr' && elKind !== 'table'
      && BlockParse.contentOfRaw(BlockParse.rawOf(el), elKind).trim() === '';
    if (empty) {
      BlockParse.applyRawToBlock(el, '---', 3, 3, true);
      insertBlockAfter(el, '', 0);
    } else {
      insertBlockAfter(el, '---', 3);
      insertBlockAfter(el.nextSibling, '', 0);
    }
    DocumentModel.scheduleDirty();
    Toc.scheduleTocRefresh();
    setTimeout(EditingSnapshot.commitHistory, 0);
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
  return {
    convertBlocks: convertBlocks,
    inlineTransform: inlineTransform,
    toggleInline: toggleInline,
    insertBlockAfter: insertBlockAfter,
    formatAction: formatAction,
    TABLE_TEMPLATE: TABLE_TEMPLATE
  };
  })();
