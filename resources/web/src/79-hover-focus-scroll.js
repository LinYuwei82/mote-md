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
      hideBlockHandle();
      return;
    }
    var el = blockOf(t);
    if (el) {
      ensureBlockHandle();
      setHandleBlock(el);
    }
  });

  document.addEventListener('mouseleave', function (event) {
    // 拖拽中指针移出窗口时 mouseup 不会送达：按当前位置落块收尾，
    // 否则 blockDrag 卡住，手柄与指示线都会悬死
    if (blockDrag && dragPending) {
      onHandleUp(event);
      return;
    }
    hideBlockHandle();
  });

  root.addEventListener('focusin', function (event) {
    var el = blockOf(event.target);
    if (el) {
      ensureBlockHandle();
      setHandleBlock(el);
    }
  });

  window.addEventListener('scroll', function () {
    if (blockDrag)
      return;
    positionBlockHandle();
    closeBlockMenu();
  }, true);

  window.addEventListener('resize', function () {
    positionBlockHandle();
    closeBlockMenu();
  });

