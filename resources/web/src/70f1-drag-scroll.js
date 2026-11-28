  var DragScroll = (function dragScrollModule() {
  function stopDragScroll() {
    if (dragScrollTimer) {
      clearInterval(dragScrollTimer);
      dragScrollTimer = 0;
    }
  }

  // 指针处的落点；行号栏/语言徽标/工具条不算正文
  function crossHitAt(x, y) {
    if (!document.caretRangeFromPoint)
      return null;
    var range = document.caretRangeFromPoint(x, y);
    if (!range)
      return null;
    var el = CaretCode.blockOf(range.startContainer);
    if (!el || !CrossPaint.crossHitNodeOk(el, range.startContainer))
      return null;
    var abs = CrossRange.absoluteOf(el, range.startContainer, range.startOffset);
    if (abs === null)
      return null;
    return { el: el, range: range, abs: abs };
  }

  // 原生选区收成焦点处的折叠光标：焦点块先 focus（触发 enterEdit），再落点
  function collapseAtCrossHit(hit) {
    if (document.activeElement !== hit.el)
      hit.el.focus();
    var selection = window.getSelection();
    if (!selection)
      return;
    selection.removeAllRanges();
    selection.addRange(hit.range);
  }

  function dragScrollTick() {
    if (!dragCross) {
      stopDragScroll();
      return;
    }
    var y = dragCross.y;
    var step = y < DRAG_EDGE ? -DRAG_STEP
      : (y > window.innerHeight - DRAG_EDGE ? DRAG_STEP : 0);
    if (!step) {
      stopDragScroll();
      return;
    }
    var before = window.scrollY;
    window.scrollBy(0, step);
    if (window.scrollY === before) {
      stopDragScroll();
      return;
    }
    updateCrossDrag(dragCross.x, y);
  }

  function updateCrossDrag(x, y) {
    if (!dragCross)
      return;
    dragCross.x = x;
    dragCross.y = y;
    // 拖到视口上下边缘时自己滚：原生拖选的自动滚动已经被折叠光标打断
    if (y < DRAG_EDGE || y > window.innerHeight - DRAG_EDGE) {
      if (!dragScrollTimer)
        dragScrollTimer = setInterval(dragScrollTick, 60);
    } else {
      stopDragScroll();
    }
    var hit = crossHitAt(x, Math.max(0, Math.min(y, window.innerHeight - 1)));
    if (!hit)
      return;
    if (!crossSel) {
      // 还在锚点块内：交回原生拖选，越出锚点块才升格
      if (hit.el === dragCross.el)
        return;
      crossSel = { anchor: dragCross.anchor, focus: hit.abs, goalX: dragCross.goalX };
      CrossRange.announceCross();
    } else if (hit.abs === crossSel.anchor) {
      CrossRange.clearCrossSelection();
      return;
    }
    crossSel.focus = hit.abs;
    collapseAtCrossHit(hit);
    CrossPaint.paintCrossSelection();
  }

  return {
    stopDragScroll: stopDragScroll,
    crossHitAt: crossHitAt,
    updateCrossDrag: updateCrossDrag
  };
  })();
