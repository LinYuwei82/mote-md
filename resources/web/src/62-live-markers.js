  (function liveMarkersModule() {
  /* ---------------- 标记标签避让 ---------------- */

  var liveFrame = 0;

  function clearLiveMarkers() {
    var nodes = Core.root.querySelectorAll('.mk.mk-live');
    for (var i = 0; i < nodes.length; i++)
      nodes[i].classList.remove('mk-live');
  }

  // 相邻标记（如 **粗** 紧挨 *斜*）的淡色标签会重叠。标签本身绝对定位、零宽，
  // 不参与任何排版；因此只让离光标最近的一个标记显示标签，其余保持隐藏：
  // 无论多密集都不会叠字，也不会改变行高、宽度或块坐标。
  function updateLiveMarker() {
    if (!Config.INLINE_PROTO || Composition.isComposing())
      return;
    clearLiveMarkers();
    var el = CaretCode.blockOf(document.activeElement);
    if (!el || !el.classList.contains('editing'))
      return;
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return;
    var range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer))
      return;
    var markers = el.querySelectorAll('.mk');
    if (!markers.length)
      return;
    var caret = CaretCode.offsetIn(el, range.startContainer, range.startOffset);
    if (caret < 0)
      return;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < markers.length; i++) {
      var mk = markers[i];
      var index = Array.prototype.indexOf.call(mk.parentNode.childNodes, mk);
      var start = CaretCode.offsetIn(el, mk.parentNode, index);
      if (start < 0)
        continue;
      var end = start + mk.textContent.length;
      var dist = caret < start ? start - caret : (caret > end ? caret - end : 0);
      if (dist < bestDist) {
        bestDist = dist;
        best = mk;
      }
      if (!dist)
        break;
    }
    if (best)
      best.classList.add('mk-live');
  }

  function scheduleLiveMarker() {
    if (!Config.INLINE_PROTO || liveFrame)
      return;
    // 用定时器而不是 rAF：拖选时 selectionchange 很密，节流到一帧即可；
    // 窗口在后台/锁屏时 rAF 可能不跑，定时器仍能保证标签状态正确。
    liveFrame = setTimeout(function () {
      liveFrame = 0;
      updateLiveMarker();
    }, 16);
  }

  document.addEventListener('selectionchange', scheduleLiveMarker);
  })();
