  var ClipboardPaste = (function clipboardPasteModule() {
  /* ---------------- 图片：粘贴 / 拖入 ----------------
     页面拿不到文件真实路径（WebKit 安全限制），所以图片一律以 base64 交给原生层，
     由原生写到「md 同目录/assets/」（目录不存在就创建，重名自动加 -2/-3），
     再用 window.mote.insertImage(相对路径) 回调页面插入 ![](…)，
     渲染态当场可见。撤销只撤 Markdown 插入，不删除已落盘的图片文件。 */

  function clipboardImageFile(clipboard) {
    var items = clipboard.items || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
        var file = item.getAsFile();
        if (file)
          return file;
      }
    }
    var files = clipboard.files || [];
    for (var j = 0; j < files.length; j++)
      if (/^image\//i.test(files[j].type || ''))
        return files[j];
    return null;
  }

  function postImageFile(file, source) {
    var reader = new FileReader();
    reader.onload = function () {
      var url = String(reader.result || '');
      var comma = url.indexOf(',');
      if (comma < 0)
        return;
      post({
        type: 'image',
        source: source,
        name: file.name || '',
        mime: file.type || 'image/png',
        data: url.slice(comma + 1)
      });
    };
    reader.readAsDataURL(file);
  }

  // 把一段纯文本插到目标块：语言徽标、表格与代码块各有专门路径，其余按普通
  // 文本插入。原生粘贴事件与外壳剪贴板入口（菜单/快捷键/右键）共用这一实现。
  function insertPastedText(text, el, baselineDone) {
    text = String(text === undefined || text === null ? '' : text);
    // 块外粘贴在补空块之前已经落过撤销基线（baselineDone）：这里若再提交，
    // 会把「只多一个空块」的中间态写进历史，一次 Cmd+Z 就停在空块上。
    if (!baselineDone)
      commitHistory();
    if (el && el.classList.contains('table')) {
      // 单元格是单行结构：整张 Markdown 表格直接替换当前表格；其余多行文本
      // 压成一行插入（换行会被 WebKit 变成 <div>/<br>，把表格结构写坏）。
      var raw = text.replace(/\r\n?/g, '\n');
      var rows = raw.split('\n');
      if (isTableSource(rows)) {
        renderBlock(el, raw.replace(/\n+$/, ''));
        el.classList.add('editing');
        var first = el.querySelector('th, td');
        if (first)
          caretInCellEnd(first);
      } else {
        document.execCommand('insertText', false, raw.replace(/\n+/g, ' '));
        ensureCellCaret(el);
      }
      scheduleDirty();
      scheduleCommit();
      setTimeout(commitHistory, 0);
      return;
    }
    if (el && isCodeBlock(el)) {
      // 代码块直接按字符插入，多行粘贴不会变成 <div>/<br>，结构始终是行文本
      if (!insertCodeText(el, text.replace(/\r\n?/g, '\n')))
        document.execCommand('insertText', false, text);
      scheduleDirty();
      scheduleCommit();
      setTimeout(commitHistory, 0);
      return;
    }
    if (text.indexOf('\n') >= 0) {
      insertMultilinePaste(el, text, baselineDone);
      return;
    }
    document.execCommand('insertText', false, text);
    setTimeout(commitHistory, 0);
  }

  // 多行粘贴：单个换行是块内软换行（与 renderBlock 的 <br> + mk-nl 表示一致），
  // 空行是块分隔。整段交给 execCommand('insertText') 的话，WKWebView 会把换行
  // 变成 <div>，块内 textContent 只剩一段文字，落盘时行与行就粘在一起了。
  function multilinePasteHtml(text) {
    return text.split('\n').map(escapeHtml).join('<br>' + newlineMarker());
  }

  function insertMultilinePaste(el, text, baselineDone) {
    var layout = splitSourceLayout(String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
    var chunks = layout.blocks;
    if (!baselineDone)
      commitHistory();
    document.execCommand('insertHTML', false, multilinePasteHtml(chunks[0]));
    var last = el;
    for (var i = 1; i < chunks.length; i++) {
      var neo = document.createElement('div');
      neo.className = 'block';
      neo.setAttribute('contenteditable', 'true');
      // 粘贴文本里的连续空行原样保留，不压回 2 个换行
      neo.dataset.gap = String(gapBefore(layout.gaps, i));
      root.insertBefore(neo, last.nextSibling);
      renderBlock(neo, '');
      neo.innerHTML = multilinePasteHtml(chunks[i]);
      neo.classList.add('editing');
      last = neo;
    }
    if (last !== el) {
      last.focus();
      setCaret(last, last.textContent.length);
    }
    scheduleDirty();
    scheduleCommit();
    setTimeout(commitHistory, 0);
  }

  // 光标停在块外（#editor 直接子节点之间）时，在光标处补一个空段落块并交还
  // 焦点。块外没有可归属的原文，直接 insertText 会把文本写到 root 层，
  // collectBlocks 序列化时看不到它，等于粘贴后一保存就丢。
  function caretParagraphBlock() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (range.startContainer !== root && !root.contains(range.startContainer))
      return null;
    var neo = document.createElement('div');
    neo.className = 'block';
    neo.setAttribute('contenteditable', 'true');
    range.insertNode(neo);
    renderBlock(neo, '');
    neo.focus();
    setCaret(neo, 0);
    return neo;
  }

  // 点击最后一块下方的空白区时，选区与事件目标都落在 #editor 外（body），
  // 没有可归属的块。这里在文档末尾补一个段落块并聚焦，粘贴内容才有落点。
  function appendParagraphBlock() {
    var neo = document.createElement('div');
    neo.className = 'block';
    neo.setAttribute('contenteditable', 'true');
    root.appendChild(neo);
    renderBlock(neo, '');
    neo.classList.add('editing');
    neo.focus();
    setCaret(neo, 0);
    if (neo.scrollIntoView)
      neo.scrollIntoView({ block: 'nearest' });
    return neo;
  }

  // 粘贴统一转为纯文本，避免把富文本结构带进 Markdown；粘贴整体作为一个撤销步骤。
  // 监听挂在 document 上：块外空白区的 paste 事件目标是 body，挂在 root 上收不到。
  document.addEventListener('paste', function (event) {
    if (mode === 'source')
      return;
    var target = event.target;
    // 页面内的表单控件（查找框、重命名输入等）保留原生粘贴
    if (target && (target.nodeName === 'INPUT' || target.nodeName === 'TEXTAREA'))
      return;
    var clipboard = event.clipboardData || window.clipboardData;
    if (!clipboard)
      return;
    var inRoot = target === root || (root.contains && root.contains(target));
    var picture = clipboardImageFile(clipboard);
    if (picture) {
      event.preventDefault();
      // 不预建空块：落图回调 insertImage 本来就会在文末补块。预建的块在撤销
      // 基线之外，一次 Cmd+Z 会留下一个空块。
      postImageFile(picture, 'paste');
      return;
    }
    event.preventDefault();
    var el = blockOf(target);
    // 跨块选区还在：粘贴等价于「用剪贴板文本替换选区」，仍走整篇源码重建
    if (crossSel) {
      replaceCrossSelection(clipboard.getData('text/plain'));
      return;
    }
    var baselineDone = false;
    if (!el) {
      // 块外粘贴要先补块才有落点。撤销基线必须落在补块之前：否则快照里已经
      // 含这个空块，Cmd+Z 只撤掉文字，空块与落盘空行都会留下。
      commitHistory();
      baselineDone = true;
      el = inRoot ? caretParagraphBlock() : appendParagraphBlock();
    }
    insertPastedText(clipboard.getData('text/plain'), el, baselineDone);
  });

  // 复制时剔除行号栏。CSS 的 user-select:none 只约束真实拖选，
  // 程序化 Range 仍会把 gutter 文本算进选区，这里统一兜底。
  function cleanCopyFragment(fragment) {
    // 视觉换行在纯文本里还原成真正的换行。<br> 与零宽换行标记是同一处换行的
    // 两种表示（标记只负责 textContent），同一位置只保留一个 \n。
    var nls = fragment.querySelectorAll ? fragment.querySelectorAll('.mk-nl') : [];
    for (var n = 0; n < nls.length; n++) {
      var nl = nls[n];
      var prev = nl.previousSibling;
      if (prev && (prev.nodeName === 'BR' || (prev.nodeType === 3 && prev.nodeValue === '\n')))
        nl.parentNode.removeChild(nl);
      else if (nl.parentNode)
        nl.parentNode.replaceChild(document.createTextNode('\n'), nl);
    }
    var brs = fragment.querySelectorAll ? fragment.querySelectorAll('br') : [];
    for (var r = 0; r < brs.length; r++) {
      if (brs[r].parentNode)
        brs[r].parentNode.replaceChild(document.createTextNode('\n'), brs[r]);
    }
    // 行号栏、零宽标记与语言徽标都不属于正文：复制时要剔除。表格例外——表格里
    // 的 |、对齐行与换行就是原文，复制出去必须能原样贴回 Markdown。
    var junk = fragment.querySelectorAll ? fragment.querySelectorAll('.gutter, .mk, .code-tools, .code-lang') : [];
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].closest && junk[i].closest('table'))
        continue;
      // 列表符号（- / 1.）、任务标记（[ ] / [x]）、链接语法（[ / ](url)）与图片
      // 语法（![](src)）都是 Markdown 原文的一部分：复制出去必须仍能原样贴回，
      // 只有行内标记按可见文本剔除。图片标记不保留的话，剪贴板里只剩 <img>，
      // 原文和地址一起消失。行内代码的反引号同理：纯文本里没有它就贴不回代码样式。
      if (junk[i].classList && (junk[i].classList.contains('mk-bullet')
          || junk[i].classList.contains('mk-task')
          || junk[i].classList.contains('mk-link')
          || junk[i].classList.contains('mk-img')
          || junk[i].classList.contains('mk-code')))
        continue;
      junk[i].parentNode.removeChild(junk[i]);
    }
    return fragment.textContent;
  }

  return {
    clipboardImageFile: clipboardImageFile,
    postImageFile: postImageFile,
    insertPastedText: insertPastedText,
    caretParagraphBlock: caretParagraphBlock,
    appendParagraphBlock: appendParagraphBlock,
    cleanCopyFragment: cleanCopyFragment
  };
  })();

  var clipboardImageFile = ClipboardPaste.clipboardImageFile;
  var postImageFile = ClipboardPaste.postImageFile;
  var insertPastedText = ClipboardPaste.insertPastedText;
  var caretParagraphBlock = ClipboardPaste.caretParagraphBlock;
  var appendParagraphBlock = ClipboardPaste.appendParagraphBlock;
  var cleanCopyFragment = ClipboardPaste.cleanCopyFragment;
