  // 未转义 | 的下标。逐字符扫描而不是用正则后行断言：后者在 WebKit 16.4 之前
  // 是解析期语法错误，整份脚本都会加载失败。
  function pipeIndexes(line) {
    var out = [];
    for (var i = 0; i < line.length; i++) {
      // 前面是反斜杠的 \| 是单元格内容（Markdown 转义），不是列分隔符
      if (line.charAt(i) === '|' && line.charAt(i - 1) !== '\\')
        out.push(i);
    }
    return out;
  }

  // 按未转义的 | 切分，转义的 \| 原样留在片段里。
  function splitPipes(text) {
    var pipes = pipeIndexes(text);
    var out = [];
    var from = 0;
    for (var p = 0; p < pipes.length; p++) {
      out.push(text.slice(from, pipes[p]));
      from = pipes[p] + 1;
    }
    out.push(text.slice(from));
    return out;
  }

  function tableCells(line) {
    var trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    // 转义的 \| 不是分隔符；切分后再把单元格里的 \| 还原成 |
    return splitPipes(trimmed).map(function (cell) {
      return cell.trim().replace(/\\\|/g, '|');
    });
  }

  function isTableSource(lines) {
    return lines.length >= 2 && lines[0].indexOf('|') >= 0
      && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1]) && lines[1].indexOf('-') >= 0;
  }

  // 表格行拆成「前导边框 + 单元格 + 分隔符 + 尾随空白」，满足
  // lead + Σ(text + sep) + tail === line。单元格被就地编辑后仍能拼回逐字原文，
  // 不依赖 textContent 已丢失的 | 与对齐行。
  function splitTableLine(line) {
    var pipes = pipeIndexes(line);
    if (!pipes.length)
      return { lead: '', cells: [{ text: line, sep: '' }], tail: '' };

    var lead = '';
    var cellStart = 0;
    var seps = pipes.slice();
    if (line.slice(0, pipes[0]).trim() === '') {   // 起始竖线是边框
      lead = line.slice(0, pipes[0] + 1);
      cellStart = pipes[0] + 1;
      seps = seps.slice(1);
    }
    var trail = -1;
    if (seps.length && line.slice(pipes[pipes.length - 1] + 1).trim() === '')
      trail = pipes[pipes.length - 1];              // 末尾竖线是边框

    var cells = [];
    var from = cellStart;
    for (var s = 0; s < seps.length; s++) {
      if (seps[s] === trail)
        break;
      cells.push({ text: line.slice(from, seps[s]), sep: '|' });
      from = seps[s] + 1;
    }
    var end = trail >= 0 ? trail : line.length;
    cells.push({ text: line.slice(from, end), sep: trail >= 0 ? '|' : '' });
    return { lead: lead, cells: cells, tail: trail >= 0 ? line.slice(trail + 1) : '' };
  }

  function tableAlignments(line) {
    return tableCells(line).map(function (cell) {
      var left = cell.charAt(0) === ':';
      var right = cell.charAt(cell.length - 1) === ':';
      return left && right ? 'center' : (right ? 'right' : (left ? 'left' : ''));
    });
  }

  // 表格里的 | / 对齐行 / 换行都是零宽标记：参与 textContent（dataset.raw 靠它
  // 逐字还原原文），但不占版面；pipe 标记不带 <i>，编辑时不会浮出淡色标签。
  function pipeMarker(text) {
    return '<span class="mk mk-pipe" contenteditable="false">' + escapeHtml(text) + '</span>';
  }

  function tableRowHtml(line, align, tag, withNewline) {
    var row = splitTableLine(line);
    var html = '<tr>';
    for (var c = 0; c < row.cells.length; c++) {
      var cell = row.cells[c];
      var style = align[c] ? ' style="text-align:' + align[c] + '"' : '';
      html += '<' + tag + style + '>';
      if (c === 0 && row.lead)
        html += pipeMarker(row.lead);
      // 单元格内容里的转义 \|：反斜杠收进零宽标记（textContent 保留 \ 逐字），
      // 竖线可见渲染。这样显示是 |，而 splitTableLine 仍认得它是内容不是分隔符。
      var cellText = cell.text;
      if (cellText.indexOf('\\|') >= 0) {
        var segs = cellText.split('\\|');
        for (var g = 0; g < segs.length; g++) {
          if (g > 0)
            html += '<span class="mk mk-pipeesc" contenteditable="false">\\</span>|';
          html += renderInline(segs[g]);
        }
      } else {
        html += renderInline(cellText);
      }
      if (cell.sep)
        html += pipeMarker(cell.sep);
      if (c === row.cells.length - 1) {
        if (row.tail)
          html += pipeMarker(row.tail);
        if (withNewline)
          html += newlineMarker();
      }
      html += '</' + tag + '>';
    }
    return html + '</tr>';
  }

  // 列宽算法：WKWebView 的 auto 布局会把表格剩余空间「按列均分」，内容短的
  // 表格必然趋向等宽；Chromium（Typora）则按内容加权。引擎差异无法用 CSS
  // 消除，所以这里直接测量每列可见文本的最大内容宽度，按比例注入 colgroup
  // 百分比，任何引擎下列宽都由内容决定。
  var measureCtx = null;
  function measureTextWidth(text, bold) {
    if (!measureCtx)
      measureCtx = document.createElement('canvas').getContext('2d');
    var cs = getComputedStyle(document.body);
    var px = (parseFloat(cs.fontSize) || 16) * 0.95;   // table { font-size: 0.95em }
    measureCtx.font = (bold ? '600 ' : '300 ') + px + 'px ' + (cs.fontFamily || 'sans-serif');
    return measureCtx.measureText(text).width;
  }

  // 单元格原文 → 可见纯文本：链接/图片取文字、行内代码与强调去符号。
  // 注意：不要命名为 cellVisibleText——2058 行已有同名 DOM 节点版本，
  // 同作用域函数声明会相互覆盖。
  function stripMarkdownForWidth(text) {
    return text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|~~|\*|_)/g, '')
      .replace(/\\\|/g, '|')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
  }

  // 单元格渲染宽度 = 内容 + 两侧空格 + padding。DOM 里是 `|␣内容␣|`：
  // 空格夹在 pipe 标记与文本之间，不在行首/行尾，不参与折叠，必须计入；
  // 否则窄列会差着这两个空格刚好折行（不可断词被挤到下一行）。
  function cellEdgeWidth(text, bold) {
    return measureTextWidth(stripMarkdownForWidth(text), bold)
      + 2 * measureTextWidth(' ', bold) + COL_CELL_PAD_PX;
  }

  // 参照 wolai / Notion 的列宽策略，落实标准 auto 表格布局算法：
  //   · hi = max-content：最长行宽，封顶（超长内容换行，不无限吃掉其他列）；
  //   · lo = min-content：最长不可断段宽（长英文词/URL 不拦腰截断；
  //     CJK 可逐字断行，不抬高 lo）；
  //   · 空间充裕按内容比例拉伸；空间紧张先保 lo，再按增长空间 (hi-lo)
  //     分配剩余；连 lo 都放不下时保持 lo 宽、表格横向溢出滚动
  //     （wolai/Notion 都是滚动而不是把词压碎）。
  var COL_MIN_PX = 90;      // 短列保护：不被挤压到逐字换行
  var COL_MAX_PX = 460;     // 长列封顶
  var COL_CELL_PAD_PX = 24; // th/td 左右 padding 12px
  var COL_SAFETY_PX = 4;    // 百分比→像素取整误差余量，防不可断词差 1px 被折行
  var COL_FALLBACK_W = 685; // 块尚未入文档时的 #editor 内容宽（50rem - 2×3.6rem）

  // 最长不可断段宽度：CJK 每个字、空白两侧都可断行，其余连续非空白段不可断。
  var CJK_BREAK = '-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿';
  var MIN_UNIT_RE = new RegExp('[' + CJK_BREAK + ']|[^\\s' + CJK_BREAK + ']+', 'g');

  function minContentWidth(text, bold) {
    var plain = stripMarkdownForWidth(text);
    var units = plain.match(MIN_UNIT_RE);
    var best = 0;
    for (var i = 0; units && i < units.length; i++)
      best = Math.max(best, measureTextWidth(units[i], bold));
    return best + 2 * measureTextWidth(' ', bold) + COL_CELL_PAD_PX + COL_SAFETY_PX;
  }

  function tableColgroupHtml(head, bodyLines, availW) {
    var n = head.cells.length;
    if (!n)
      return { colgroup: '', minWidth: 0 };
    var lo = [];
    var hi = [];
    for (var c = 0; c < n; c++) {
      lo[c] = COL_MIN_PX;
      hi[c] = COL_MIN_PX;
    }
    function considerCells(cells, bold) {
      for (var k = 0; k < cells.length && k < n; k++) {
        hi[k] = Math.max(hi[k], cellEdgeWidth(cells[k].text, bold));
        lo[k] = Math.max(lo[k], minContentWidth(cells[k].text, bold));
      }
    }
    considerCells(head.cells, true);
    for (var r = 0; r < bodyLines.length; r++)
      considerCells(splitTableLine(bodyLines[r]).cells, false);
    var sumLo = 0;
    var sumHi = 0;
    for (var m = 0; m < n; m++) {
      hi[m] = Math.max(COL_MIN_PX, Math.min(hi[m], COL_MAX_PX));
      lo[m] = Math.max(COL_MIN_PX, Math.min(lo[m], COL_MAX_PX));
      if (lo[m] > hi[m])
        hi[m] = lo[m];
      sumLo += lo[m];
      sumHi += hi[m];
    }
    var W = availW > 100 ? availW : COL_FALLBACK_W;
    var widths = [];
    var base;
    if (sumHi <= W) {
      for (var a = 0; a < n; a++)
        widths[a] = hi[a];
      base = sumHi;              // 百分比铺满容器 = 按内容比例拉伸
    } else if (sumLo <= W) {
      var grow = 0;
      for (var b = 0; b < n; b++)
        grow += hi[b] - lo[b];
      var extra = W - sumLo;
      for (var d = 0; d < n; d++)
        widths[d] = grow > 0
          ? lo[d] + extra * (hi[d] - lo[d]) / grow
          : lo[d] + extra / n;   // 全列都到上限：剩余空间均分
      base = W;
    } else {
      for (var e = 0; e < n; e++)
        widths[e] = lo[e];
      base = sumLo;              // 溢出：保持 min-content 宽，横向滚动
    }
    var out = '<colgroup>';
    for (var f = 0; f < n; f++)
      out += '<col style="width:' + (widths[f] / base * 100).toFixed(2) + '%"/>';
    return { colgroup: out + '</colgroup>', minWidth: sumLo > W ? Math.ceil(sumLo) : 0 };
  }

