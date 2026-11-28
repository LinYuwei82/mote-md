  (function hoverFocusScrollModule() {
  /* ---------- 悬停 / 焦点 / 滚动联动 ---------- */

  document.addEventListener('mousemove', function (event) {
    if (blockDrag)
      return;
    var t = event.target;
    if (blockHandle && blockHandle.contains(t)) {
      blockHandleKeep = true;
      return;
    }
    if (blockMenu && blockMenu.contains(t))
      return;
    if (mode === 'source' || !root.contains(t)) {
      BlockHandle.hideBlockHandle();
      return;
    }
    var el = CaretCode.blockOf(t);
    if (el) {
      BlockHandle.ensureBlockHandle();
      BlockHandle.setHandleBlock(el);
    }
  });

  document.addEventListener('mouseleave', function (event) {
    // 拖拽中指针移出窗口时 mouseup 不会送达：按当前位置落块收尾，
    // 否则 blockDrag 卡住，手柄与指示线都会悬死
    if (blockDrag && dragPending) {
      DragReorder.onHandleUp(event);
      return;
    }
    BlockHandle.hideBlockHandle();
  });

  root.addEventListener('focusin', function (event) {
    var el = CaretCode.blockOf(event.target);
    if (el) {
      BlockHandle.ensureBlockHandle();
      BlockHandle.setHandleBlock(el);
    }
  });

  window.addEventListener('scroll', function () {
    if (blockDrag)
      return;
    BlockHandle.positionBlockHandle();
    BlockMenu.closeBlockMenu();
  }, true);

  window.addEventListener('resize', function () {
    BlockHandle.positionBlockHandle();
    BlockMenu.closeBlockMenu();
  });
  })();
