  /* ---------------- 查找 / 替换（Cmd+F） ----------------
     高亮用「覆盖层」画：用 Range.getClientRects() 取每个命中的几何，把绝对定位的
     色块盖在上面（#find-layer 挂在 body、pointer-events:none）。文档里不插入任何
     节点，所以 dataset.raw / textContent 一字不变；关闭时覆盖层与查找条一起从 DOM
     移除，不留任何元素。覆盖层不占排版，块几何不受影响。

     命中集合按文档顺序生成：块顺序 → 表格单元格顺序 → 单元格内下标顺序，
     跨块连续编号、连续跳转，正着/反着都能绕回。查找文本是「整篇可见文本」：
     每个块各占一段，块与块之间用一个虚拟换行连接；查询里用 ⌥↩ 输入换行，
     命中就可以从上一块跨到下一块。表格单元格之间、分隔线两侧用不可匹配的
     哨兵隔开，所以命中不会跨单元格，也不会跨过分隔线。

     大小写：两边统一转小写再比对；中文与全角标点不受影响。不做正则、不做整词、
     不做空白归一化（连续空格要按原样输入）。

     替换是「按原文偏移改 dataset.raw，再整块重排」：标记结构、代码围栏、表格
     管道都由 renderBlock 从新原文重建，撤销栈记一步（整篇快照）。块内命中可以
     跨文本节点：只要起点/终点都在行内格式之外，区间里的 **、`、[ 等要么没有，
     要么是完整的行内结构，替换后 Markdown 仍然合法（行内格式会随区间一起被
     替换掉）。起点或终点落在 <strong>/<em>/<a>/`<code>` 内部时仍拒绝，避免留下
     不成对的标记。替换文本含换行 / 表格里的 | / 代码里的 ``` 也拒绝。跨块命中
     走整篇源码重建：允许替换文本含换行，但两端或中间夹着代码块、表格、分隔线
     时拒绝，避免把围栏或列结构改坏。

     焦点：查找期间输入焦点留在查找框；wysiwyg 编辑态跳转会把焦点交给命中的块并
     选中该词（先 focus 触发 enterEdit，再覆盖选区）。此时 Enter/Shift+Enter 仍由
     文档级监听接管为「下一个/上一个」。源码模式（Cmd+E）没有 DOM 高亮层，跳转时
     把焦点交给 textarea 并选中命中（原生选区即是高亮），其余命中只计数。

     关闭时若跳转过，光标留在最后一个命中；没跳转过就回到打开查找前的原位置。 */

  var findBar = null, findInput = null, findReplace = null;
  var findCount = null, findNote = null, findLayer = null;
  var findMatches = [], findActive = -1, findTimer = 0, findNoteTimer = 0;
  var findPaintFrame = 0;       // 合并同一帧内的多次重画请求
  var findCaret = null;         // 打开查找前的原光标
  var findJumped = null;        // 最近一次跳转到的命中
  var findInSource = false;     // 本轮命中是 sourceEl.value 上的区间

  function findRuns(block) {
    var runs = [];
    function collect(scope) {
      var nodes = [];
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        var host = node.parentNode;
        if (!host || !host.closest)
          continue;
        if (host.closest('.mk, .gutter, .code-lang, .tbl-align'))
          continue;
        if (!node.nodeValue)
          continue;
        nodes.push(node);
      }
      if (!nodes.length)
        return;
      var text = '';
      var table = [];
      for (var i = 0; i < nodes.length; i++) {
        table.push({ node: nodes[i], start: text.length });
        text += nodes[i].nodeValue;
      }
      runs.push({ text: text, nodes: table });
    }

    if (isCodeBlock(block)) {
      var code = codeEl(block);
      if (code)
        collect(code);
      return runs;
    }
    if (block.classList && block.classList.contains('table')) {
      var cells = block.querySelectorAll('th,td');
      for (var c = 0; c < cells.length; c++) {
        if (cells[c].closest('.tbl-align'))
          continue;
        collect(cells[c]);
      }
      return runs;
    }
    collect(block);
    return runs;
  }

  // 段内字符下标 → DOM 点（同一段内的节点共享一个连续字符串）。
  // 边界必须区分「起点」和「终点」：下标正好落在两个文本节点的接缝上时，
  // 起点取后一个节点的 0，终点取前一个节点的末尾；否则一个落在单个 token
  // 内部的命中会被算成跨节点区间，替换会被误判为「跨着色边界」，
  // Range 也会把多出来的后半段一起高亮。
  function findPoint(run, index, isEnd) {
    var nodes = run.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var start = nodes[i].start;
      var len = nodes[i].node.nodeValue.length;
      if (isEnd ? index <= start + len : index < start + len)
        return { node: nodes[i].node, offset: index - start };
    }
    if (isEnd) {
      var last = nodes[nodes.length - 1];
      return { node: last.node, offset: last.node.nodeValue.length };
    }
    var head = nodes[0];
    return { node: head.node, offset: 0 };
  }

  function dropFindLayer() {
    if (findLayer && findLayer.parentNode)
      findLayer.parentNode.removeChild(findLayer);
    findLayer = null;
  }

  function ensureFindLayer() {
    if (!findLayer) {
      findLayer = document.createElement('div');
      findLayer.id = 'find-layer';
      findLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(findLayer);
    }
    return findLayer;
  }

  function findRects(match) {
    var rects = match.range.getClientRects();
    var out = [];
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].width > 0.5 && rects[i].height > 0.5)
        out.push(rects[i]);
    }
    return out;
  }

  function paintFind() {
    if (findInSource || !findMatches.length) {
      dropFindLayer();
      return;
    }
    var layer = ensureFindLayer();
    while (layer.firstChild)
      layer.removeChild(layer.firstChild);
    for (var i = 0; i < findMatches.length; i++) {
      var rects = findRects(findMatches[i]);
      for (var r = 0; r < rects.length; r++) {
        var box = document.createElement('div');
        box.className = 'find-hit' + (i === findActive ? ' active' : '');
        box.style.left = (rects[r].left + window.scrollX) + 'px';
        box.style.top = (rects[r].top + window.scrollY) + 'px';
        box.style.width = rects[r].width + 'px';
        box.style.height = rects[r].height + 'px';
        layer.appendChild(box);
      }
    }
  }

  // 排版一变（缩放、图片解码完成、字体替换）命中矩形就过期，但这三种情况下都
  // 不会触发 window resize：统一合并到下一帧重画，避免一次操作里重复计算。
  function scheduleFindPaint() {
    if (!findLayer || !findMatches.length || findPaintFrame)
      return;
    findPaintFrame = requestAnimationFrame(function () {
      findPaintFrame = 0;
      if (findLayer && findMatches.length)
        paintFind();
    });
  }

  function updateFindCount() {
    if (!findCount)
      return;
    findCount.textContent = findMatches.length
      ? (findActive + 1) + '/' + findMatches.length
      : '0/0';
  }

  function setFindNote(text) {
    if (!findNote)
      return;
    if (findNoteTimer) {
      clearTimeout(findNoteTimer);
      findNoteTimer = 0;
    }
    findNote.textContent = text || '';
    findNote.style.display = text ? 'inline' : 'none';
    if (text) {
      findNoteTimer = setTimeout(function () {
        findNoteTimer = 0;
        if (findNote) {
          findNote.textContent = '';
          findNote.style.display = 'none';
        }
      }, 4200);
    }
  }

  // 整篇可见文本：每个块占一段，块与块之间用一个虚拟换行连接；表格单元格之间、
  // 分隔线两侧用不可匹配的 \0 隔开。返回全文与文本段索引（at 为段在全文中的起点），
  // 命中下标 → 段 → DOM 点都靠这张表。
