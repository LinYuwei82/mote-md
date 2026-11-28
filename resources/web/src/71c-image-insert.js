  // 原生层落盘成功后回调：把 ![](相对路径) 插到光标处。
  // 渲染态直接改 dataset.raw 再整块重排，图片立刻可见；表格/代码块里没有
  // 「行内图片」的位置，改为在其后插入独立段落。源码态插到 textarea 选区。
  function insertImage(rel) {
    var md = '![](' + rel + ')';
    commitHistory();

    if (mode === 'source') {
      var start = sourceEl.selectionStart;
      var end = sourceEl.selectionEnd;
      if (start === null || start === undefined)
        start = end = sourceEl.value.length;
      sourceEl.value = sourceEl.value.slice(0, start) + md + sourceEl.value.slice(end);
      sourceEl.selectionStart = sourceEl.selectionEnd = start + md.length;
      sourceEl.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(commitHistory, 0);
      return;
    }

    var selection = window.getSelection();
    var host = selection && selection.rangeCount ? blockOf(selection.anchorNode) : null;
    var inline = host && host.classList.contains('block') && !host.classList.contains('hr')
      && !host.classList.contains('table') && !isCodeBlock(host);

    if (inline) {
      var offset = host.classList.contains('editing')
        ? Math.min(caretOffset(host), host.textContent.length)
        : host.textContent.length;
      var raw = host.textContent;
      renderBlock(host, raw.slice(0, offset) + md + raw.slice(offset));
      host.classList.add('editing');
      setSelectionRange(host, offset + md.length);
    } else {
      var block = document.createElement('div');
      block.className = 'block';
      block.setAttribute('contenteditable', 'true');
      renderBlock(block, md);
      var anchor = host && host.parentNode === root ? host : root.lastElementChild;
      if (anchor && anchor.parentNode === root)
        root.insertBefore(block, anchor.nextSibling);
      else
        root.appendChild(block);
      block.classList.add('editing');
      block.focus();
      setSelectionRange(block, md.length);
      host = block;
    }
    if (host.scrollIntoView)
      host.scrollIntoView({ block: 'nearest' });
    scheduleDirty();
    scheduleTocRefresh();
    setTimeout(commitHistory, 0);
  }

  /* ---------------- 块变换层（快捷键 / 斜杠菜单 / 右键「转为」共用） ----------------
     三种入口只调用这里的 convertBlocks / toggleInline / insertTemplate，
     不允许各自拼 Markdown 字符串：同一操作无论从哪进来，产物必须逐字相同。 */

