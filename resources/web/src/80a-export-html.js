  var ExportHtml = (function exportHtmlModule() {
  /* ---------------- 导出自包含 HTML ---------------- */
  // 页面里已有渲染好的 DOM 与全部样式规则，导出时直接复用：
  // - CSS：把 document.styleSheets 的规则串接起来（其中 @font-face 是 data URI，无外链）
  // - 正文：克隆当前 DOM，去掉零宽标记、把复选框换成静态符号（保留勾选状态）
  // 图片的 base64 由外壳读取磁盘后替换，页面这一侧只保留原始相对路径。
  function exportStylesheet() {
    var css = '';
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules = null;
      try {
        rules = document.styleSheets[i].cssRules || null;
      } catch (e) {
        rules = null;
      }
      if (!rules)
        continue;
      for (var j = 0; j < rules.length; j++)
        css += rules[j].cssText + '\n';
    }
    return css;
  }

  function exportBodyHtml() {
    var body = root.cloneNode(true);
    // 零宽标记（含链接的 [ / ](url)）只服务编辑与 raw 不变量，导出时全部去掉
    var marks = body.querySelectorAll('.mk');
    for (var i = marks.length - 1; i >= 0; i--) {
      if (marks[i].parentNode)
        marks[i].parentNode.removeChild(marks[i]);
    }
    // 行号栏与语言徽标是编辑器外壳，不属于文档内容
    var chrome = body.querySelectorAll('.gutter, .code-tools, .code-lang');
    for (var c = chrome.length - 1; c >= 0; c--) {
      if (chrome[c].parentNode)
        chrome[c].parentNode.removeChild(chrome[c]);
    }
    var boxes = body.querySelectorAll('input.task-check');
    for (var b = 0; b < boxes.length; b++) {
      var box = boxes[b];
      var mark = document.createElement('span');
      mark.className = box.checked ? 'task-check-static checked' : 'task-check-static';
      mark.textContent = box.checked ? '✓' : '';
      mark.setAttribute('contenteditable', 'false');
      mark.setAttribute('aria-hidden', 'true');
      box.parentNode.replaceChild(mark, box);
    }
    var editable = body.querySelectorAll('[contenteditable]');
    for (var k = 0; k < editable.length; k++)
      editable[k].removeAttribute('contenteditable');
    var blocks = body.querySelectorAll('.block');
    for (var m = 0; m < blocks.length; m++) {
      blocks[m].classList.remove('editing', 'selected', 'focus');
      // 块间空行是编辑器内部状态，不写进导出件
      blocks[m].removeAttribute('data-gap');
    }
    // 导出件同样生成标题锚点：文档里的 #标题 链接在导出 HTML 中也能跳
    var seen = {};
    for (var n = 0; n < blocks.length; n++) {
      var heading = blocks[n];
      if (!Toc.headingLevel(heading))
        continue;
      var slug = Toc.headingSlug(heading.dataset.raw || heading.textContent);
      if (!slug)
        continue;
      var count = seen[slug] || 0;
      seen[slug] = count + 1;
      heading.id = count ? slug + '-' + count : slug;
    }
    return body.innerHTML;
  }

  function buildExportHtml(title) {
    var name = String(title || 'Mote 导出')
      .replace(/[<>"&]/g, '')
      .replace(/\s+$/, '');
    // 追加在应用样式之后：把文档容器从应用布局里“解放”出来，并补齐静态复选框样式
    var extra = [
      'html,body{height:auto!important;overflow:auto!important;background:#fff}',
      'body{margin:0;padding:56px 24px 72px;color:var(--text);',
      'font:16px/1.75 -apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif;',
      '-webkit-font-smoothing:antialiased}',
      '#editor{display:block!important;max-width:760px;margin:0 auto;padding:0!important}',
      '.mote-export .block{outline:none!important}',
      '.task-check-static{display:inline-block;width:0.92em;height:0.92em;',
      'margin-right:0.45em;border:1px solid var(--border-hover);border-radius:3px;',
      'vertical-align:-0.08em;font-size:0.78em;line-height:0.95em;text-align:center;',
      'color:#fff;background:transparent}',
      '.task-check-static.checked{background:var(--accent);border-color:var(--accent)}',
      '.mote-img-missing{color:var(--muted-2);font-size:0.9em}'
    ].join('');
    var css = exportStylesheet();
    var head = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>' + name + '</title><style>' + css + extra + '</style>';
    return head + '</head><body><article class="mote-export" id="editor">'
      + exportBodyHtml() + '</article></body></html>';
  }

  // PDF 导出分段用的“安全切点”（文档坐标，CSS px）：按文字行、表格行、
  // 列表项与图片的纵向区间取切点。宿主按这些点分段抓取与切页，避免把一行字
  // 或一张图劈开。切点取两段内容之间的空隙中点；行盒紧挨着（同一段内的换行）
  // 时向下让 2px，因为中文字形（尤其标点）的墨迹会略微溢出 line box，
  // 贴着盒底切会漏出半截。
  // 页面正文高约 757pt（1009 CSS px）；不超过一页的代码块按整体参与切页。
  var kPdfAtomicPage = 1000;
  function pdfSafeCuts(ed) {
    if (!ed)
      return { cuts: [0, 1], bottom: 1 };
    // createPDF 的坐标从文档左上角算起，滚动位置只影响 getBoundingClientRect
    var base = window.pageYOffset || 0;
    var spans = [];
    function addRect(r) {
      if (!r || r.height <= 0 || r.width <= 0)
        return;
      spans.push({ top: r.top + base, bottom: r.bottom + base });
    }
    function inChrome(node) {
      for (var el = node.parentNode; el && el !== ed; el = el.parentNode) {
        if (el.classList && (el.classList.contains('gutter') ||
            el.classList.contains('code-tools') || el.classList.contains('code-lang')))
          return true;
      }
      return false;
    }
    for (var i = 0; i < ed.children.length; i++) {
      var block = ed.children[i];
      if (!block.classList || !block.classList.contains('block'))
        continue;
      // 与 Typora 一致：整个代码块只要不超过一页就整体保留，不从中间切页；
      // 表格仍按行切（Typora 的打印样式只禁止表格行被劈开，整表可以跨页）。
      if (block.classList.contains('code')) {
        var blockRect = block.getBoundingClientRect();
        if (blockRect.height > 0 && blockRect.height <= kPdfAtomicPage) {
          addRect(blockRect);
          continue;
        }
      }
      // 文字行盒：逐个文本节点取 Range 的行矩形；同一行被行内元素切开的片段
      // 纵向互相重叠，后面按重叠合并，相邻两行（首尾相接）保持独立以便切页。
      var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
      var hasText = false;
      var node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !/\S/.test(node.nodeValue) || inChrome(node))
          continue;
        var range = document.createRange();
        range.selectNodeContents(node);
        var rects = range.getClientRects();
        for (var k = 0; k < rects.length; k++) {
          if (rects[k].height <= 0 || rects[k].width <= 0)
            continue;
          hasText = true;
          spans.push({ top: rects[k].top + base, bottom: rects[k].bottom + base });
        }
      }
      // 表格行、列表项、图片自身不能切，取它们的整体矩形
      var inner = block.querySelectorAll('li, tr, img');
      for (var j = 0; j < inner.length; j++)
        addRect(inner[j].getBoundingClientRect());
      // 没有文字也没有上述元素的块（空段、分割线）按整块处理
      if (!hasText && !inner.length)
        addRect(block.getBoundingClientRect());
    }
    spans.sort(function (a, b) { return a.top - b.top; });
    var merged = [];
    for (var n = 0; n < spans.length; n++) {
      var span = spans[n];
      var last = merged.length ? merged[merged.length - 1] : null;
      // 只合并纵向真正重叠的区间（同一行的多个片段、表格单元格与行）；
      // 首尾相接的相邻行不合并，这样才能在行与行之间切页。
      if (last && span.top < last.bottom - 0.5) {
        if (span.bottom > last.bottom)
          last.bottom = span.bottom;
        continue;
      }
      merged.push({ top: span.top, bottom: span.bottom });
    }
    var cuts = [0];
    for (var p = 0; p + 1 < merged.length; p++) {
      // 切在下一段内容的上沿：换页后首行紧贴正文区顶部，不会把块外边距带进新页首
      // （Chromium/Typora 在分页处同样丢弃相邻外边距）。0.5px 回退防止行盒顶边重叠。
      cuts.push(Math.max(merged[p].bottom, merged[p + 1].top - 0.5));
    }
    var bottom = merged.length ? merged[merged.length - 1].bottom + 1 : 1;
    cuts.push(Math.ceil(bottom));
    cuts.sort(function (a, b) { return a - b; });
    var out = [];
    for (var q = 0; q < cuts.length; q++) {
      if (!out.length || cuts[q] - out[out.length - 1] > 0.75)
        out.push(cuts[q]);
    }
    return { cuts: out, bottom: Math.ceil(bottom) };
  }


  // 导出前确认内嵌字体与图片真正可用：图片 complete 只代表下载完成，解码是异步的，
  // createPDF 若在解码前取图会把图片画成空白（位置留着、内容没有）。
  var pdfImagesPreparing = false;
  var pdfImagesPending = 0;
  function pdfPrepareImages() {
    if (pdfImagesPreparing || !document.images)
      return;
    pdfImagesPreparing = true;
    Array.prototype.forEach.call(document.images, function (img) {
      pdfImagesPending++;
      var done = function () { pdfImagesPending--; };
      if (img.decode)
        img.decode().then(done, done);
      else
        done();
    });
  }

  function pdfContentReady() {
    pdfPrepareImages();
    // 导出要求所有 mermaid 块都已画成图（含光标所在块），否则会量到源码块的高度；
    // 库未就绪时 scanMermaid 会触发懒加载并计入 pending，这里统一等它完成
    Mermaid.scanMermaid(true);
    if (mermaidPending > 0)
      return false;
    if (pdfImagesPending > 0)
      return false;
    if (document.fonts && !document.fonts.check('10.33pt "Open Sans"'))
      return false;
    for (var i = 0; i < document.images.length; i++) {
      var img = document.images[i];
      if (!img.complete || img.naturalWidth <= 0)
        return false;
    }
    return true;
  }
  return {
    buildExportHtml: buildExportHtml,
    pdfSafeCuts: pdfSafeCuts,
    pdfContentReady: pdfContentReady
  };
  })();
