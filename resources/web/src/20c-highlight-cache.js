  var HighlightCache = (function highlightCacheModule() {
  // 返回按行拆好的 HTML 片段；跨行结构（块注释、三引号、模板串）用 carry 状态衔接。
  // 行级缓存：只重扫从第一处改动开始的行；若扫到"最后一处改动"时跨行状态与上次
  // 一致，尾部未改动的行直接复用（输出与整块重扫逐字相同）。el 传 null 表示不缓存。
  function highlightCode(el, raw, lang) {
    var lines = String(raw).split('\n');
    var key = LANG_ALIAS[String(lang || '').trim().toLowerCase()] || '';
    var spec = key ? SPEC[key] : null;
    if (!spec) {
      // 未识别的语言没有跨行状态，逐行转义即可，也不留缓存
      if (el)
        el._codeCache = null;
      return lines.map(Util.escapeHtml);
    }

    var cache = el ? el._codeCache : null;
    var start = 0;
    var lastDiff = lines.length - 1;
    if (cache && cache.lang === key && cache.texts.length === lines.length) {
      while (start < lines.length && cache.texts[start] === lines[start])
        start++;
      if (start === lines.length)
        return cache.html;
      for (var d = lastDiff; d >= start; d--) {
        if (cache.texts[d] !== lines[d]) {
          lastDiff = d;
          break;
        }
      }
    } else {
      cache = { lang: key, texts: [], html: [], states: [] };
    }

    var state = start ? { end: cache.states[start].end, kind: cache.states[start].kind }
      : { end: null, kind: 'c' };
    var next = {
      lang: key,
      texts: cache.texts.slice(0, start),
      html: cache.html.slice(0, start),
      states: cache.states.slice(0, start)
    };
    for (var i = start; i < lines.length; i++) {
      next.texts[i] = lines[i];
      next.states[i] = { end: state.end, kind: state.kind };
      next.html[i] = spec.html ? HighlightScan.scanHtmlLine(lines[i], state) : HighlightScan.scanLine(lines[i], spec, state);
      var after = cache.states[i + 1];
      if (i === lastDiff && after && after.end === state.end && after.kind === state.kind) {
        for (var k = i + 1; k < lines.length; k++) {
          next.texts[k] = cache.texts[k];
          next.states[k] = cache.states[k];
          next.html[k] = cache.html[k];
        }
        break;
      }
    }
    if (el)
      el._codeCache = next;
    return next.html;
  }

  return {
    highlightCode: highlightCode
  };
  })();
