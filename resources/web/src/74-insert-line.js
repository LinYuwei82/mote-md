  /* ---------- 插入指示线 ---------- */

  function ensureInsertLine() {
    if (insertLine)
      return insertLine;
    insertLine = document.createElement('div');
    insertLine.id = 'block-insert-line';
    insertLine.setAttribute('aria-hidden', 'true');
    document.body.appendChild(insertLine);
    return insertLine;
  }

  // 指针纵坐标 → 落点参照块（插到它前面）；null 表示插到文档末尾。
  // 拖拽块自身跳过，不参与落点判定。
  function blockDropRef(clientY) {
    var list = blockList();
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === blockDrag)
        continue;
      var r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2)
        return el;
    }
    return null;
  }

  function positionInsertLine(ref) {
    var line = ensureInsertLine();
    if (!ref) {
      var list = blockList();
      var last = null;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] !== blockDrag) {
          last = list[i];
          break;
        }
      }
      if (!last) {
        line.style.display = 'none';
        return;
      }
      var lr = last.getBoundingClientRect();
      line.style.left = lr.left + 'px';
      line.style.width = Math.max(40, lr.width) + 'px';
      line.style.top = (lr.bottom + 2) + 'px';
      line.style.display = 'block';
      return;
    }
    var r = ref.getBoundingClientRect();
    line.style.left = r.left + 'px';
    line.style.width = Math.max(40, r.width) + 'px';
    line.style.top = (r.top - 2) + 'px';
    line.style.display = 'block';
  }

