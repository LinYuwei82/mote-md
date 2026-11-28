  var CrossRange = (function crossRangeModule() {
  function dropCrossLayer() {
    if (crossLayer && crossLayer.parentNode)
      crossLayer.parentNode.removeChild(crossLayer);
    crossLayer = null;
  }

  function ensureCrossLayer() {
    if (!crossLayer) {
      crossLayer = document.createElement('div');
      crossLayer.id = 'cross-layer';
      crossLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(crossLayer);
    }
    return crossLayer;
  }

  // 状态变化才回报：macOS 菜单的复制/剪切在折叠选区下会被 WebKit 判成「不可
  // 复制」，需要外壳改走 EditorController::clipboardCommand 这条回路。
  function announceCross() {
    var active = !!crossSel;
    if (active === crossAnnounced)
      return;
    crossAnnounced = active;
    Util.post({ type: 'crossSelection', active: active });
  }

  function clearCrossSelection() {
    if (!crossSel)
      return;
    crossSel = null;
    dropCrossLayer();
    announceCross();
  }

  // 第 index 块在整篇里的字符长度与起点（与撤销栈同一口径）
  function blockAbsoluteSpan(blocks, gaps, index) {
    var base = DocumentModel.blockStartOffset(blocks, gaps, index);
    return { base: base, stop: base + blocks[index].length };
  }

  // 区间里是否真的有块正文：块间空白处投点得到的「只跨过空行」区间画不出任何
  // 高亮，扩展时要跳过这种落点，继续往下一可视行找。
  function crossRangeCoversText(from, to) {
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    var base = 0;
    for (var i = 0; i < blocks.length && base < to; i++) {
      var span = blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      if (span.stop > span.base
          && Math.min(to, span.stop) > Math.max(from, span.base))
        return true;
      base = span.stop;
    }
    return false;
  }

  function absoluteOf(el, node, offset) {
    var list = BlockParse.blockList();
    var index = list.indexOf(el);
    if (index < 0)
      return null;
    var blocks = DocumentModel.collectBlocks();
    var gaps = DocumentModel.collectGaps();
    return DocumentModel.blockStartOffset(blocks, gaps, index) + rawOffsetAtPoint(el, node, offset);
  }

  // 块内某个 DOM 点 → 块内 raw 偏移（代码块补上围栏前缀）
  function rawOffsetAtPoint(el, node, offset) {
    var scope = Navigation.navScope(el) || el;
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(node, offset);
    } catch (error) {
      return 0;
    }
    return prefix.toString().length + (LayoutCode.isCodeBlock(el) ? LayoutCode.codePrefixLength(el) : 0);
  }

  // 块内 raw 区间 → Range。分隔线没有可量测的文字，原型里不画它的高亮。
  function crossBlockRange(el, start, end) {
    if (!el || el.classList.contains('hr'))
      return null;
    var scope = Navigation.navScope(el);
    if (!scope)
      return null;
    var prefix = LayoutCode.isCodeBlock(el) ? LayoutCode.codePrefixLength(el) : 0;
    var limit = scope.textContent.length;
    var from = Math.max(0, Math.min(start - prefix, limit));
    var to = Math.max(0, Math.min(end - prefix, limit));
    if (to <= from)
      return null;
    var a = CaretOffset.locateOffset(scope, from);
    var b = CaretOffset.locateOffset(scope, to);
    var range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (error) {
      return null;
    }
    return range;
  }

  return {
    dropCrossLayer: dropCrossLayer,
    ensureCrossLayer: ensureCrossLayer,
    announceCross: announceCross,
    clearCrossSelection: clearCrossSelection,
    blockAbsoluteSpan: blockAbsoluteSpan,
    crossRangeCoversText: crossRangeCoversText,
    absoluteOf: absoluteOf,
    rawOffsetAtPoint: rawOffsetAtPoint,
    crossBlockRange: crossBlockRange
  };
  })();
