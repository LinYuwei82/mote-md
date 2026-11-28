  var Util = (function utilModule() {
  /* ---------------- 基础工具 ---------------- */

  function post(message) {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mote)
      window.webkit.messageHandlers.mote.postMessage(message);
  }

  // 状态栏移入页面：原生外壳给 body 加 platform-mac 后 #statusbar 才显示，
  // 消息 6 秒后自动清空（与 Qt 版 QStatusBar 的 showMessage 时长一致）。
  var statusTimer = null;
  function setStatus(text) {
    var element = document.getElementById('status-message');
    if (!element)
      return;
    element.textContent = String(text === undefined || text === null ? '' : text);
    if (statusTimer)
      clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      statusTimer = null;
      element.textContent = '';
    }, 6000);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 零前进宽度的标记：文本始终在 DOM 里（参与 textContent/Range 偏移），
  // 但 font-size:0 使其不占版面；淡色提示由绝对定位的 <i> 绘制，同样不占版面。
  function marker(text, kind) {
    // contenteditable=false：让标记成为不可编辑的原子对象。否则 WebKit 会把
    // 光标停进标记文本里（视觉上跑到行上方的小标签处），方向键/退格也会踩到它。
    // 必须转义：链接地址里可能出现 & / " / <。
    return '<span class="mk mk-' + kind + '" contenteditable="false"><i>' + escapeHtml(text) + '</i></span>';
  }

  // 零前进宽度的换行：\n 必须留在文本节点里（textContent 要能逐字还原原文），
  // 视觉换行由 <br> 或块级 li 提供，所以用 white-space:normal 把这个 \n 吃掉。
  function newlineMarker() {
    return '<span class="mk mk-nl" contenteditable="false">\n</span>';
  }

  function runLength(text, at, ch) {
    var end = at;
    while (end < text.length && text.charAt(end) === ch)
      end++;
    return end - at;
  }

  // 找与 fence 等长的反引号串（行内代码的闭合）；返回起点下标，找不到为 -1。
  function codeClose(text, from, fence) {
    var i = from;
    while (i < text.length) {
      if (text.charAt(i) !== '`') {
        i++;
        continue;
      }
      var run = runLength(text, i, '`');
      if (run === fence)
        return i;
      i += run;
    }
    return -1;
  }

  // 从 start 处的 use 个星号开始，返回配对闭合串的末尾下标，找不到为 -1。
  // 关键点：这里在“连续星号串”层面配对，而不是用一条正则交替匹配，
  // 因此 **a*b*c**、*a**b**c*、***a*** 这类嵌套才能正确落位。
  function findEmphasisClose(text, start, use, depth) {
    var openEnd = start + use;
    var after = text.charAt(openEnd);
    if (after === '' || /\s/.test(after))
      return -1;                          // 星号后面是空白：不是开标记
    var j = openEnd;
    while (j < text.length) {
      var ch = text.charAt(j);
      if (ch === '`') {                   // 行内代码里的星号不参与强调配对
        var fence = runLength(text, j, '`');
        var codeEnd = codeClose(text, j + fence, fence);
        j = codeEnd < 0 ? j + fence : codeEnd + fence;
        continue;
      }
      if (ch !== '*') {
        j++;
        continue;
      }
      var len = runLength(text, j, '*');
      if (/\s/.test(text.charAt(j - 1))) {  // 前面是空白：不能闭合
        j += len;
        continue;
      }
      if (len === use)
        return j + use;
      if (len > use) {
        // 更长的串可能自己成对（*a**b**c* 里的 **b**），成功就整段跳过
        var longer = depth < 8 ? findEmphasisClose(text, j, Math.min(len, 3), depth + 1) : -1;
        if (longer > 0) {
          j = longer;
          continue;
        }
        return j + use;                   // 自身不成对，就取其中 use 个作闭合
      }
      // 更短的串可能是内部嵌套（**a*b*c** 里的 *b*），自身成对则跳过
      var shorter = depth < 8 ? findEmphasisClose(text, j, len, depth + 1) : -1;
      if (shorter > 0) {
        j = shorter;
        continue;
      }
      j += len;
    }
    return -1;
  }

  function emphasisHtml(text, start, depth) {
    var len = runLength(text, start, '*');
    var candidates = len >= 3 ? [3, 2] : (len === 2 ? [2] : [1]);
    for (var c = 0; c < candidates.length; c++) {
      var use = candidates[c];
      var end = findEmphasisClose(text, start, use, 0);
      if (end < 0)
        continue;
      var open = new Array(use + 1).join('*');
      var kind = use === 1 ? 'em' : 'strong';
      var body;
      if (use === 3)
        body = '<strong><em>' + inlineHtml(text.slice(start + 3, end - 3), depth + 1) + '</em></strong>';
      else if (use === 2)
        body = '<strong>' + inlineHtml(text.slice(start + 2, end - 2), depth + 1) + '</strong>';
      else
        body = '<em>' + inlineHtml(text.slice(start + 1, end - 1), depth + 1) + '</em>';
      return { html: marker(open, kind) + body + marker(open, kind), end: end };
    }
    if (len >= 3) {   // ***x* / ***x** 这类退化：剩余星号按普通排版处理
      var em = findEmphasisClose(text, start, 1, 0);
      if (em > 0)
        return {
          html: marker('*', 'em') + '<em>' + inlineHtml(text.slice(start + 1, em - 1), depth + 1) + '</em>'
            + marker('*', 'em'),
          end: em
        };
    }
    return null;
  }

  // 行内渲染：代码 > 图片 > 链接 > 强调。无论怎么嵌套，输出的 textContent
  // 必须与输入逐字相同——切块、保存、撤销都直接依赖这一点。
  function inlineHtml(text, depth) {
    var out = '';
    var i = 0;
    var n = text.length;
    while (i < n) {
      var ch = text.charAt(i);

      if (ch === '`') {
        var fence = runLength(text, i, '`');
        var close = codeClose(text, i + fence, fence);
        var fenceText = text.substr(i, fence);
        if (close >= 0) {
          out += marker(fenceText, 'code')
            + '<code>' + escapeHtml(text.slice(i + fence, close).replace(/\n/g, ' ')) + '</code>'
            + marker(fenceText, 'code');
          i = close + fence;
        } else {
          out += escapeHtml(fenceText);
          i += fence;
        }
        continue;
      }

      if (ch === '[' && depth < 6) {
        var link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(i));
        if (link) {
          // 可见文字包在 <a> 里（只影响颜色/下划线，不改变字宽，零位移不受影响）；
          // `[` 与 `](url)` 仍是零宽标记，textContent 与原文逐字相同。
          out += marker('[', 'link')
            + '<a class="md-link" href="' + escapeHtml(link[2]) + '" data-href="'
            + escapeHtml(link[2]) + '">' + inlineHtml(link[1], depth + 1) + '</a>'
            + marker('](' + link[2] + ')', 'link');
          i += link[0].length;
          continue;
        }
      }

      if (ch === '!' && text.charAt(i + 1) === '[') {
        var image = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i));
        if (image) {
          // 图片本身没有文本内容，原文整段留在零宽标记里，textContent 才不丢字符
          out += marker(image[0], 'img')
            + '<img alt="' + escapeHtml(image[1]) + '" src="' + escapeHtml(image[2]) + '">';
          i += image[0].length;
          continue;
        }
      }

      if (ch === '*') {
        var em = emphasisHtml(text, i, depth);
        if (em) {
          out += em.html;
          i = em.end;
          continue;
        }
        var stars = runLength(text, i, '*');
        out += escapeHtml(text.substr(i, stars));
        i += stars;
        continue;
      }

      var stop = i + 1;
      while (stop < n) {
        var next = text.charAt(stop);
        if (next === '`' || next === '*' || next === '[')
          break;
        if (next === '!' && text.charAt(stop + 1) === '[')
          break;
        stop++;
      }
      out += escapeHtml(text.slice(i, stop));
      i = stop;
    }
    return out;
  }

  function renderInline(text) {
    text = String(text === undefined || text === null ? '' : text);
    if (Config.INLINE_PROTO)
      return inlineHtml(text, 0);
    // 回退路径：旧的整块替换渲染，保持原样以便对照/应急
    var out = escapeHtml(text);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  return {
    post: post,
    setStatus: setStatus,
    escapeHtml: escapeHtml,
    marker: marker,
    newlineMarker: newlineMarker,
    inlineHtml: inlineHtml,
    renderInline: renderInline
  };
  })();
