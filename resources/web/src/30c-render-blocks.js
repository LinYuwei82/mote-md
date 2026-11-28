  var RenderBlocks = (function renderBlocksModule() {
  function renderTable(lines, el) {
    var align = TableParse.tableAlignments(lines[1]);
    var head = TableParse.splitTableLine(lines[0]);
    var body = [];
    for (var r = 2; r < lines.length; r++) {
      if (lines[r].trim())
        body.push(lines[r]);
    }
    // 对齐行不参与渲染（display:none，零高度），但原文按 DOM 顺序留在表头与表体
    // 之间，textContent 才能逐字还原 `| a | b |\n|---|...|`。
    var layout = TableParse.tableColgroupHtml(head, body, el ? el.clientWidth : 0);
    var html = '<table class="md-table"'
      + (layout.minWidth ? ' style="min-width:' + layout.minWidth + 'px"' : '')
      + '>' + layout.colgroup + '<thead>'
      + TableParse.tableRowHtml(lines[0], align, 'th', true)
      + '<tr class="tbl-align" aria-hidden="true"><td colspan="' + Math.max(1, head.cells.length) + '">'
      + Util.escapeHtml(lines[1]) + (body.length ? Util.newlineMarker() : '') + '</td></tr>'
      + '</thead><tbody>';
    for (var b = 0; b < body.length; b++)
      html += TableParse.tableRowHtml(body[b], align, 'td', b < body.length - 1);
    return html + '</tbody></table>';
  }

  function tableCellList(el) {
    var out = [];
    var rows = el.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].classList.contains('tbl-align'))
        continue;
      for (var c = 0; c < rows[r].children.length; c++)
        out.push(rows[r].children[c]);
    }
    return out;
  }

  // 最后一格按 Tab 追加一行：否则 Tab 在表格里走到尽头就无路可走，而回车又被
  // 定义为“不改结构”，表格将无法扩行。
  function appendTableRow(el) {
    var body = el.querySelector('tbody');
    var headRow = el.querySelector('thead tr');
    if (!body || !headRow)
      return false;
    var count = headRow.children.length;
    if (!count)
      return false;
    EditingSnapshot.commitHistory();
    // 原来的最后一行没有换行标记（它就是原文最后一行）。追加前先补一个，
    // 否则新行会拼进上一行的 textContent，dataset.raw 里两行会变成同一行。
    var existing = body.children;
    if (existing.length) {
      var lastCell = existing[existing.length - 1].lastElementChild;
      if (lastCell)
        lastCell.insertAdjacentHTML('beforeend', Util.newlineMarker());
    }
    var lines = String(el.dataset.raw || '').split('\n');
    var align = TableParse.tableAlignments(lines[1] || '');
    var line = '|' + new Array(count + 1).join('  |');
    body.insertAdjacentHTML('beforeend', TableParse.tableRowHtml(line, align, 'td', false));
    el.dataset.raw = el.textContent;
    DocumentModel.scheduleDirty();
    EditingSnapshot.scheduleCommit();
    EditingSnapshot.commitHistory();
    return true;
  }

  // 在当前行上方/下方插入一个空行（Cmd+Shift+Enter / Cmd+Enter）。关键是让每行
  // 的换行标记与原文逐字对齐：原文里除末行外每行都以 \n 结尾，所以——
  //   · 插到下方：当前行保留自己的 \n；新行只在成为新末行时不带 \n，否则带。
  //   · 插到上方：新行必带 \n；当前行若原本是末行（原本无 \n）需补一个。
  // 任何一行漏掉 \n，相邻两行就会在 textContent 里粘连，下次重渲染被解析成
  // 同一行（列数翻倍）。光标始终落在新行同列的单元格末尾。
  function insertTableRow(el, below) {
    var cell = CellEdit.activeCell(el);
    if (!cell)
      return false;
    var row = cell.parentNode;
    if (!row || row.tagName !== 'TR' || row.classList.contains('tbl-align'))
      return false;
    var count = el.querySelector('thead tr').children.length;
    if (!count)
      return false;
    var lines = String(el.dataset.raw || '').split('\n');
    var align = TableParse.tableAlignments(lines[1] || '');
    var line = '|' + new Array(count + 1).join('  |');
    EditingSnapshot.commitHistory();
    var newRow = null;
    if (below) {
      // 当前行的换行标记始终保留（它是当前行的行尾）。新行只在"插到末行之后"
      // 时不带换行标记（它成为新末行）；其余情况新行后面还有行，必须带。
      var last = row.lastElementChild;
      var isLast = !(last && last.querySelector(':scope > .mk-nl'));
      if (row.parentNode.tagName === 'THEAD') {
        // 表头行下方同样不可插（新行会夹在表头与对齐行之间，原文第 2 行不再是
        // 对齐行），改为落到对齐行之后、表体首行。
        var tbody = el.querySelector('tbody');
        var hasBody = tbody.children.length > 0;
        tbody.insertAdjacentHTML('afterbegin', TableParse.tableRowHtml(line, align, 'td', hasBody));
        newRow = tbody.firstElementChild;
      } else {
        row.insertAdjacentHTML('afterend', TableParse.tableRowHtml(line, align, 'td', !isLast));
        if (isLast)
          last.insertAdjacentHTML('beforeend', Util.newlineMarker());
        newRow = row.nextElementSibling;
      }
    } else {
      // 新行插到当前行上方，自身必须带换行标记（它后面还有当前行/对齐行）。
      // 当前行若原本是末行（没有换行标记），插入后不再是末行，必须补上，
      // 否则新行会拼进它的 textContent。表头行上方不可插（表头必须与对齐行
      // 相邻），此时新行改落表体首行——同样在表头"之上"，光标也落在那里。
      var had = row.lastElementChild && row.lastElementChild.querySelector(':scope > .mk-nl');
      var inHead = row.parentNode.tagName === 'THEAD';
      if (inHead) {
        var body = el.querySelector('tbody');
        body.insertAdjacentHTML('afterbegin', TableParse.tableRowHtml(line, align, 'td', true));
        newRow = body.firstElementChild;
      } else {
        row.insertAdjacentHTML('beforebegin', TableParse.tableRowHtml(line, align, 'td', true));
        if (!had) {
          var tail = row.lastElementChild;
          if (tail)
            tail.insertAdjacentHTML('beforeend', Util.newlineMarker());
        }
        newRow = row.previousElementSibling;
      }
    }
    el.dataset.raw = el.textContent;
    CaretEdit.caretInCellEnd(newRow.children[Math.min(cell.cellIndex, newRow.children.length - 1)]);
    DocumentModel.scheduleDirty();
    EditingSnapshot.scheduleCommit();
    EditingSnapshot.commitHistory();
    return true;
  }

  function moveTableCell(el, delta) {
    var cells = tableCellList(el);
    if (!cells.length)
      return;
    var index = cells.indexOf(CellEdit.activeCell(el));
    if (index < 0)
      index = 0;
    var next = index + delta;
    if (next < 0)
      next = 0;
    if (next >= cells.length) {
      if (delta > 0 && appendTableRow(el)) {
        cells = tableCellList(el);
        next = index + 1;
      } else {
        next = cells.length - 1;
      }
    }
    CaretEdit.caretInCellEnd(cells[next]);
  }

  // 任务列表项：复选框只是控件，"[ ] " / "[x] " 仍以零宽标记留在 DOM 里，
  // 保证 textContent 与 dataset.raw 逐字相等；控件本身无文本，复制不会带出额外字符。
  function renderListItem(line, lead, index) {
    var rest = line.slice(lead.length);
    var task = /^\[([ xX])\]\s+/.exec(rest);
    var indent = /^\s*/.exec(lead)[0].length;
    // 缩进子项在扁平列表里用左边距表达层级（原文的前导空格仍由标记承载）
    var style = indent ? ' style="margin-left:' + (indent * 0.6) + 'em"' : '';
    var head = (index && INLINE_PROTO ? Util.newlineMarker() : '')
      + (INLINE_PROTO ? Util.marker(lead, 'bullet') : '');
    if (!task)
      return '<li' + style + '>' + head + Util.renderInline(rest) + '</li>';
    return '<li class="task"' + style + '>' + head
      // 任务标记不做成原子对象：编辑态它显示为可见文本，光标可以进入并用键盘
      // 把 [ ] 改成 [x]；渲染态 font-size:0 隐藏，由复选框代替。文字包一层 <i>，
      // 编辑态才能绝对定位压到复选框那块占位上，做到进出编辑态零位移。
      + (INLINE_PROTO ? '<span class="mk mk-task"><i>' + Util.escapeHtml(task[0]) + '</i></span>' : '')
      + '<input type="checkbox" class="task-check" contenteditable="false" tabindex="-1"'
      + (task[1] === ' ' ? '' : ' checked') + '>'
      + Util.renderInline(rest.slice(task[0].length)) + '</li>';
  }

  // 点击复选框：只改写该行的 [ ] / [x]，重新渲染并落一个撤销步。
  // 控件本身不承载文本，dataset.raw 与 textContent 仍由 .mk 标记保持一致。
  function toggleTaskCheckbox(box) {
    var li = box.closest ? box.closest('li') : null;
    var el = li ? CaretCode.blockOf(li) : null;
    if (!li || !el || !el.classList.contains('block'))
      return;
    var lines = rawOf(el).split('\n');
    var index = Array.prototype.indexOf.call(el.querySelectorAll('li'), li);
    if (index < 0 || index >= lines.length)
      return;
    var next = lines[index].replace(/^(\s*[-*+]\s+)\[([ xX])\]/, function (all, lead, mark) {
      return lead + (mark === ' ' ? '[x]' : '[ ]');
    });
    if (next === lines[index])
      return;
    lines[index] = next;
    EditingSnapshot.commitHistory();
    applyRawToBlock(el, lines.join('\n'), undefined, undefined, false);
    setTimeout(EditingSnapshot.commitHistory, 0);
  }

  function renderBlock(el, raw, deferHi) {
    raw = String(raw === undefined || raw === null ? '' : raw);
    var kind = 'p';
    var html = '';

    var fence = raw.match(/^```([^\n`]*)\n?([\s\S]*?)\n?```\s*$/);
    var heading = raw.match(/^(#{1,6})(\s+)(.+)$/);
    var lines = raw.split('\n');

    if (fence) {
      kind = 'code';
      el.dataset.lang = fence[1];
      html = LayoutCode.renderCode(el, fence[2], fence[1], deferHi);
    } else if (heading && lines.length === 1) {
      var level = heading[1].length;
      kind = 'h' + level;
      // 前缀按原文原样折叠（含 # 后的空白），否则 textContent 少一个空格，
      // 离开编辑态时块类型会悄悄变掉
      var prefix = INLINE_PROTO ? Util.marker(heading[1] + heading[2], 'head') : '';
      html = '<h' + level + '>' + prefix + Util.renderInline(heading[3]) + '</h' + level + '>';
    } else if (TableParse.isTableSource(lines)) {
      kind = 'table';
      html = renderTable(lines, el);
    } else if (lines.length && lines.every(function (line) { return /^\s*[-*+]\s+/.test(line); })) {
      kind = 'ul';
      html = '<ul>';
      lines.forEach(function (line, index) {
        var lead = /^\s*[-*+]\s+/.exec(line)[0];
        html += renderListItem(line, lead, index);
      });
      html += '</ul>';
    } else if (lines.length && lines.every(function (line) { return /^\s*\d+[.)]\s+/.test(line); })) {
      kind = 'ol';
      html = '<ol>';
      lines.forEach(function (line, index) {
        var lead = /^\s*\d+[.)]\s+/.exec(line)[0];
        html += renderListItem(line, lead, index);
      });
      html += '</ol>';
    } else if (lines.length && lines.every(function (line) { return /^\s*>/.test(line); })) {
      kind = 'quote';
      html = '<blockquote>';
      lines.forEach(function (line, index) {
        var lead = /^\s*>\s?/.exec(line)[0];
        if (index)
          html += '<br>' + (INLINE_PROTO ? Util.newlineMarker() : '');
        html += (INLINE_PROTO ? Util.marker(lead, 'quote') : '') + Util.renderInline(line.slice(lead.length));
      });
      html += '</blockquote>';
    } else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw.trim())) {
      kind = 'hr';
      html = '<hr>';
    } else {
      html = lines.map(Util.renderInline).join(INLINE_PROTO ? '<br>' + Util.newlineMarker() : '<br>');
    }

    el.dataset.raw = raw;
    el.className = 'block ' + kind;
    el.innerHTML = html || '<br>';
  }

  return {
    tableCellList: tableCellList,
    insertTableRow: insertTableRow,
    moveTableCell: moveTableCell,
    toggleTaskCheckbox: toggleTaskCheckbox,
    renderBlock: renderBlock
  };
  })();
