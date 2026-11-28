  var BlockMenu = (function blockMenuModule() {
  /* ---------- 块菜单 ---------- */

  function closeBlockMenu() {
    removeMenu(blockMenu);
    blockMenu = null;
    blockMenuTarget = null;
  }

  function openBlockMenu(block, x, y) {
    if (!block || mode === 'source')
      return;
    closeTurnMenu();
    SlashMenu.closeSlash(false);
    closeBlockMenu();
    blockMenuTarget = block;
    blockMenu = document.createElement('div');
    blockMenu.id = 'block-menu';
    var html = '';
    html += '<div class="turn-item" data-act="above">在上方插入</div>';
    html += '<div class="turn-item" data-act="below">在下方插入</div>';
    html += '<div class="turn-item" data-act="duplicate">复制副本</div>';
    html += '<div class="turn-item" data-act="delete">删除</div>';
    html += '<div class="turn-sep"></div>';
    html += '<div class="turn-title">转为</div>';
    TURN_ITEMS.forEach(function (item) {
      html += '<div class="turn-item" data-key="' + item.key + '">' + Util.escapeHtml(item.label) + '</div>';
    });
    blockMenu.innerHTML = html;
    // 按下不抢焦点、不动选区（与 turn-menu 同一处理）；动作在 mouseup 派发
    blockMenu.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    blockMenu.addEventListener('mouseup', function (event) {
      var hit = event.target.closest ? event.target.closest('.turn-item') : null;
      if (!hit)
        return;
      event.preventDefault();
      var target = blockMenuTarget;
      var act = hit.getAttribute('data-act');
      var key = hit.getAttribute('data-key');
      closeBlockMenu();
      if (!target || !target.parentNode)
        return;
      if (act === 'above')
        BlockMenuActions.insertBlockNear(target, true);
      else if (act === 'below')
        BlockMenuActions.insertBlockNear(target, false);
      else if (act === 'duplicate')
        BlockMenuActions.duplicateBlock(target);
      else if (act === 'delete')
        BlockMenuActions.removeBlock(target);
      else if (key)
        BlockMenuActions.turnBlockTo(target, key);
    });
    placeMenu(blockMenu, { left: x, top: y, bottom: y, right: x });
  }

  return {
    closeBlockMenu: closeBlockMenu,
    openBlockMenu: openBlockMenu
  };
  })();
