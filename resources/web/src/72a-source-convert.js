  var SourceConvert = (function sourceConvertModule() {
  /* ---------- 源码模式：同一套规则作用于 textarea 文本 ---------- */

  // 段落起点：回退到空白行之后。连续多个空行要整段跨过，不能只退两格，
  // 否则保存了 3 个换行的文档在源码模式下转换会吃掉一个换行。
  function paragraphStart(text, position) {
    var gap = text.lastIndexOf('\n\n', Math.max(0, position - 1));
    if (gap < 0)
      return 0;
    while (gap < text.length && text.charAt(gap) === '\n')
      gap++;
    return gap;
  }

  function paragraphEnd(text, position) {
    var gap = text.indexOf('\n\n', position);
    if (gap < 0)
      return text.length;
    while (gap > 0 && text.charAt(gap - 1) === '\n')
      gap--;
    return gap;
  }

  function sourceParagraph(text, start, end) {
    var from = paragraphStart(text, start);
    var to = paragraphEnd(text, end);
    return { start: from, end: to, text: text.slice(from, to) };
  }

  function applySourceText(text, start, end) {
    sourceEl.value = text;
    sourceEl.focus();
    sourceEl.setSelectionRange(start, end);
    sourceEl.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(commitHistory, 0);
  }

  function sourceInline(kind) {
    var text = sourceEl.value;
    var start = sourceEl.selectionStart;
    var end = sourceEl.selectionEnd;
    var out = inlineTransform(text, start, end, kind);
    if (out.raw === text)
      return;
    commitHistory();
    applySourceText(out.raw, out.start, out.end);
  }

  function sourceConvert(type, toggle) {
    var text = sourceEl.value;
    var start = sourceEl.selectionStart;
    var end = sourceEl.selectionEnd;
    // 多行选区：按当前段落范围整体转换（与块模型一致）
    var range = (start === end || /^\s*$/.test(text.slice(start, end)))
      ? sourceParagraph(text, start, end)
      : { start: paragraphStart(text, start), end: paragraphEnd(text, end) };
    if (range.end < 0)
      range.end = text.length;
    if (range.start < 0)
      range.start = 0;
    var raw = text.slice(range.start, range.end);
    var next = convertRaw(raw, type, toggle);
    if (next === raw)
      return;
    var shift = leadLength(next, kindOfRaw(next)) - leadLength(raw, kindOfRaw(raw));
    commitHistory();
    applySourceText(text.slice(0, range.start) + next + text.slice(range.end),
      Math.max(range.start, start + shift), Math.max(range.start, end + shift));
  }


  return {
    sourceInline: sourceInline,
    sourceConvert: sourceConvert
  };
  })();

  var sourceInline = SourceConvert.sourceInline;
  var sourceConvert = SourceConvert.sourceConvert;
