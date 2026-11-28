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
