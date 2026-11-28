  function token(text, kind) {
    return '<span class="tok-' + kind + '">' + escapeHtml(text) + '</span>';
  }

  function scanNumber(line, i) {
    var match = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[fFuUlL]*/
      .exec(line.slice(i));
    return match ? match[0].length : 0;
  }

  function isWordStart(ch) {
    return /[A-Za-z_$]/.test(ch);
  }

  function scanHtmlLine(line, state) {
    var html = '';
    var i = 0;
    var n = line.length;

    if (state.end === '-->') {
      var close = line.indexOf('-->');
      if (close < 0)
        return token(line, 'c');
      html += token(line.slice(0, close + 3), 'c');
      i = close + 3;
      state.end = null;
    }

    while (i < n) {
      if (line.indexOf('<!--', i) === i) {
        var end = line.indexOf('-->', i + 4);
        if (end < 0) {
          html += token(line.slice(i), 'c');
          state.end = '-->';
          return html;
        }
        html += token(line.slice(i, end + 3), 'c');
        i = end + 3;
        continue;
      }
      if (line.charAt(i) === '<') {
        var stop = line.indexOf('>', i);
        var segment = stop < 0 ? line.slice(i) : line.slice(i, stop + 1);
        var tag = /^<\/?[A-Za-z0-9:_-]+/.exec(segment);
        if (tag)
          html += token(tag[0], 'k') + escapeHtml(segment.slice(tag[0].length));
        else
          html += escapeHtml(segment);
        i = stop < 0 ? n : stop + 1;
        continue;
      }
      html += escapeHtml(line.charAt(i));
      i++;
    }
    return html;
  }

  // 扫描步骤的统一返回：null 表示当前位置不匹配，交由下一个步骤尝试；
  // 否则返回 { html, i, done }，done 为真表示本行扫描立即结束。
  function scanCarry(line, state) {
    var step = { html: '', i: 0, done: false };
    // 上一行未结束的块注释 / 多行字符串
    if (!state.end)
      return step;
    var close = line.indexOf(state.end);
    if (close < 0) {
      step.html = token(line, state.kind);
      step.done = true;
      return step;
    }
    step.html = token(line.slice(0, close + state.end.length), state.kind);
    step.i = close + state.end.length;
    state.end = null;
    return step;
  }

  function scanLineComment(rest, spec) {
    for (var c = 0; c < spec.line.length; c++) {
      if (rest.indexOf(spec.line[c]) === 0)
        return { html: token(rest, 'c'), i: 0, done: true };
    }
    return null;
  }

  function scanBlockComment(line, i, rest, spec, state) {
    if (!spec.block || rest.indexOf(spec.block[0]) !== 0)
      return null;
    var start = spec.block[0].length;
    var stop = spec.block[1].length;
    var close = line.indexOf(spec.block[1], i + start);
    if (close < 0) {
      state.end = spec.block[1];
      state.kind = 'c';
      return { html: token(rest, 'c'), i: 0, done: true };
    }
    var end = close + stop;
    return { html: token(line.slice(i, end), 'c'), i: end, done: false };
  }

  function scanTripleString(line, i, rest, spec, state) {
    if (!spec.triple)
      return null;
    for (var t = 0; t < spec.triple.length; t++) {
      var marker = spec.triple[t];
      if (rest.indexOf(marker) !== 0)
        continue;
      var close = line.indexOf(marker, i + marker.length);
      if (close < 0) {
        state.end = marker;
        state.kind = 's';
        return { html: token(rest, 's'), i: 0, done: true };
      }
      var end = close + marker.length;
      return { html: token(line.slice(i, end), 's'), i: end, done: false };
    }
    return null;
  }

  function scanQuotedString(line, i, n, rest, spec) {
    for (var q = 0; q < spec.quotes.length; q++) {
      var quote = spec.quotes[q];
      if (rest.charAt(0) !== quote)
        continue;
      var j = i + 1;
      var escaped = false;
      while (j < n) {
        var current = line.charAt(j);
        if (escaped)
          escaped = false;
        else if (current === '\\')
          escaped = true;
        else if (current === quote) {
          j++;
          break;
        }
        j++;
      }
      var kind = 's';
      if (spec.jsonKeys) {
        var k = j;
        while (k < n && /\s/.test(line.charAt(k)))
          k++;
        if (line.charAt(k) === ':')
          kind = 't';
      }
      var end = Math.min(j, n);
      return { html: token(line.slice(i, end), kind), i: end, done: false };
    }
    return null;
  }

  function scanPreproc(line, i, rest, spec, firstNonSpace) {
    if (!spec.preproc || line.charAt(i) !== '#' || i !== firstNonSpace)
      return null;
    var directive = /^#\s*[A-Za-z]+/.exec(rest);
    var length = directive ? directive[0].length : 1;
    return { html: token(line.slice(i, i + length), 'k'), i: i + length, done: false };
  }

  function scanDollarTemplate(line, i, rest, spec) {
    if (!spec.dollar || rest.indexOf('${') !== 0)
      return null;
    var brace = line.indexOf('}', i + 2);
    if (brace <= 0)
      return null;
    return { html: token(line.slice(i, brace + 1), 't'), i: brace + 1, done: false };
  }

  function scanNumberToken(line, i) {
    if (!/\d/.test(line.charAt(i)))
      return null;
    var digits = scanNumber(line, i);
    if (digits <= 0)
      return null;
    return { html: token(line.slice(i, i + digits), 'n'), i: i + digits, done: false };
  }

  function scanWordToken(line, i, n, rest, spec, firstNonSpace) {
    if (!isWordStart(line.charAt(i)))
      return null;
    var word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)[0];
    var key = spec.caseInsensitive ? word.toLowerCase() : word;
    var after = i + word.length;
    var look = after;
    while (look < n && line.charAt(look) === ' ')
      look++;
    var next = line.charAt(look);
    var cls = '';
    if (spec.kw[key])
      cls = 'k';
    else if (spec.types && spec.types[key])
      cls = 't';
    else if (next === '(')
      cls = 'f';
    else if (spec.shellCommand && i === firstNonSpace)
      cls = 'f';
    return { html: cls ? token(word, cls) : escapeHtml(word), i: after, done: false };
  }

  function scanLine(line, spec, state) {
    var html = '';
    var n = line.length;
    var firstNonSpace = 0;
    while (firstNonSpace < n && /\s/.test(line.charAt(firstNonSpace)))
      firstNonSpace++;

    var carry = scanCarry(line, state);
    if (carry.done)
      return carry.html;
    html += carry.html;
    var i = carry.i;

    while (i < n) {
      var rest = line.slice(i);
      var step =
        scanLineComment(rest, spec) ||
        scanBlockComment(line, i, rest, spec, state) ||
        scanTripleString(line, i, rest, spec, state) ||
        scanQuotedString(line, i, n, rest, spec) ||
        scanPreproc(line, i, rest, spec, firstNonSpace) ||
        scanDollarTemplate(line, i, rest, spec) ||
        scanNumberToken(line, i) ||
        scanWordToken(line, i, n, rest, spec, firstNonSpace);
      if (!step) {
        html += escapeHtml(line.charAt(i));
        i++;
        continue;
      }
      html += step.html;
      if (step.done)
        return html;
      i = step.i;
    }
    return html;
  }

