  var crossSel = null;        // { anchor, focus, goalX }，整篇绝对字符偏移
  var crossLayer = null;      // 覆盖层（position:absolute，挂在 body）
  var crossAnnounced = false; // 与外壳同步的「是否有跨块选区」状态
  var dragCross = null;       // { anchor, el, x, y, goalX }
  var dragScrollTimer = 0;
