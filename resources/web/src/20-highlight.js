  /* ---------------- 代码块语法高亮 ---------------- */

  var LANG_ALIAS = {
    c: 'c', h: 'c', cc: 'c', cpp: 'c', 'c++': 'c', cxx: 'c', hpp: 'c', hh: 'c',
    objc: 'c', 'objective-c': 'c', java: 'c', cs: 'c', csharp: 'c', go: 'c',
    golang: 'c', rust: 'c', rs: 'c', swift: 'c', kotlin: 'c', kt: 'c',
    py: 'python', python: 'python', python3: 'python', py3: 'python',
    js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js',
    mjs: 'js', cjs: 'js', node: 'js',
    json: 'json', json5: 'json', jsonc: 'json',
    sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh',
    'shell-session': 'sh', shellsession: 'sh',
    sql: 'sql', mysql: 'sql', postgresql: 'sql', postgres: 'sql', pgsql: 'sql',
    sqlite: 'sql', plsql: 'sql',
    html: 'html', htm: 'html', xml: 'html', xhtml: 'html', svg: 'html',
    vue: 'html', plist: 'html', xaml: 'html'
  };

  // 语言选择器的候选：每一项都用 LANG_ALIAS 校验，只列出真正有高亮规则的语言，
  // 避免维护一份与高亮器对不上的清单。同一个高亮器下的别名（js/ts/jsx/tsx 等）
  // 仍按各自的显示名列出，选中后写入的也是该别名本身。words 供搜索匹配，
  // 含中文词，例如「脚本」「数据库」「终端」。
  var LANG_PICKS = [
    { name: 'Plain Text', value: '', words: 'plain text plaintext txt 纯文本 无语言 文本' },
    { name: 'JavaScript', value: 'js', words: 'javascript js node 脚本' },
    { name: 'TypeScript', value: 'ts', words: 'typescript ts js' },
    { name: 'JSX', value: 'jsx', words: 'jsx react js' },
    { name: 'TSX', value: 'tsx', words: 'tsx react js' },
    { name: 'Python', value: 'python', words: 'python py python3 脚本' },
    { name: 'Java', value: 'java', words: 'java' },
    { name: 'C', value: 'c', words: 'c' },
    { name: 'C++', value: 'cpp', words: 'c++ cpp cplusplus' },
    { name: 'C#', value: 'cs', words: 'c# csharp cs' },
    { name: 'Go', value: 'go', words: 'go golang' },
    { name: 'Rust', value: 'rust', words: 'rust rs' },
    { name: 'Swift', value: 'swift', words: 'swift' },
    { name: 'Kotlin', value: 'kotlin', words: 'kotlin kt' },
    { name: 'Objective-C', value: 'objc', words: 'objective-c objc' },
    { name: 'JSON', value: 'json', words: 'json' },
    { name: 'Shell', value: 'sh', words: 'shell sh zsh 终端 命令行 脚本' },
    { name: 'Bash', value: 'bash', words: 'bash sh 终端 命令行 脚本' },
    { name: 'SQL', value: 'sql', words: 'sql mysql postgres 数据库' },
    { name: 'HTML', value: 'html', words: 'html 网页' },
    { name: 'XML', value: 'xml', words: 'xml 标记' },
    { name: 'Vue', value: 'vue', words: 'vue 网页' }
  ].filter(function (item) {
    return !item.value || LANG_ALIAS[item.value];
  });

  function wordSet(words) {
    var set = Object.create(null);
    words.split(/\s+/).forEach(function (word) {
      if (word)
        set[word] = true;
    });
    return set;
  }

  var SPEC = {
    c: {
      line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], preproc: true,
      kw: wordSet('alignas alignof and asm break case catch class const constexpr const_cast ' +
        'continue decltype default delete do dynamic_cast else enum explicit export extern false ' +
        'for friend goto if inline mutable namespace new noexcept nullptr operator private ' +
        'protected public register reinterpret_cast return sizeof static static_assert static_cast ' +
        'struct switch template this throw true try typedef typeid typename union using virtual ' +
        'volatile while override final ' +
        'abstract async await boolean byte extends implements import instanceof interface package ' +
        'synchronized throws transient native sealed record var val fun object when data open ' +
        'internal fn impl let mut pub trait crate mod match loop in where dyn unsafe use type ref ' +
        'self readonly partial is params get set yield from as with'),
      types: wordSet('void bool char wchar_t short int long float double signed unsigned auto ' +
        'size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t ' +
        'string wstring vector map set optional variant pair tuple unique_ptr shared_ptr ' +
        'QString QStringList QByteArray QWidget QAction QFile QUrl')
    },
    python: {
      line: ['#'], quotes: ['"', "'"], triple: ['"""', "'''"],
      kw: wordSet('False None True and as assert async await break class continue def del elif ' +
        'else except finally for from global if import in is lambda nonlocal not or pass raise ' +
        'return try while with yield match case'),
      types: wordSet('int float complex str bytes bytearray bool list dict set tuple range object ' +
        'type self cls Exception ValueError TypeError KeyError IndexError RuntimeError super ' +
        'property classmethod staticmethod enumerate zip map filter len sum min max sorted ' +
        'reversed open print isinstance issubclass')
    },
    js: {
      line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], triple: ['`'],
      kw: wordSet('async await break case catch class const continue debugger default delete do ' +
        'else enum export extends finally for from function get if implements import in ' +
        'instanceof interface let new null of private protected public return set static super ' +
        'switch this throw true false try typeof undefined var void while with yield as namespace ' +
        'declare readonly abstract keyof infer satisfies'),
      types: wordSet('string number boolean object any unknown never void symbol bigint String ' +
        'Number Boolean Array Object Promise Map Set JSON Date RegExp Error Symbol Function')
    },
    json: {
      line: [], quotes: ['"'], jsonKeys: true,
      kw: wordSet('true false null'),
      types: wordSet('')
    },
    sh: {
      line: ['#'], quotes: ['"', "'", '`'], dollar: true, shellCommand: true,
      kw: wordSet('if then else elif fi for while until do done in case esac select function ' +
        'time return local export unset readonly declare typeset source alias eval exec exit ' +
        'shift trap set true false'),
      types: wordSet('PATH HOME PWD USER SHELL')
    },
    sql: {
      line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], caseInsensitive: true,
      kw: wordSet('select from where insert into values update set delete create table index ' +
        'view drop alter add column join inner left right outer full cross on as group by order ' +
        'having limit offset union all distinct and or not null is like between exists case when ' +
        'then else end begin commit rollback transaction primary key foreign references default ' +
        'constraint unique check procedure function trigger database use show describe explain ' +
        'asc desc with recursive if while declare cursor'),
      types: wordSet('int integer bigint smallint tinyint decimal numeric float double real char ' +
        'varchar nchar text date time datetime timestamp boolean blob json uuid serial')
    },
    html: { html: true, line: [], quotes: [] }
  };

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
      return lines.map(escapeHtml);
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
      next.html[i] = spec.html ? scanHtmlLine(lines[i], state) : scanLine(lines[i], spec, state);
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

