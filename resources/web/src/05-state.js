  var crossSel = null;        // { anchor, focus, goalX }，整篇绝对字符偏移
  var crossLayer = null;      // 覆盖层（position:absolute，挂在 body）
  var crossAnnounced = false; // 与外壳同步的「是否有跨块选区」状态
  var dragCross = null;       // { anchor, el, x, y, goalX }
  var dragScrollTimer = 0;
  var findBar = null, findInput = null, findReplace = null;
  var findCount = null, findNote = null, findLayer = null;
  var findMatches = [], findActive = -1, findTimer = 0, findNoteTimer = 0;
  var findCaret = null;         // 打开查找前的原光标
  var findJumped = null;        // 最近一次跳转到的命中
  var findInSource = false;     // 本轮命中是 sourceEl.value 上的区间
  var slashState = null;   // { el, start, end, index }
  var slashMenu = null;
  var turnMenu = null;
  var langMenu = null;       // 挂在 body 上的下拉面板
  var langComposing = false; // 搜索框自己的输入法组字状态
  var blockHandle = null;
  var blockHandleTarget = null;   // 手柄当前停靠的块
  var blockHandleKeep = false;    // 指针停在手柄上，离开正文也不隐藏
  var blockMenu = null;
  var blockMenuTarget = null;
  var blockDrag = null;           // 正在拖拽的块
  var dragPending = null;         // 手柄按下的起点（尚未确认是拖拽还是单击）
  var insertLine = null;
  var pdfSavedScrollY = 0;
  var mermaidPending = 0;
  var mermaidTimer = null;
