  // 拆分块后平衡成对行内标记（**、`、__、~~）：前半未闭合时——若后半以该标记
  // 开头（拆分点恰在闭合标记前）把闭合标记挪到前半；否则前半补闭合、后半重开。
  function balanceInlineMarkers(before, after) {
    var marks = ['**', '`', '__', '~~'];
    for (var mi = 0; mi < marks.length; mi++) {
      var M = marks[mi];
      if ((before.split(M).length - 1) % 2 === 1) {
        if (after.indexOf(M) === 0) {
          before += M;
          after = after.slice(M.length);
        } else {
          var cut = before.lastIndexOf(M);
          if (before.slice(cut + M.length) === '') {
            before = before.slice(0, cut);
            after = M + after;
          } else {
            before += M;
            after = M + after;
          }
        }
      }
    }
    return [before, after];
  }

  function splitBlock(el) {
    commitHistory();   // 先把分段前的状态固定为一个步骤

    var raw = el.textContent;
    var offset = caretOffset(el);
    var kind = blockType(el);
    var before, after;
    var exitStructure = false;
    // 列表/有序列表/引用按行拆分：后半段必须保留结构前缀，否则 "\n- b" 这类
    // 残缺原文会被 renderBlock 降级成带字面 "- " 的段落；空条目上回车退出结构，
    // 不再无限追加空条目（与 wolai/Notion 一致）。
    if (kind === 'ul' || kind === 'ol' || kind === 'quote') {
      var leadRe = kind === 'quote' ? /^\s*>\s?/
        : kind === 'ol' ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      var lines = raw.split('\n');
      var pos = 0, li = 0, col = 0, i;
      for (i = 0; i < lines.length; i++) {
        var lineEnd = pos + lines[i].length;
        if (offset <= lineEnd) { li = i; col = offset - pos; break; }
        if (offset === lineEnd + 1 && i + 1 < lines.length) { li = i + 1; col = 0; break; }
        pos = lineEnd + 1;
        li = i; col = lines[i].length;
      }
      var line = lines[li];
      var lm = line.match(leadRe);
      var lead = lm ? lm[0] : (kind === 'quote' ? '> ' : kind === 'ol' ? '1. ' : '- ');
      // 任务项：前缀连带复选框一起算，拆出的后半段保留 [ ]/[x] 标记
      if (kind !== 'quote') {
        var tm = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/);
        if (tm)
          lead = tm[0];
      }
      if (line.slice(lead.length).trim() === '') {
        // 空条目没有可拆的内容：无论光标在标记前后都退出结构
        before = lines.slice(0, li).join('\n');
        after = lines.slice(li + 1).join('\n');
        exitStructure = true;
      } else if (col >= line.length && li < lines.length - 1) {
        // 光标在非末行行尾：按行边界拆，当前行整行留在前半，不造空条目
        before = lines.slice(0, li + 1).join('\n');
        after = lines.slice(li + 1).join('\n');
      } else if (col <= lead.length) {
        before = lines.slice(0, li).join('\n');
        after = lines.slice(li).join('\n');
      } else {
        before = lines.slice(0, li).concat(line.slice(0, col)).join('\n');
        after = [lead + line.slice(col)].concat(lines.slice(li + 1)).join('\n');
      }
    } else {
      before = raw.slice(0, offset);
      after = raw.slice(offset);
      // 标题中间回车：后半段保留 # 前缀，不降级成正文
      if (kind.charAt(0) === 'h' && after.trim() !== '') {
        var hm = raw.match(/^(#{1,6})(\s+)/);
        if (hm)
          after = hm[1] + hm[2] + after.replace(/^\s+/, '');
      }
    }

    // 拆分点若落在 **加粗** / `行内代码` 等成对标记内部，两半会各留一个未闭合
    // 标记，渲染成字面星号/反引号。拆分后先做配对平衡：前半闭合、后半重开。
    var balanced = balanceInlineMarkers(before, after);
    before = balanced[0];
    after = balanced[1];

    renderBlock(el, before);

    if (exitStructure && !before && !after) {
      // 唯一一行就是空条目：本块直接退回空正文即可，不再拆出新块
      el.classList.add('editing');
      el.focus();
      setCaret(el, 0);
      scheduleDirty();
      commitHistory();   // 分段后的状态单独成一个步骤
      scheduleTocRefresh();
      return;
    }

    var neo = document.createElement('div');
    neo.className = 'block';
    neo.setAttribute('contenteditable', 'true');
    root.insertBefore(neo, el.nextSibling);
    renderBlock(neo, after);
    neo.classList.add('editing');
    neo.focus();
    setCaret(neo, 0);
    scheduleDirty();
    commitHistory();   // 分段后的状态单独成一个步骤
    scheduleTocRefresh();
  }

  // 结构类型：只有类型相同的相邻块才允许合并。段落原文接进表格、标题、列表或
  // 引用的原文里会把结构写坏（表格会把段落文字并进最后一行末格）。
  function blockType(el) {
    if (isCodeBlock(el))
      return 'code';
    for (var level = 1; level <= 6; level++) {
      if (el.classList.contains('h' + level))
        return 'h' + level;
    }
    var kinds = ['table', 'ul', 'ol', 'quote', 'hr'];
    for (var i = 0; i < kinds.length; i++) {
      if (el.classList.contains(kinds[i]))
        return kinds[i];
    }
    return 'p';
  }

  // 块内行首退格（光标紧跟换行标记之后）：去掉换行与本行的结构前缀，
  // 把内容并入上一行末尾——与跨块块首退格合并同一套语义。换行标记不可编辑，
  // 不接管的话退格只会把光标挪过标记，看起来像死键。
  function joinPrevLine(el) {
    var raw = el.textContent;
    var offset = caretOffset(el);
    var lines = raw.split('\n');
    var acc = 0, li = -1, i;
    for (i = 0; i < lines.length; i++) {
      if (offset <= acc + lines[i].length) { li = i; break; }
      acc += lines[i].length + 1;
    }
    if (li <= 0)
      return;
    var line = lines[li];
    var lm = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|^\s*>\s?/);
    var lead = lm ? lm[0] : '';
    var joined = lines.slice(0, li - 1);
    joined.push(lines[li - 1] + line.slice(lead.length));
    var rest = lines.slice(li + 1);
    for (i = 0; i < rest.length; i++)
      joined.push(rest[i]);
    commitHistory();
    applyRawToBlock(el, joined.join('\n'), acc - 1, acc - 1, true);
    setTimeout(commitHistory, 0);
    scheduleTocRefresh();
  }

  // 光标所在行的定位信息（块原文口径，代码块含围栏行）
  function caretLineInfo(el) {
    var raw = rawOf(el);
    var off = rawCaretOffset(el);
    var lines = raw.split('\n');
    var acc = 0, li = 0;
    for (var i = 0; i < lines.length; i++) {
      if (off <= acc + lines[i].length) { li = i; break; }
      acc += lines[i].length + 1;
    }
    return { lines: lines, li: li, lineStart: acc, off: off };
  }

  // Tab：结构行（列表/任务/引用）在本行行首加两格缩进——光标在行中也一样，
  // 不能把空格插进正文；其余行保持行内插两格。
  function indentCurrentLine(el) {
    if (!isCodeBlock(el)) {
      var info = caretLineInfo(el);
      var line = info.lines[info.li];
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s*>/.test(line)) {
        commitHistory();
        var lines = info.lines.slice();
        lines[info.li] = '  ' + lines[info.li];
        applyRawToBlock(el, lines.join('\n'), info.off + 2, info.off + 2, true);
        setTimeout(commitHistory, 0);
        return;
      }
    }
    document.execCommand('insertText', false, '  ');
  }

  // Shift+Tab：去掉本行行首最多两个空格；本行没有缩进就什么都不做
  function outdentCurrentLine(el) {
    var info = caretLineInfo(el);
    var line = info.lines[info.li];
    var strip = Math.min(/^\s*/.exec(line)[0].length, 2);
    if (!strip)
      return;
    commitHistory();
    var lines = info.lines.slice();
    lines[info.li] = line.slice(strip);
    var caret = Math.max(info.lineStart, info.off - strip);
    applyRawToBlock(el, lines.join('\n'), caret, caret, true);
    setTimeout(commitHistory, 0);
  }

  // 原生跨块选区（Cmd+A 全选、鼠标拖出块）上的删除：按整篇源码拼接删掉选区。
  // 不接管的话 INLINE_PROTO 会把选区收成折叠光标，退格变成死键。
  function deleteNativeCrossSelection() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return false;
    var range = selection.getRangeAt(0);
    if (range.collapsed)
      return false;
    var first = blockAtBoundary(range.startContainer, range.startOffset, false);
    var last = blockAtBoundary(range.endContainer, range.endOffset, true);
    if (!first || !last || first === last)
      return false;
    var from = absoluteOf(first, range.startContainer, range.startOffset);
    var to = absoluteOf(last, range.endContainer, range.endOffset);
    if (from === null || to === null) {
      var list = blockList();
      var blocks = collectBlocks();
      var gaps = collectGaps();
      var fi = list.indexOf(first);
      var li = list.indexOf(last);
      if (fi < 0 || li < 0)
        return false;
      if (from === null)
        from = blockStartOffset(blocks, gaps, fi);
      if (to === null)
        to = blockStartOffset(blocks, gaps, li) + blocks[li].length;
    }
    if (from > to) {
      var t = from;
      from = to;
      to = t;
    }
    var text = currentSource();
    var next = text.slice(0, from) + text.slice(to);
    commitHistory();
    var landed = rebuildFromSourceText(next, from);
    if (landed && landed.block) {
      landed.block.classList.add('editing');
      landed.block.focus();
      placeBlockCaret(landed.block, landed.offset);
    }
    commitHistory();
    return true;
  }

  function mergeBack(el) {
    var previous = el.previousElementSibling;
    if (!previous || !previous.classList.contains('block'))
      return;

    // 相邻块结构类型不同时不合并：两段原文直接拼接会得到坏 Markdown
    if (blockType(el) !== blockType(previous)) {
      // 代码块首行行首退格是例外：上一块不是代码块时合并不了，但退格不能是
      // 死键——先剥掉围栏还原成正文（再按一次退格即可与上一段相接）。
      if (isCodeBlock(el) && !isCodeBlock(previous)) {
        commitHistory();
        applyRawToBlock(el, contentOfRaw(rawOf(el), 'code'), 0, 0, true);
        setTimeout(commitHistory, 0);
        return;
      }
      // 结构块（引用/列表/标题）首行退格遇到不同类型：剥掉前缀还原正文（再按
      // 一次即可与上一段合并），对齐原生壳行为，避免死键。
      var kind0 = blockType(el);
      if (kind0 === 'ul' || kind0 === 'ol' || kind0 === 'quote' || kind0.charAt(0) === 'h') {
        commitHistory();
        applyRawToBlock(el, contentOfRaw(rawOf(el), kind0), 0, 0, true);
        setTimeout(commitHistory, 0);
      }
      return;
    }

    // 代码块首行行首退格 → 与上一块合并。相邻也是代码块时合并正文（保留上一块
    // 的语言）；相邻是普通块时不把围栏塞进段落（那会得到坏 Markdown），保持不动。
    if (isCodeBlock(el)) {
      commitHistory();   // 合并前的状态单独成一个步骤
      var junction = codeText(previous).length;
      var joined = codeText(previous) + codeText(el);
      renderBlock(previous, codeRaw(previous, joined));
      normalizeCodeScrolls(previous);
      el.remove();
      previous.classList.add('editing');
      previous.focus();
      setSelectionRange(codeEl(previous), junction);
      scheduleDirty();
      commitHistory();
      scheduleTocRefresh();
      return;
    }

    commitHistory();   // 合并前的状态单独成一个步骤

    var previousRaw = previous.dataset.raw === undefined ? previous.textContent : previous.dataset.raw;
    // 同类型拼接要按结构口径：标题剥掉第二块的 # 前缀再并成一行；列表/引用
    // 每行自带标记，补一个换行合成一个块；正文直接首尾相接。
    var elRaw = el.textContent;
    var mergeKind = blockType(el);
    var merged;
    if (mergeKind.charAt(0) === 'h')
      merged = previousRaw + contentOfRaw(elRaw, mergeKind);
    else if (mergeKind === 'ul' || mergeKind === 'ol' || mergeKind === 'quote')
      merged = previousRaw + '\n' + elRaw;
    else
      merged = previousRaw + elRaw;
    el.remove();
    renderBlock(previous, merged);
    normalizeCodeScrolls(previous);
    previous.classList.add('editing');
    previous.focus();
    setCaret(previous, previousRaw.length);
    scheduleDirty();
    commitHistory();
    scheduleTocRefresh();
  }

