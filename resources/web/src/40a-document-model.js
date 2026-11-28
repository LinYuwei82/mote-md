  var DocumentModel = (function documentModelModule() {
  /* ---------------- 文档模型与选区 ---------------- */

  // 块原文：代码块的 DOM 里还有行号栏，textContent 不能代表原文，编辑期间由
  // dataset.raw 逐次同步（见 syncCode），渲染态本来就用 dataset.raw。
  function blockRawText(el) {
    var raw;
    if (LayoutCode.isCodeBlock(el))
      raw = el.dataset.raw;
    else
      raw = el.classList.contains('editing') ? el.textContent : el.dataset.raw;
    if (raw === undefined)
      raw = el.textContent;
    return String(raw).replace(/\r/g, '').replace(/\n+$/, '');
  }

  function collectBlocks() {
    return blockList().map(blockRawText);
  }

  // 第 index 块之前的空行数：载入、撤销重建时写进 data-gap；用户新建的块没有
  // 这个属性，第 0 块按文首 0 个、其余按 2 个（与改动前固定的 '\n\n' 一致）。
  function blockGap(el, first) {
    var value = el && el.dataset ? parseInt(el.dataset.gap, 10) : NaN;
    if (isNaN(value) || value < 0)
      return first ? 0 : 2;
    return value;
  }

  function collectGaps() {
    var list = blockList();
    var gaps = [];
    for (var i = 0; i < list.length; i++)
      gaps.push(blockGap(list[i], i === 0));
    return gaps;
  }

  function gapBefore(gaps, index) {
    if (gaps && index < gaps.length)
      return gaps[index];
    return index === 0 ? 0 : 2;
  }

  // 整篇文本 = 各块前的间隔 + 块原文 + 文末换行
  function layoutText(blocks, gaps, trail) {
    var out = '';
    for (var i = 0; i < blocks.length; i++) {
      for (var n = gapBefore(gaps, i); n > 0; n--)
        out += '\n';
      out += blocks[i];
    }
    for (var t = trail > 0 ? trail : 0; t > 0; t--)
      out += '\n';
    return out;
  }

  // 第 index 块在整篇文本里的起始偏移（绝对偏移 → 块内偏移的反向换算）
  function blockStartOffset(blocks, gaps, index) {
    var offset = 0;
    for (var i = 0; i <= index && i < blocks.length; i++) {
      offset += gapBefore(gaps, i);
      if (i < index)
        offset += blocks[i].length;
    }
    return offset;
  }

  function currentSource() {
    if (mode === 'source')
      return sourceEl.value;
    return layoutText(collectBlocks(), collectGaps(), trailingNewlines);
  }

  function scheduleDirty() {
    if (dirtyTimer)
      clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(function () {
      dirtyTimer = null;
      Util.post({ type: 'dirty', value: currentSource() !== savedText });
      postWordCount();
    }, 220);
  }

  // 字数口径（README 与 PACKAGING 同步说明）：
  // - 中文：CJK 统一表意文字（含扩展 A 与兼容区）逐字计数；
  // - 英文：连续的字母/数字（允许词内 ' 与 -）算 1 个单词；
  // - 标点、空白、Markdown 标记符号（# > - * ` [ ](url) 等）不计；
  // - 代码块正文与表格单元格计入，围栏、行号、语言徽标不计。
  function plainTextOfRaw(raw) {
    var text = String(raw === undefined || raw === null ? '' : raw);
    if (/^```[^\n]*\n[\s\S]*\n?```\s*$/.test(text))
      return text.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
    return text.split('\n').map(function (line) {
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line))
        return '';
      if (line.indexOf('|') >= 0 && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
        return '';
      return line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' ');
    }).join('\n');
  }

  function countText(text) {
    var plain = text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1');
    var cjk = (plain.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    var words = (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    return { cjk: cjk, words: words };
  }

  function postWordCount() {
    var stats = countText(collectBlocks().map(plainTextOfRaw).join('\n'));
    var label = document.getElementById('status-stats');
    if (label)
      label.textContent = '中文 ' + stats.cjk + ' 字 · 英文 ' + stats.words + ' 词';
    Util.post({ type: 'stats', cjk: stats.cjk, words: stats.words });
  }

  return {
    collectBlocks: collectBlocks,
    blockGap: blockGap,
    collectGaps: collectGaps,
    gapBefore: gapBefore,
    layoutText: layoutText,
    blockStartOffset: blockStartOffset,
    currentSource: currentSource,
    scheduleDirty: scheduleDirty,
    postWordCount: postWordCount,
    plainTextOfRaw: plainTextOfRaw,
    countText: countText
  };
  })();
