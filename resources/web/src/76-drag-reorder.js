  var DragReorder = (function dragReorderModule() {
  /* ---------- 拖拽重排（指针事件，不依赖 HTML5 DnD） ---------- */

  function onHandleDown(event) {
    if (event.button !== 0)
      return;
    // 手柄不参与选字与聚焦：块保持原状，拖拽与菜单都由这里接管
    event.preventDefault();
    if (!blockHandleTarget || mode === 'source')
      return;
    BlockHandle.ensureBlockHandle();
    dragPending = { x: event.clientX, y: event.clientY };
    document.addEventListener('mousemove', onHandleMove, true);
    document.addEventListener('mouseup', onHandleUp, true);
  }

  function onHandleMove(event) {
    if (!dragPending)
      return;
    if (!blockDrag) {
      if (Math.abs(event.clientY - dragPending.y) < 4 && Math.abs(event.clientX - dragPending.x) < 4)
        return;
      blockDrag = blockHandleTarget;
      if (!blockDrag || blockDrag.parentNode !== root) {
        dragPending = null;
        return;
      }
      EditingSnapshot.commitHistory();   // 拖拽前的块序固定为一个撤销步骤
      blockDrag.classList.add('block-dragging');
      BlockMenu.closeBlockMenu();
      blockHandle.style.display = 'none';
    }
    event.preventDefault();
    InsertLine.positionInsertLine(InsertLine.blockDropRef(event.clientY));
    // 拖到视口上下边缘时自动滚动，长文档也能一路拖到底
    if (event.clientY < 40)
      window.scrollBy(0, -14);
    else if (event.clientY > window.innerHeight - 40)
      window.scrollBy(0, 14);
  }

  function onHandleUp(event) {
    document.removeEventListener('mousemove', onHandleMove, true);
    document.removeEventListener('mouseup', onHandleUp, true);
    if (blockDrag) {
      var ref = InsertLine.blockDropRef(event.clientY);
      var moved = false;
      if (ref) {
        if (ref !== blockDrag.nextElementSibling) {
          root.insertBefore(blockDrag, ref);
          moved = true;
        }
      } else if (root.lastElementChild !== blockDrag) {
        root.appendChild(blockDrag);
        moved = true;
      }
      blockDrag.classList.remove('block-dragging');
      blockDrag = null;
      if (insertLine)
        insertLine.style.display = 'none';
      if (moved)
        Menus.afterBlockStructureChange();
      BlockHandle.positionBlockHandle();
    } else if (dragPending && blockHandleTarget) {
      // 没有位移 = 单击：在手柄下方弹出块菜单
      var r = blockHandle.getBoundingClientRect();
      BlockMenu.openBlockMenu(blockHandleTarget, r.left, r.bottom + 4);
    }
    dragPending = null;
  }

  return {
    onHandleDown: onHandleDown,
    onHandleUp: onHandleUp
  };
  })();
