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

  function scanLine(line, spec, state) {
    var html = '';
    var i = 0;
    var n = line.length;
    var firstNonSpace = 0;
    while (firstNonSpace < n && /\s/.test(line.charAt(firstNonSpace)))
      firstNonSpace++;

    // 上一行未结束的块注释 / 多行字符串
    if (state.end) {
      var close = line.indexOf(state.end);
      if (close < 0)
        return token(line, state.kind);
      html += token(line.slice(0, close + state.end.length), state.kind);
      i = close + state.end.length;
      state.end = null;
    }

    while (i < n) {
      var rest = line.slice(i);
      var ch = line.charAt(i);
      var matched = false;

      for (var c = 0; c < spec.line.length; c++) {
        if (rest.indexOf(spec.line[c]) === 0) {
          html += token(rest, 'c');
          return html;
        }
      }

      if (spec.block && rest.indexOf(spec.block[0]) === 0) {
        var blockEnd = line.indexOf(spec.block[1], i + spec.block[0].length);
        if (blockEnd < 0) {
          html += token(rest, 'c');
          state.end = spec.block[1];
          state.kind = 'c';
          return html;
        }
        html += token(line.slice(i, blockEnd + spec.block[1].length), 'c');
        i = blockEnd + spec.block[1].length;
        continue;
      }

      if (spec.triple) {
        for (var t = 0; t < spec.triple.length; t++) {
          var marker = spec.triple[t];
          if (rest.indexOf(marker) !== 0)
            continue;
          var tripleEnd = line.indexOf(marker, i + marker.length);
          if (tripleEnd < 0) {
            html += token(rest, 's');
            state.end = marker;
            state.kind = 's';
            return html;
          }
          html += token(line.slice(i, tripleEnd + marker.length), 's');
          i = tripleEnd + marker.length;
          matched = true;
          break;
        }
        if (matched)
          continue;
      }

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
        html += token(line.slice(i, Math.min(j, n)), kind);
        i = Math.min(j, n);
        matched = true;
        break;
      }
      if (matched)
        continue;

      if (spec.preproc && ch === '#' && i === firstNonSpace) {
        var directive = /^#\s*[A-Za-z]+/.exec(rest);
        var length = directive ? directive[0].length : 1;
        html += token(line.slice(i, i + length), 'k');
        i += length;
        continue;
      }

      if (spec.dollar && rest.indexOf('${') === 0) {
        var brace = line.indexOf('}', i + 2);
        if (brace > 0) {
          html += token(line.slice(i, brace + 1), 't');
          i = brace + 1;
          continue;
        }
      }

      if (/\d/.test(ch)) {
        var digits = scanNumber(line, i);
        if (digits > 0) {
          html += token(line.slice(i, i + digits), 'n');
          i += digits;
          continue;
        }
      }

      if (isWordStart(ch)) {
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
        html += cls ? token(word, cls) : escapeHtml(word);
        i = after;
        continue;
      }

      html += escapeHtml(ch);
      i++;
    }
    return html;
  }

