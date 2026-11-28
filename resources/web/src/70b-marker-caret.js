  var MarkerCaret = (function markerCaretModule() {
  // 原型模式：标记是 contenteditable=false 的原子对象，退格/删除一旦作用到它
  // 就会只删掉一半 * 或 `，留下坏结构。这里判断光标与标记之间是否“没有可见字符”，
  // 是则把光标移到标记另一侧，绝不删除标记本身。
  function collapseAt(node, atStart) {
    var range = document.createRange();
    if (atStart)
      range.setStartBefore(node);
    else
      range.setStartAfter(node);
    range.collapse(true);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 任务标记（[ ] / [x]）在编辑态是可见文本，用户可以像普通文字一样用键盘
  // 改写它；其余标记仍是不可编辑的原子对象，方向键/退格不进入。
  function editableMarker(mk) {
    return !!(mk && mk.classList && mk.classList.contains('mk-task'));
  }

  function markerAdjacent(el, direction) {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (!range.collapsed)
      return null;
    var markers = el.querySelectorAll('.mk');
    for (var i = 0; i < markers.length; i++) {
      var mk = markers[i];
      if (editableMarker(mk))
        continue;
      // compareBoundaryPoints 的参数方向容易搞反，这里用两个折叠 Range +
      // comparePoint 明确表达“光标在标记起点/终点的哪一侧”。
      var edge = document.createRange();
      if (direction < 0)
        edge.setStartAfter(mk);
      else
        edge.setStartBefore(mk);
      edge.collapse(true);
      var side;
      try {
        side = edge.comparePoint(range.startContainer, range.startOffset);
      } catch (error) {
        continue;
      }
      if (direction < 0) {
        if (side < 0)      // 光标在标记终点之前：标记不在退格方向上
          continue;
      } else if (side > 0) { // 光标在标记起点之后：标记不在删除方向上
        continue;
      }
      var probe = document.createRange();
      try {
        if (direction < 0) {
          probe.setStartAfter(mk);
          probe.setEnd(range.startContainer, range.startOffset);
        } else {
          probe.setStart(range.startContainer, range.startOffset);
          probe.setEndBefore(mk);
        }
      } catch (error) {
        continue;
      }
      if (probe.toString() === '')
        return mk;
    }
    return null;
  }

  function caretInsideMarker() {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== 3)
      return null;
    var node = range.startContainer;
    var mk = node.parentNode && node.parentNode.closest ? node.parentNode.closest('.mk') : null;
    return editableMarker(mk) ? null : mk;
  }

  // 标记（contenteditable=false 的原子对象）紧贴光标时，WebKit 的原生退格/删除
  // 会“什么都不做”。这种情况由这里直接删掉标记另一侧的可见字符，再补发 input，
  // 让 dataset.raw / 脏标记 / 历史栈走与原生输入完全相同的路径。
  function editableTextNodes(el) {
    var out = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (node.parentNode.closest && node.parentNode.closest('.mk'))
        continue;
      out.push(node);
    }
    return out;
  }

  // 标记不可见，退格/删除的语义应当是“删掉它另一侧的可见字符”。但只允许跨
  // 同一条行内流：中间有 <br>、或落进另一个 li / 引用段，就放弃，免得误删
  // 上一行或上一项。
  function lineRoot(node) {
    var el = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    while (el && el.nodeType === 1) {
      if (el.nodeName === 'LI' || el.nodeName === 'BLOCKQUOTE' || el.nodeName === 'TD'
          || el.nodeName === 'TH' || (el.classList && el.classList.contains('block')))
        return el;
      el = el.parentNode;
    }
    return null;
  }

  function sameFlow(node, mk, backward) {
    if (lineRoot(node) !== lineRoot(mk))
      return false;
    var span = document.createRange();
    try {
      if (backward) {          // node 在标记左侧：node 末尾 → 标记起点
        span.setStart(node, node.nodeValue.length);
        span.setEnd(mk, 0);
      } else {                 // node 在标记右侧：标记起点 → node 开头
        span.setStart(mk, 0);
        span.setEnd(node, 0);
      }
    } catch (error) {
      return false;
    }
    var fragment = span.cloneContents();
    return !(fragment.querySelector && fragment.querySelector('br'));
  }

  function deleteVisibleChar(el, range, backward, mk) {
    var nodes = editableTextNodes(el);
    var i, node, probe;
    if (backward) {
      for (i = nodes.length - 1; i >= 0; i--) {
        node = nodes[i];
        probe = document.createRange();
        probe.selectNodeContents(node);
        if (!node.nodeValue.length || probe.compareBoundaryPoints(Range.END_TO_END, range) > 0)
          continue;
        if (mk && !sameFlow(node, mk, true))
          continue;
        node.nodeValue = node.nodeValue.slice(0, node.nodeValue.length - 1);
        var caret = document.createRange();
        caret.setStart(node, node.nodeValue.length);
        caret.collapse(true);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(caret);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return true;
      }
      return false;
    }
    for (i = 0; i < nodes.length; i++) {
      node = nodes[i];
      probe = document.createRange();
      probe.selectNodeContents(node);
      if (!node.nodeValue.length || probe.compareBoundaryPoints(Range.START_TO_START, range) < 0)
        continue;
      if (mk && !sameFlow(node, mk, false))
        continue;
      node.nodeValue = node.nodeValue.slice(1);
      var after = document.createRange();
      after.setStart(node, 0);
      after.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(after);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  /* ---------------- 上下方向键跨块 ----------------
     每个块是独立的 contenteditable，WebKit 在块首/块尾会停住。这里只在
     「光标位于块的第一/最后一可视行」时接管，把光标搬到相邻块对应位置；
     其余情况交回原生，块内逐行移动、表格/代码块内部导航都不受影响。 */

  return {
    collapseAt: collapseAt,
    markerAdjacent: markerAdjacent,
    caretInsideMarker: caretInsideMarker,
    editableTextNodes: editableTextNodes,
    deleteVisibleChar: deleteVisibleChar
  };
  })();

  var collapseAt = MarkerCaret.collapseAt;
  var markerAdjacent = MarkerCaret.markerAdjacent;
  var caretInsideMarker = MarkerCaret.caretInsideMarker;
  var editableTextNodes = MarkerCaret.editableTextNodes;
  var deleteVisibleChar = MarkerCaret.deleteVisibleChar;
