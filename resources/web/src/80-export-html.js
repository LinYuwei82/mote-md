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
      if (!headingLevel(heading))
        continue;
      var slug = headingSlug(heading.dataset.raw || heading.textContent);
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

  var pdfSavedScrollY = 0;

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
    scanMermaid(true);
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

  // ---- mermaid 代码块 ----
  // Typora 把 ```mermaid 画成图；渲染态与 PDF 导出同样换成图，点图回到源码编辑。
  // 渲染是异步的，pdfContentReady 会等它完成再量高度，避免量到 0 高度。
  var mermaidPending = 0;
  var mermaidSeq = 0;
  var mermaidTimer = null;
  var mermaidReady = !!(window.mermaid && window.mermaid.initialize);
  var mermaidLoading = false;
  var mermaidLoadQueue = [];
  function initMermaid() {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
      fontFamily: '"PingFang SC", "Open Sans", sans-serif',
      themeVariables: { fontSize: '14px' },
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false }
    });
  }
  if (mermaidReady)
    initMermaid();

  // mermaid.min.js（3.3MB）不再内联进页面，壳只把它拷到页面同目录；
  // 文档里真的出现 mermaid 块时才动态加载，省掉每次启动/换页的解析开销。
  function ensureMermaidLoaded() {
    if (mermaidReady || mermaidLoading || !window.MOTE_MERMAID_SRC)
      return;
    mermaidLoading = true;
    var s = document.createElement('script');
    // 相对页面自身目录解析（location.href），不受文档目录 <base> 影响
    s.src = new URL(window.MOTE_MERMAID_SRC, location.href).href;
    var settle = function () {
      mermaidLoading = false;
      var q = mermaidLoadQueue.splice(0);
      for (var i = 0; i < q.length; i++) q[i]();
    };
    s.onload = function () {
      if (window.mermaid && window.mermaid.initialize) {
        mermaidReady = true;
        initMermaid();
      } else {
        window.MOTE_MERMAID_SRC = '';
      }
      settle();
    };
    s.onerror = function () {
      // 缺文件：本次会话不再重试，mermaid 块保持源码显示
      window.MOTE_MERMAID_SRC = '';
      settle();
    };
    document.head.appendChild(s);
  }

  function isMermaidBlock(el) {
    return isCodeBlock(el) && (el.dataset.lang || '').trim().toLowerCase() === 'mermaid';
  }

  function mermaidFigure(el) {
    var pre = el.querySelector('pre.code-block');
    if (!pre)
      return null;
    var fig = pre.querySelector('.mermaid-figure');
    if (fig)
      return fig;
    fig = document.createElement('div');
    fig.className = 'mermaid-figure';
    fig.setAttribute('contenteditable', 'false');
    fig.setAttribute('aria-hidden', 'true');
    // 图不可编辑：点图直接回到源码编辑（enterEdit 会把光标放进 <code>）
    fig.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      enterEdit(el);
    });
    pre.insertBefore(fig, pre.firstChild);
    return fig;
  }

  function renderMermaidBlock(el) {
    var src = codeText(el).trim();
    if (!src) {
      el.classList.remove('has-mermaid');
      return;
    }
    var fig = mermaidFigure(el);
    if (!fig || el._mermaidSig === src)
      return;
    if (el._mermaidBusy)
      return;
    el._mermaidBusy = true;
    mermaidPending++;
    window.mermaid.render('mote-mermaid-' + (++mermaidSeq), src).then(function (out) {
      el._mermaidBusy = false;
      mermaidPending--;
      if (fig.isConnected && out && out.svg) {
        fig.innerHTML = out.svg;
        el._mermaidSig = src;
        el.classList.add('has-mermaid');
      } else {
        el._mermaidSig = src;
        el.classList.remove('has-mermaid');
      }
    }, function () {
      // 语法错误：保留源码块，不显示图
      el._mermaidBusy = false;
      mermaidPending--;
      el._mermaidSig = src;
      el.classList.remove('has-mermaid');
    });
  }

  // force=true 时连正在编辑的块也渲染（导出前用），否则让开光标所在的块
  function scanMermaid(force) {
    var ed = document.getElementById('editor');
    if (!ed || mode === 'source')
      return;
    if (!mermaidReady) {
      if (!window.MOTE_MERMAID_SRC)
        return;
      var probe = ed.querySelectorAll('.block.code');
      var has = false;
      for (var i = 0; i < probe.length; i++) {
        if (isMermaidBlock(probe[i])) {
          has = true;
          break;
        }
      }
      if (!has)
        return;
      // 计入 pending：导出路径会等库加载与渲染都完成
      mermaidPending++;
      mermaidLoadQueue.push(function () {
        mermaidPending--;
        scanMermaid(force);
      });
      ensureMermaidLoaded();
      return;
    }
    var blocks = ed.querySelectorAll('.block.code');
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (isMermaidBlock(el)) {
        if (force || !el.classList.contains('editing'))
          renderMermaidBlock(el);
      } else if (el.classList.contains('has-mermaid')) {
        el.classList.remove('has-mermaid');
        el._mermaidSig = null;
      }
    }
  }

  function scheduleMermaid() {
    if (mermaidTimer)
      return;
    mermaidTimer = setTimeout(function () {
      mermaidTimer = null;
      scanMermaid(false);
    }, 120);
  }

  window.mote = {
    setTheme: setTheme,
    setStatus: setStatus,
    setMarkdown: function (text) {
      var _t0 = window.MOTE_PERF ? performance.now() : 0;
      closeSlash(false);
      closeTurnMenu();
      closeLangMenu();
      closeBlockMenu();
      hideBlockHandle();
      var normalized = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
      var _t1 = window.MOTE_PERF ? performance.now() : 0;

      suppressEvents = true;
      var _t2 = _t1;
      if (mode === 'source') {
        sourceEl.value = normalized;
        trailingNewlines = trailingNewlineCount(normalized);
      } else {
        var layout = splitSourceLayout(normalized);
        _t2 = window.MOTE_PERF ? performance.now() : 0;
        // 整篇载入路径启用延迟高亮；本页首挂跳过滚动条补偿（新页布局本来就对）
        var fresh = pageFresh;
        pageFresh = false;
        mountBlocks(layout.blocks, layout.gaps, layout.trail, true, fresh);
      }
      suppressEvents = false;
      var _t3 = window.MOTE_PERF ? performance.now() : 0;

      // 以规范化后的序列化结果为基准，避免尾部空行造成“一打开就是已修改”
      savedText = currentSource();
      var _t4 = window.MOTE_PERF ? performance.now() : 0;

      // 换文档时历史从当前状态重新开始
      if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
      history = [];
      historyIndex = -1;
      commitHistory();
      window.scrollTo(0, 0);
      refreshToc();
      updatePlaceholder();
      post({ type: 'dirty', value: false });
      postView();
      var _t5 = window.MOTE_PERF ? performance.now() : 0;
      if (window.MOTE_PERF) {
        post({type:'log', message:'PERF setMarkdown norm:' + (_t1-_t0).toFixed(1)
          + ' | split:' + (_t2-_t1).toFixed(1) + ' | mount:' + (_t3-_t2).toFixed(1)
          + ' | serialize:' + (_t4-_t3).toFixed(1) + ' | history+toc:' + (_t5-_t4).toFixed(1)
          + ' | total:' + (_t5-_t0).toFixed(1)});
      }
    },
    // 保存成功后由 Qt 回填基准文本；之后再撤销会重新变成“已修改”，
    // 重做回保存点则圆点消失
    markSaved: function (text) {
      var normalized = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
      savedText = normalized;
      trailingNewlines = trailingNewlineCount(normalized);
      scheduleDirty();
    },
    requestSnapshot: function () {
      post({ type: 'save', text: currentSource() });
    },
    // 原生把图片写进 assets/ 后回调：插入 ![](相对路径)
    insertImage: function (rel) {
      insertImage(String(rel === undefined || rel === null ? '' : rel));
    },
    // 新建空白文档：先关查找（否则高亮区间还指向旧块），目录与缩放回默认，
    // 再整篇清空（mountBlocks 会替换所有旧块），最后把光标放进唯一的空块。
    newDocument: function () {
      if (findBar)
        closeFind();
      if (tocVisible)
        toggleToc();
      closeSlash(false);
      closeTurnMenu();
      closeLangMenu();
      setZoom(1);
      window.mote.setMarkdown('');
      // 目录已关闭时 refreshToc 会早退，旧标题节点仍留在 DOM 里；新建必须清掉
      tocItems = [];
      if (tocList)
        tocList.innerHTML = '';
      if (mode === 'source') {
        sourceEl.focus();
        sourceEl.setSelectionRange(0, 0);
        return;
      }
      var first = root.querySelector('.block');
      if (first) {
        first.focus();
        setSelectionRange(first, 0);
      }
    },
    // 供原生菜单 / 快捷键直接驱动（不依赖页面是否收到 keydown）
    format: function (name) {
      formatAction(String(name === undefined || name === null ? '' : name));
    },
    // 剪贴板：外壳菜单 / 快捷键 / 右键菜单的唯一下发点。平台 WebView 没有
    // 可编程的编辑命令接口（WKWebView 的 copy:/paste: 只存在于菜单响应链，
    // WebView2 只有自带加速键），所以复制/剪切由页面算出纯文本经 clipboardWrite
    // 交给外壳写系统剪贴板；粘贴由外壳读剪贴板后回灌，插入路径与原生粘贴一致。
    clipboardCopy: function (cut) {
      if (mode === 'source')
        return false;
      var text = selectionPlainText();
      // 空段落块会算出 "\n"，纯空白一律按「没有内容」处理：只提示、不写剪贴板。
      // 这里只判断不改写 text，选中含前后空白的真实文本仍按原样复制。
      if (clipboardTextIsBlank(text)) {
        // 宿主（WebView2 加速键）先把按键标成已处理，页面这里再静默返回 false
        // 就成了“按了没反应”。空选区给一条状态栏提示，算出的结果仍是失败。
        post({
          type: 'status',
          message: cut ? '没有可剪切的内容：先选中文字' : '没有可复制的内容：先选中文字'
        });
        return false;
      }
      // html 是新增的可选字段：旧宿主忽略它仍按纯文本写入，新宿主同时写
      // text/html，粘到 Word / 邮件里保留标题、列表、代码块的样子。
      post({ type: 'clipboardWrite', text: text, html: selectionHtml() });
      if (cut) {
        // 跨块选区的原生选区是折叠的，原生 delete 删不掉它，按整篇源码替换
        if (crossSel) {
          replaceCrossSelection('');
          return true;
        }
        commitHistory();
        document.execCommand('delete');
        scheduleDirty();
        scheduleCommit();
        setTimeout(commitHistory, 0);
      }
      return true;
    },
    clipboardPaste: function (text) {
      if (mode === 'source')
        return false;
      text = String(text === undefined || text === null ? '' : text);
      if (!text) {
        post({ type: 'status', message: '剪贴板里没有可粘贴的文本' });
        return false;
      }
      var selection = window.getSelection();
      var node = selection && selection.rangeCount ? selection.anchorNode : null;
      var el = node ? blockOf(node) : null;
      if (el) {
        insertPastedText(text, el);
        return true;
      }
      // 块外空白区：WebView2 下选区在 body（不在 #editor 内），caretParagraphBlock
      // 取不到块，退回文末补一个段落块；两条建块路径共用同一个撤销基线。
      // 基线必须先于建块，否则空块会被算进“粘贴前”的快照，撤销后残留。
      commitHistory();
      var neo = caretParagraphBlock() || appendParagraphBlock();
      if (!neo) {
        post({ type: 'status', message: '粘贴失败：先把光标放到正文里' });
        return false;
      }
      insertPastedText(text, neo, true);
      return true;
    },
    // 右键「转为」/ 工具栏下拉：不做 toggle，已是目标类型保持不动
    convert: function (kind) {
      if (mode === 'source') {
        var sourceType = { paragraph: 'p', h1: 'h1', h2: 'h2', h3: 'h3', ul: 'ul', ol: 'ol', quote: 'quote', codeBlock: 'code' }[kind];
        if (sourceType)
          sourceConvert(sourceType, false);
        return;
      }
      var type = { paragraph: 'p', h1: 'h1', h2: 'h2', h3: 'h3', ul: 'ul', ol: 'ol', quote: 'quote', codeBlock: 'code' }[kind];
      if (type)
        convertBlocks(type, false);
    },
    undo: function () {
      undo();
    },
    redo: function () {
      redo();
    },
    toggleToc: function () {
      toggleToc();
    },
    toggleSource: function () {
      setMode(mode === 'source' ? 'wysiwyg' : 'source');
    },
    zoomBy: function (steps) {
      setZoom(zoomLevel + steps * ZOOM_STEP);
    },
    resetZoom: function () {
      setZoom(1);
    },
    // 诊断/测试用只读状态
    state: function () {
      return {
        mode: mode,
        toc: tocVisible,
        zoom: zoomLevel,
        history: history.length,
        dirty: currentSource() !== savedText,
        source: currentSource()
      };
    },
    focus: function () {
      var first = root.querySelector('.block');
      if (first)
        first.focus();
    },
    // 原生「导出 HTML…」：拼好整篇自包含 HTML 后回传，由 Qt 侧写盘并内嵌图片
    exportHtml: function (title) {
      post({ type: 'export', html: buildExportHtml(title) });
    },
    // PDF 导出：createPDF / PrintToPdf 走屏幕媒体，@media print 不生效，
    // 所以由宿主在导出前加 body.pdf-export（样式里清外壳），导出完成立刻移除。
    // 只动 body 的 class，不碰正文节点，因此不改文档、不进撤销栈、不置脏标记。
    // 字体/图片是否已经可以进入导出：宿主在 pdfBegin 之前轮询，避免量到错的高度
    pdfContentReady: function () {
      return pdfContentReady();
    },
    pdfBegin: function () {
      closeLangMenu();
      pdfSavedScrollY = window.pageYOffset || 0;
      document.body.classList.add('pdf-export');
      var ed = document.getElementById('editor');
      var rect = ed ? ed.getBoundingClientRect() : { width: 0 };
      var geo = pdfSafeCuts(ed);
      return JSON.stringify({
        w: Math.ceil(rect.width || 0),
        h: geo.bottom,
        cuts: geo.cuts
      });
    },
    pdfEnd: function () {
      document.body.classList.remove('pdf-export');
      window.scrollTo(0, pdfSavedScrollY);
    }
  };

  // 导出 PDF 用的 Open Sans 是 base64 内嵌字体，提前请求解码，
  // 避免导出时前几页的拉丁字符因字体未就绪而回退成系统字体。
  if (document.fonts && document.fonts.load) {
    document.fonts.load('400 1em "Open Sans"', 'Aa0');
    document.fonts.load('700 1em "Open Sans"', 'Aa0');
  }

  applyZoom();
  if (INLINE_PROTO)
    document.body.classList.add('inline-proto');
  if (window.MOTE_PERF)
    post({ type: 'log', message: 'PERF page_scripts ' + performance.now().toFixed(1) + 'ms' });
  post({ type: 'ready' });
})();
