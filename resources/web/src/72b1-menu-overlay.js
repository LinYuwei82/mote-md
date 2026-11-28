  /* ---------- 空白文档占位提示 ----------
     提示用 CSS ::before 绘制，不属于 textContent，因此绝不会写进 dataset.raw；
     只在「整篇只有一个空块」时出现，正常文档里回车产生的新空块不受影响。 */
  function updatePlaceholder() {
    if (!root)
      return;
    var blocks = blockList();
    var bare = mode !== 'source' && blocks.length === 1
      && String(rawOf(blocks[0])).trim() === '';
    if (bare !== root.classList.contains('bare'))
      root.classList.toggle('bare', bare);
  }

  /* ---------- 斜杠命令浮层 ----------
     浮层挂在 body 上（不在 #editor 里），提示文字不进入文档 DOM；
     插入统一走 convertRaw / applyRawToBlock，与快捷键、右键菜单同一套实现。 */
  var SLASH_ITEMS = [
    { key: 'code', label: '代码块', hint: '```', words: 'code daima codeblock 代码块' },
    { key: 'inlineCode', label: '行内代码', hint: '`', words: 'inline code hangnei 行内代码' },
    { key: 'table', label: '表格', hint: '|', words: 'table biaoge 表格' },
    { key: 'h1', label: '标题 1', hint: '#', words: 'h1 heading biaoti 标题1 一级标题' },
    { key: 'h2', label: '标题 2', hint: '##', words: 'h2 heading biaoti 标题2 二级标题' },
    { key: 'h3', label: '标题 3', hint: '###', words: 'h3 heading biaoti 标题3 三级标题' },
    { key: 'ul', label: '无序列表', hint: '-', words: 'ul bullet list wuxu 无序列表' },
    { key: 'ol', label: '有序列表', hint: '1.', words: 'ol number list youxu 有序列表' },
    { key: 'quote', label: '引用', hint: '>', words: 'quote yinyong 引用' },
    { key: 'hr', label: '分隔线', hint: '---', words: 'hr divider fengexian 分隔线' },
    { key: 'image', label: '图片', hint: '![]', words: 'image picture tupian 图片' },
    { key: 'link', label: '链接', hint: '[]()', words: 'link lianjie 链接' }
  ];

  var slashState = null;   // { el, start, end, index }
  var slashMenu = null;
  var turnMenu = null;

  function removeMenu(node) {
    if (node && node.parentNode)
      node.parentNode.removeChild(node);
  }

  function caretClientRect() {
    var selection = window.getSelection();
    if (selection && selection.rangeCount) {
      var range = selection.getRangeAt(0).cloneRange();
      range.collapse(true);
      var rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height || rect.top))
        return rect;
    }
    var el = slashState ? slashState.el : null;
    if (el)
      return el.getBoundingClientRect();
    return null;
  }

  function placeMenu(node, rect) {
    var x = rect ? rect.left : 40;
    var y = rect ? rect.bottom + 6 : 80;
    document.body.appendChild(node);
    var width = node.offsetWidth;
    var height = node.offsetHeight;
    if (x + width > window.innerWidth - 8)
      x = Math.max(8, window.innerWidth - width - 8);
    if (y + height > window.innerHeight - 8)
      y = Math.max(8, (rect ? rect.top : 80) - height - 6);
    // 锚点本身可能在窗口外（页面滚动/极端窗口尺寸），仍把面板钳进可视区
    x = Math.max(8, x);
    y = Math.max(8, y);
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  }
