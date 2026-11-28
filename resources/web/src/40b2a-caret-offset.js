  var CaretOffset = (function caretOffsetModule() {
  function caretOffset(el) {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return 0;
    // 代码块的光标偏移只按 <code> 里的正文计算，行号栏不能算进去
    var scope = LayoutCode.isCodeBlock(el) ? LayoutCode.codeEl(el) : el;
    if (!scope)
      return 0;
    var range = selection.getRangeAt(0);
    var prefix = range.cloneRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.endContainer, range.endOffset);
    } catch (error) {
      return 0;
    }
    return prefix.toString().length;
  }

  // caretOffset 对代码块给的是 <code> 内偏移，placeBlockCaret 收的却是块原文
  // 口径（dataset.raw，含围栏行）；要在两处之间存取光标（如查找栏开/关）必须
  // 先补齐围栏长度，否则回来时会被 placeBlockCaret 再减一次，光标往左偏。
  function rawCaretOffset(el) {
    return caretOffset(el) + (LayoutCode.isCodeBlock(el) ? LayoutCode.codePrefixLength(el) : 0);
  }

  function blockIndex(el) {
    return Array.prototype.indexOf.call(Core.root.children, el);
  }

  // 字符偏移 → DOM 位置（用于撤销后恢复选区）。
  // 原型模式下列标记为零宽原子：落进标记内部时按左右边界取整，绝不把光标
  // 放进绝对定位的标记文本里（否则会出现看不见的光标 / 候选框错位）。
  function locateOffset(el, offset) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var remaining = Math.max(0, offset || 0);
    var node = null;
    var last = null;
    while ((node = walker.nextNode())) {
      if (Config.INLINE_PROTO) {
        var mk = node.parentNode && node.parentNode.closest ? node.parentNode.closest('.mk') : null;
        if (mk) {
          var mkLen = node.nodeValue.length;
          var idx = Array.prototype.indexOf.call(mk.parentNode.childNodes, mk);
          if (remaining < mkLen)
            return remaining * 2 >= mkLen
              ? { node: mk.parentNode, offset: idx + 1 }
              : { node: mk.parentNode, offset: idx };
          remaining -= mkLen;
          last = { node: mk.parentNode, offset: idx + 1 };
          continue;
        }
      }
      last = { node: node, offset: node.nodeValue.length };
      if (remaining <= node.nodeValue.length)
        return { node: node, offset: remaining };
      remaining -= node.nodeValue.length;
    }
    if (last)
      return last;
    return { node: el, offset: 0 };
  }

  function setSelectionRange(el, start, end) {
    var from = locateOffset(el, start);
    var to = locateOffset(el, end === undefined ? start : end);
    var range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch (error) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return {
    caretOffset: caretOffset,
    rawCaretOffset: rawCaretOffset,
    blockIndex: blockIndex,
    locateOffset: locateOffset,
    setSelectionRange: setSelectionRange
  };
  })();
