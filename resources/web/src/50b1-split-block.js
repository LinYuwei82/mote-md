  var SplitBlock = (function splitBlockModule() {
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
    EditingSnapshot.commitHistory();   // 先把分段前的状态固定为一个步骤

    var raw = el.textContent;
    var offset = CaretOffset.caretOffset(el);
    var kind = JoinIndent.blockType(el);
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

    RenderBlocks.renderBlock(el, before);

    if (exitStructure && !before && !after) {
      // 唯一一行就是空条目：本块直接退回空正文即可，不再拆出新块
      el.classList.add('editing');
      el.focus();
      CaretCode.setCaret(el, 0);
      DocumentModel.scheduleDirty();
      EditingSnapshot.commitHistory();   // 分段后的状态单独成一个步骤
      Toc.scheduleTocRefresh();
      return;
    }

    var neo = document.createElement('div');
    neo.className = 'block';
    neo.setAttribute('contenteditable', 'true');
    root.insertBefore(neo, el.nextSibling);
    RenderBlocks.renderBlock(neo, after);
    neo.classList.add('editing');
    neo.focus();
    CaretCode.setCaret(neo, 0);
    DocumentModel.scheduleDirty();
    EditingSnapshot.commitHistory();   // 分段后的状态单独成一个步骤
    Toc.scheduleTocRefresh();
  }

  return {
    splitBlock: splitBlock
  };
  })();
