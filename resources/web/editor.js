(function () {
  'use strict';

  var root = document.getElementById('editor');
  var sourceEl = document.getElementById('source');
  var tocList = document.getElementById('toc-list');

  var savedText = '';           // 最近一次载入或保存落盘时的源文本
  var trailingNewlines = 0;     // 文末空行数量；改动前只记「有没有」，会归并成 1 个
  var composing = false;
  var dirtyTimer = null;
  var pendingOffset = null;

  // 行内标记（阶段一）：默认开启——标记文本常驻 DOM、零宽折叠，进入某行不再
  // 整块替换成 Markdown 原文，因而不产生重排。MOTE_INLINE_PROTO=0/false/off
  // 时由 Qt 注入 false，回退到旧的「整块替换」行为，作为应急路径保留。
  var INLINE_PROTO = window.MOTE_INLINE_PROTO !== false;

  var mode = 'wysiwyg';         // 'wysiwyg' | 'source'
  var zoomLevel = 1;            // 1 = 100%，基准 16.5px（≈ 旧版 16.5pt）
  var ZOOM_MIN = 0.6;
  var ZOOM_MAX = 2.6;
  var ZOOM_STEP = 0.1;

  // 自建撤销栈：整篇快照（块数组或纯文本）+ 绝对字符选区。contenteditable 的
  // 原生撤销只在单块未被重建时有效，跨块操作（回车分块、退格合并、撤销后整篇
  // 重建）会失效，因此统一由这里接管 Cmd+Z / Cmd+Shift+Z。
  var history = [];
  var historyIndex = -1;
  var commitTimer = null;
  var suppressEvents = false;   // 程序化重建 DOM 期间屏蔽 input/focus 等事件
  var commitBatch = 0;          // >0 时合并中间渲染，多块转换只记一个撤销步
  var COALESCE_MS = 600;        // 连续输入的合并窗口
  // 历史步数上限：整篇快照虽然只共享未改动块的字符串，但步数不封顶时块数组
  // 会随编辑时长无限堆积（4500 块 / 170KB 文档尤为明显），超出丢最旧的。
  var MAX_HISTORY = 100;

  var tocVisible = false;
  var tocItems = [];
  var tocTimer = null;
  // 目录项的文档纵坐标缓存：滚动高亮改二分查表，不再每次滚动对每个标题
  // 调 getBoundingClientRect（900 个标题时每帧 900 次布局读取）。
  var tocTops = null;
  // 标题集合的签名：正文段落增删不应导致目录整天重建。
  var tocSig = null;
  var spyScheduled = false;

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
    if (INLINE_PROTO)
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

  /* ---------------- Markdown 渲染 ---------------- */

  // 按空行切块，同时记录块间空行：改动前只取块文本，连续多个空行会被归并成
  // 固定的 2 个换行。gaps[i] 是第 i 块之前的换行数（gaps[0] 即文首空行），
  // trail 是最后一块之后的换行数；围栏代码块内部的空行不切块也不计入间隔。
  function splitSourceLayout(text) {
    var source = String(text).replace(/\r\n?/g, '\n');
    var lines = source.split('\n');
    var blocks = [];
    var gaps = [];
    var current = [];
    var pending = 0;      // 刚才跨过的空行数，等下一块出现时归到它的间隔里
    var inFence = false;
    var started = false;

    function flush() {
      if (!current.length)
        return;
      // 内容之间：k 个空行对应 k+1 个换行；文首没有前一块，空行数就是换行数
      gaps.push(started ? pending + 1 : pending);
      blocks.push(current.join('\n'));
      current = [];
      pending = 0;
      started = true;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*```/.test(line))
        inFence = !inFence;
      if (!inFence && line.trim() === '') {
        flush();
        pending++;
        continue;
      }
      current.push(line);
    }
    flush();

    var trail = pending;
    if (!blocks.length) {
      // 整篇没有正文：保留一个空块，换行全部算文末（lines.length - 1 才是
      // 真实的换行数，末尾 split 出的空串不算一个换行）
      blocks.push('');
      gaps.push(0);
      trail = Math.max(0, lines.length - 1);
    }
    return { blocks: blocks, gaps: gaps, trail: trail };
  }

  function trailingNewlineCount(text) {
    var match = /(\n*)$/.exec(String(text));
    return match ? match[1].length : 0;
  }

  function isCodeBlock(el) {
    return !!(el && el.classList && el.classList.contains('code'));
  }

  function codeEl(el) {
    return el ? el.querySelector('code') : null;
  }

  function codeText(el) {
    var code = codeEl(el);
    return code ? code.textContent : '';
  }

  // 代码块原文 = 围栏 + 正文。围栏不进 DOM（连零宽标记也不需要），正文与语言
  // 分别存在 <code> 文本和 dataset.lang 里，编辑过程中逐次重新拼接。
  function codeRaw(el, text) {
    var lang = el.dataset.lang || '';
    text = text === undefined ? codeText(el) : String(text);
    return '```' + lang + '\n' + text + (text ? '\n```' : '```');
  }

  // dataset.raw 中正文的起始下标（"```lang\n" 的长度），用于整篇偏移 ↔ 块内偏移
  function codePrefixLength(el) {
    var match = /^```[^\n]*\n?/.exec(el.dataset.raw || '');
    return match ? match[0].length : 0;
  }

  function updateGutter(el, text) {
    var gutter = el.querySelector('.gutter');
    if (!gutter)
      return;
    var value = String(text === undefined ? codeText(el) : text);
    var count = 1;
    for (var i = value.indexOf('\n'); i >= 0; i = value.indexOf('\n', i + 1))
      count++;
    // 行号只跟行数有关：行数不变就连 DOM 都不碰（读 innerHTML 本身要整段序列化）
    if (gutter._count === count)
      return;
    var html = '';
    for (var n = 0; n < count; n++)
      html += (n ? '<br>' : '') + (n + 1);
    gutter.innerHTML = html;
    gutter._count = count;
  }

  // 行号栏是「1<br>2<br>3」结构，每个文本节点恰好是一行。点行号时按纵向命中
  // 判断点了第几行：横向命中点（框右侧 +2）在长行时会落到 <code> 外面，取不到
  // 代码里的偏移，只能退化成块首。
  function gutterLineAt(gutter, y) {
    var line = -1;
    var best = Infinity;
    var index = -1;
    for (var node = gutter.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 3)
        continue;
      index++;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rect = range.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom)
        return index;
      var distance = y < rect.top ? rect.top - y : y - rect.bottom;
      if (distance < best) {
        best = distance;
        line = index;
      }
    }
    return line < 0 ? 0 : line;
  }

  // 第 line 行（0 起）在 <code> 文本里的起始下标
  function codeLineStart(code, line) {
    var text = code.textContent;
    var offset = 0;
    for (var i = 0; i < line; i++) {
      var next = text.indexOf('\n', offset);
      if (next < 0)
        return text.length;
      offset = next + 1;
    }
    return offset;
  }

  // 代码块右上角浮层的两个图标：与页面同用线性描边 + currentColor，
  // 复制按钮平时半透明，hover 才显形；成功后短暂换成对勾。
  var COPY_ICON = '<svg class="i-copy" viewBox="0 0 16 16" width="12" height="12"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">'
    + '<rect x="5.4" y="5.4" width="7.8" height="7.8" rx="1.6"></rect>'
    + '<path d="M10.6 5.4V4.2A1.8 1.8 0 0 0 8.8 2.4H4.2A1.8 1.8 0 0 0 2.4 4.2v4.6'
    + 'a1.8 1.8 0 0 0 1.8 1.8h1.2"></path></svg>';
  var DONE_ICON = '<svg class="i-done" viewBox="0 0 16 16" width="12" height="12"'
    + ' fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">'
    + '<path d="M3.2 8.6l3 3 6.6-6.8"></path></svg>';

  function renderCode(el, code, lang) {
    // 结尾的 \n 属于正文（末行之后的空行），不能再剥掉，否则编辑-重排往返会
    // 悄悄少一行；围栏前那个 \n 已由 renderBlock 的匹配式吃掉。
    var lines = String(code).split('\n');
    var colored = highlightCode(el, lines.join('\n'), lang);
    var gutter = '';
    for (var i = 0; i < lines.length; i++)
      gutter += (i ? '<br>' : '') + (i + 1);
    // 行号是独立的一栏（contenteditable=false + user-select:none），它在滚动容器
    // 之外：横向滚动只作用于代码，行号与分隔线始终留在左侧。不用 position:sticky
    // ——sticky 与横向滚动条共存时，WebKit 在整篇重建后会把块高少算一个滚动条。
    //
    // 代码块顶部头栏（.code-tools）在代码块内部：语言徽标靠左，复制按钮绝对定位
    // 在代码块内部右上角。头栏是独立一行，横向滚动只发生在下方 .code-scroll 里，
    // 按钮不会跟着滚走；语言名过长时徽标自身截断（max-width），按钮固定在右上角。
    // 徽标可点开语言选择器，紧跟的空 span 是纯 CSS 画的展开箭头（无文本，
    // 不进 textContent/剪贴板），打开时由 aria-expanded 触发旋转。
    // 按钮在渲染态即可点，不必先进入编辑。
    // 文本不进 <code>、也不进 dataset.raw 的正文部分——原文首行围栏由 dataset.lang 拼回。
    return '<pre class="code-block">'
      + '<div class="code-tools" contenteditable="false">'
      + '<span class="code-lang" contenteditable="false" spellcheck="false"'
      + ' role="button" aria-haspopup="listbox" aria-expanded="false"'
      + (lang ? ' title="' + escapeHtml(lang) + '"' : '')
      + ' aria-label="代码语言">' + escapeHtml(lang || '') + '</span>'
      + '<span class="code-lang-caret" aria-hidden="true"></span>'
      + '<button type="button" class="code-copy" tabindex="-1"'
      + ' aria-label="复制代码" title="复制代码">' + COPY_ICON + DONE_ICON + '</button>'
      + '</div>'
      + '<div class="gutter" contenteditable="false" aria-hidden="true">' + gutter + '</div>'
      + '<div class="code-scroll"><code>' + colored.join('\n') + '</code></div></pre>';
  }

  // 代码块复制按钮：只写 <code> 里的正文（行号栏、语言徽标都不在 <code> 内），
  // 多行与制表符原样保留。走与复制/剪切同一条 clipboardWrite 回路，不另造剪贴板
  // 逻辑；成功只在按钮上做短暂反馈，不弹对话框，也不进入编辑态、不动撤销栈。
  function copyCodeBlock(btn) {
    var block = btn && btn.closest ? btn.closest('.block.code') : null;
    if (!block)
      return;
    post({ type: 'clipboardWrite', text: codeText(block) });
    btn.classList.add('copied');
    if (btn._copiedTimer)
      clearTimeout(btn._copiedTimer);
    btn._copiedTimer = setTimeout(function () {
      btn.classList.remove('copied');
      btn._copiedTimer = null;
    }, 1200);
  }

  // WebKit 在整篇重建（撤销/重做、预览↔源码）后，不会把横向滚动条的高度算进
  // .code-scroll 的 border box，块高会比初次渲染少一个滚动条（本机实测 15px）。
  // 关键是要动 overflow-y：横向滚动条是画在纵轴这块空间里的，只改 overflow-x
  // 不会让 WebKit 重新计算滚动条占位；改成 auto 再还原即可触发一次正确布局。
  function normalizeCodeScrolls(scope) {
    var list = (scope || root).querySelectorAll('.code-scroll');
    for (var i = 0; i < list.length; i++) {
      var sc = list[i];
      var value = sc.style.overflowY;
      sc.style.overflowY = 'auto';
      void sc.offsetHeight;
      sc.style.overflowY = value;
    }
  }

  // 未转义 | 的下标。逐字符扫描而不是用正则后行断言：后者在 WebKit 16.4 之前
  // 是解析期语法错误，整份脚本都会加载失败。
  function pipeIndexes(line) {
    var out = [];
    for (var i = 0; i < line.length; i++) {
      // 前面是反斜杠的 \| 是单元格内容（Markdown 转义），不是列分隔符
      if (line.charAt(i) === '|' && line.charAt(i - 1) !== '\\')
        out.push(i);
    }
    return out;
  }

  // 按未转义的 | 切分，转义的 \| 原样留在片段里。
  function splitPipes(text) {
    var pipes = pipeIndexes(text);
    var out = [];
    var from = 0;
    for (var p = 0; p < pipes.length; p++) {
      out.push(text.slice(from, pipes[p]));
      from = pipes[p] + 1;
    }
    out.push(text.slice(from));
    return out;
  }

  function tableCells(line) {
    var trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    // 转义的 \| 不是分隔符；切分后再把单元格里的 \| 还原成 |
    return splitPipes(trimmed).map(function (cell) {
      return cell.trim().replace(/\\\|/g, '|');
    });
  }

  function isTableSource(lines) {
    return lines.length >= 2 && lines[0].indexOf('|') >= 0
      && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1]) && lines[1].indexOf('-') >= 0;
  }

  // 表格行拆成「前导边框 + 单元格 + 分隔符 + 尾随空白」，满足
  // lead + Σ(text + sep) + tail === line。单元格被就地编辑后仍能拼回逐字原文，
  // 不依赖 textContent 已丢失的 | 与对齐行。
  function splitTableLine(line) {
    var pipes = pipeIndexes(line);
    if (!pipes.length)
      return { lead: '', cells: [{ text: line, sep: '' }], tail: '' };

    var lead = '';
    var cellStart = 0;
    var seps = pipes.slice();
    if (line.slice(0, pipes[0]).trim() === '') {   // 起始竖线是边框
      lead = line.slice(0, pipes[0] + 1);
      cellStart = pipes[0] + 1;
      seps = seps.slice(1);
    }
    var trail = -1;
    if (seps.length && line.slice(pipes[pipes.length - 1] + 1).trim() === '')
      trail = pipes[pipes.length - 1];              // 末尾竖线是边框

    var cells = [];
    var from = cellStart;
    for (var s = 0; s < seps.length; s++) {
      if (seps[s] === trail)
        break;
      cells.push({ text: line.slice(from, seps[s]), sep: '|' });
      from = seps[s] + 1;
    }
    var end = trail >= 0 ? trail : line.length;
    cells.push({ text: line.slice(from, end), sep: trail >= 0 ? '|' : '' });
    return { lead: lead, cells: cells, tail: trail >= 0 ? line.slice(trail + 1) : '' };
  }

  function tableAlignments(line) {
    return tableCells(line).map(function (cell) {
      var left = cell.charAt(0) === ':';
      var right = cell.charAt(cell.length - 1) === ':';
      return left && right ? 'center' : (right ? 'right' : (left ? 'left' : ''));
    });
  }

  // 表格里的 | / 对齐行 / 换行都是零宽标记：参与 textContent（dataset.raw 靠它
  // 逐字还原原文），但不占版面；pipe 标记不带 <i>，编辑时不会浮出淡色标签。
  function pipeMarker(text) {
    return '<span class="mk mk-pipe" contenteditable="false">' + escapeHtml(text) + '</span>';
  }

  function tableRowHtml(line, align, tag, withNewline) {
    var row = splitTableLine(line);
    var html = '<tr>';
    for (var c = 0; c < row.cells.length; c++) {
      var cell = row.cells[c];
      var style = align[c] ? ' style="text-align:' + align[c] + '"' : '';
      html += '<' + tag + style + '>';
      if (c === 0 && row.lead)
        html += pipeMarker(row.lead);
      // 单元格内容里的转义 \|：反斜杠收进零宽标记（textContent 保留 \ 逐字），
      // 竖线可见渲染。这样显示是 |，而 splitTableLine 仍认得它是内容不是分隔符。
      var cellText = cell.text;
      if (cellText.indexOf('\\|') >= 0) {
        var segs = cellText.split('\\|');
        for (var g = 0; g < segs.length; g++) {
          if (g > 0)
            html += '<span class="mk mk-pipeesc" contenteditable="false">\\</span>|';
          html += renderInline(segs[g]);
        }
      } else {
        html += renderInline(cellText);
      }
      if (cell.sep)
        html += pipeMarker(cell.sep);
      if (c === row.cells.length - 1) {
        if (row.tail)
          html += pipeMarker(row.tail);
        if (withNewline)
          html += newlineMarker();
      }
      html += '</' + tag + '>';
    }
    return html + '</tr>';
  }

  function renderTable(lines) {
    var align = tableAlignments(lines[1]);
    var head = splitTableLine(lines[0]);
    var body = [];
    for (var r = 2; r < lines.length; r++) {
      if (lines[r].trim())
        body.push(lines[r]);
    }
    // 对齐行不参与渲染（display:none，零高度），但原文按 DOM 顺序留在表头与表体
    // 之间，textContent 才能逐字还原 `| a | b |\n|---|...|`。
    var html = '<table class="md-table"><thead>'
      + tableRowHtml(lines[0], align, 'th', true)
      + '<tr class="tbl-align" aria-hidden="true"><td colspan="' + Math.max(1, head.cells.length) + '">'
      + escapeHtml(lines[1]) + (body.length ? newlineMarker() : '') + '</td></tr>'
      + '</thead><tbody>';
    for (var b = 0; b < body.length; b++)
      html += tableRowHtml(body[b], align, 'td', b < body.length - 1);
    return html + '</tbody></table>';
  }

  function tableCellList(el) {
    var out = [];
    var rows = el.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].classList.contains('tbl-align'))
        continue;
      for (var c = 0; c < rows[r].children.length; c++)
        out.push(rows[r].children[c]);
    }
    return out;
  }

  // 最后一格按 Tab 追加一行：否则 Tab 在表格里走到尽头就无路可走，而回车又被
  // 定义为“不改结构”，表格将无法扩行。
  function appendTableRow(el) {
    var body = el.querySelector('tbody');
    var headRow = el.querySelector('thead tr');
    if (!body || !headRow)
      return false;
    var count = headRow.children.length;
    if (!count)
      return false;
    commitHistory();
    // 原来的最后一行没有换行标记（它就是原文最后一行）。追加前先补一个，
    // 否则新行会拼进上一行的 textContent，dataset.raw 里两行会变成同一行。
    var existing = body.children;
    if (existing.length) {
      var lastCell = existing[existing.length - 1].lastElementChild;
      if (lastCell)
        lastCell.insertAdjacentHTML('beforeend', newlineMarker());
    }
    var lines = String(el.dataset.raw || '').split('\n');
    var align = tableAlignments(lines[1] || '');
    var line = '|' + new Array(count + 1).join('  |');
    body.insertAdjacentHTML('beforeend', tableRowHtml(line, align, 'td', false));
    el.dataset.raw = el.textContent;
    scheduleDirty();
    scheduleCommit();
    commitHistory();
    return true;
  }

  // 在当前行上方/下方插入一个空行（Cmd+Shift+Enter / Cmd+Enter）。关键是让每行
  // 的换行标记与原文逐字对齐：原文里除末行外每行都以 \n 结尾，所以——
  //   · 插到下方：当前行保留自己的 \n；新行只在成为新末行时不带 \n，否则带。
  //   · 插到上方：新行必带 \n；当前行若原本是末行（原本无 \n）需补一个。
  // 任何一行漏掉 \n，相邻两行就会在 textContent 里粘连，下次重渲染被解析成
  // 同一行（列数翻倍）。光标始终落在新行同列的单元格末尾。
  function insertTableRow(el, below) {
    var cell = activeCell(el);
    if (!cell)
      return false;
    var row = cell.parentNode;
    if (!row || row.tagName !== 'TR' || row.classList.contains('tbl-align'))
      return false;
    var count = el.querySelector('thead tr').children.length;
    if (!count)
      return false;
    var lines = String(el.dataset.raw || '').split('\n');
    var align = tableAlignments(lines[1] || '');
    var line = '|' + new Array(count + 1).join('  |');
    commitHistory();
    var newRow = null;
    if (below) {
      // 当前行的换行标记始终保留（它是当前行的行尾）。新行只在"插到末行之后"
      // 时不带换行标记（它成为新末行）；其余情况新行后面还有行，必须带。
      var last = row.lastElementChild;
      var isLast = !(last && last.querySelector(':scope > .mk-nl'));
      if (row.parentNode.tagName === 'THEAD') {
        // 表头行下方同样不可插（新行会夹在表头与对齐行之间，原文第 2 行不再是
        // 对齐行），改为落到对齐行之后、表体首行。
        var tbody = el.querySelector('tbody');
        var hasBody = tbody.children.length > 0;
        tbody.insertAdjacentHTML('afterbegin', tableRowHtml(line, align, 'td', hasBody));
        newRow = tbody.firstElementChild;
      } else {
        row.insertAdjacentHTML('afterend', tableRowHtml(line, align, 'td', !isLast));
        if (isLast)
          last.insertAdjacentHTML('beforeend', newlineMarker());
        newRow = row.nextElementSibling;
      }
    } else {
      // 新行插到当前行上方，自身必须带换行标记（它后面还有当前行/对齐行）。
      // 当前行若原本是末行（没有换行标记），插入后不再是末行，必须补上，
      // 否则新行会拼进它的 textContent。表头行上方不可插（表头必须与对齐行
      // 相邻），此时新行改落表体首行——同样在表头"之上"，光标也落在那里。
      var had = row.lastElementChild && row.lastElementChild.querySelector(':scope > .mk-nl');
      var inHead = row.parentNode.tagName === 'THEAD';
      if (inHead) {
        var body = el.querySelector('tbody');
        body.insertAdjacentHTML('afterbegin', tableRowHtml(line, align, 'td', true));
        newRow = body.firstElementChild;
      } else {
        row.insertAdjacentHTML('beforebegin', tableRowHtml(line, align, 'td', true));
        if (!had) {
          var tail = row.lastElementChild;
          if (tail)
            tail.insertAdjacentHTML('beforeend', newlineMarker());
        }
        newRow = row.previousElementSibling;
      }
    }
    el.dataset.raw = el.textContent;
    caretInCellEnd(newRow.children[Math.min(cell.cellIndex, newRow.children.length - 1)]);
    scheduleDirty();
    scheduleCommit();
    commitHistory();
    return true;
  }

  function moveTableCell(el, delta) {
    var cells = tableCellList(el);
    if (!cells.length)
      return;
    var index = cells.indexOf(activeCell(el));
    if (index < 0)
      index = 0;
    var next = index + delta;
    if (next < 0)
      next = 0;
    if (next >= cells.length) {
      if (delta > 0 && appendTableRow(el)) {
        cells = tableCellList(el);
        next = index + 1;
      } else {
        next = cells.length - 1;
      }
    }
    caretInCellEnd(cells[next]);
  }

  // 任务列表项：复选框只是控件，"[ ] " / "[x] " 仍以零宽标记留在 DOM 里，
  // 保证 textContent 与 dataset.raw 逐字相等；控件本身无文本，复制不会带出额外字符。
  function renderListItem(line, lead, index) {
    var rest = line.slice(lead.length);
    var task = /^\[([ xX])\]\s+/.exec(rest);
    var indent = /^\s*/.exec(lead)[0].length;
    // 缩进子项在扁平列表里用左边距表达层级（原文的前导空格仍由标记承载）
    var style = indent ? ' style="margin-left:' + (indent * 0.6) + 'em"' : '';
    var head = (index && INLINE_PROTO ? newlineMarker() : '')
      + (INLINE_PROTO ? marker(lead, 'bullet') : '');
    if (!task)
      return '<li' + style + '>' + head + renderInline(rest) + '</li>';
    return '<li class="task"' + style + '>' + head
      // 任务标记不做成原子对象：编辑态它显示为可见文本，光标可以进入并用键盘
      // 把 [ ] 改成 [x]；渲染态 font-size:0 隐藏，由复选框代替。文字包一层 <i>，
      // 编辑态才能绝对定位压到复选框那块占位上，做到进出编辑态零位移。
      + (INLINE_PROTO ? '<span class="mk mk-task"><i>' + escapeHtml(task[0]) + '</i></span>' : '')
      + '<input type="checkbox" class="task-check" contenteditable="false" tabindex="-1"'
      + (task[1] === ' ' ? '' : ' checked') + '>'
      + renderInline(rest.slice(task[0].length)) + '</li>';
  }

  // 点击复选框：只改写该行的 [ ] / [x]，重新渲染并落一个撤销步。
  // 控件本身不承载文本，dataset.raw 与 textContent 仍由 .mk 标记保持一致。
  function toggleTaskCheckbox(box) {
    var li = box.closest ? box.closest('li') : null;
    var el = li ? blockOf(li) : null;
    if (!li || !el || !el.classList.contains('block'))
      return;
    var lines = rawOf(el).split('\n');
    var index = Array.prototype.indexOf.call(el.querySelectorAll('li'), li);
    if (index < 0 || index >= lines.length)
      return;
    var next = lines[index].replace(/^(\s*[-*+]\s+)\[([ xX])\]/, function (all, lead, mark) {
      return lead + (mark === ' ' ? '[x]' : '[ ]');
    });
    if (next === lines[index])
      return;
    lines[index] = next;
    commitHistory();
    applyRawToBlock(el, lines.join('\n'), undefined, undefined, false);
    setTimeout(commitHistory, 0);
  }

  function renderBlock(el, raw) {
    raw = String(raw === undefined || raw === null ? '' : raw);
    var kind = 'p';
    var html = '';

    var fence = raw.match(/^```([^\n`]*)\n?([\s\S]*?)\n?```\s*$/);
    var heading = raw.match(/^(#{1,6})(\s+)(.+)$/);
    var lines = raw.split('\n');

    if (fence) {
      kind = 'code';
      el.dataset.lang = fence[1];
      html = renderCode(el, fence[2], fence[1]);
    } else if (heading && lines.length === 1) {
      var level = heading[1].length;
      kind = 'h' + level;
      // 前缀按原文原样折叠（含 # 后的空白），否则 textContent 少一个空格，
      // 离开编辑态时块类型会悄悄变掉
      var prefix = INLINE_PROTO ? marker(heading[1] + heading[2], 'head') : '';
      html = '<h' + level + '>' + prefix + renderInline(heading[3]) + '</h' + level + '>';
    } else if (isTableSource(lines)) {
      kind = 'table';
      html = renderTable(lines);
    } else if (lines.length && lines.every(function (line) { return /^\s*[-*+]\s+/.test(line); })) {
      kind = 'ul';
      html = '<ul>';
      lines.forEach(function (line, index) {
        var lead = /^\s*[-*+]\s+/.exec(line)[0];
        html += renderListItem(line, lead, index);
      });
      html += '</ul>';
    } else if (lines.length && lines.every(function (line) { return /^\s*\d+[.)]\s+/.test(line); })) {
      kind = 'ol';
      html = '<ol>';
      lines.forEach(function (line, index) {
        var lead = /^\s*\d+[.)]\s+/.exec(line)[0];
        html += renderListItem(line, lead, index);
      });
      html += '</ol>';
    } else if (lines.length && lines.every(function (line) { return /^\s*>/.test(line); })) {
      kind = 'quote';
      html = '<blockquote>';
      lines.forEach(function (line, index) {
        var lead = /^\s*>\s?/.exec(line)[0];
        if (index)
          html += '<br>' + (INLINE_PROTO ? newlineMarker() : '');
        html += (INLINE_PROTO ? marker(lead, 'quote') : '') + renderInline(line.slice(lead.length));
      });
      html += '</blockquote>';
    } else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw.trim())) {
      kind = 'hr';
      html = '<hr>';
    } else {
      html = lines.map(renderInline).join(INLINE_PROTO ? '<br>' + newlineMarker() : '<br>');
    }

    el.dataset.raw = raw;
    el.className = 'block ' + kind;
    el.innerHTML = html || '<br>';
  }

  /* ---------------- 文档模型与选区 ---------------- */

  // 块原文：代码块的 DOM 里还有行号栏，textContent 不能代表原文，编辑期间由
  // dataset.raw 逐次同步（见 syncCode），渲染态本来就用 dataset.raw。
  function blockRawText(el) {
    var raw;
    if (isCodeBlock(el))
      raw = el.dataset.raw;
    else
      raw = el.classList.contains('editing') ? el.textContent : el.dataset.raw;
    if (raw === undefined)
      raw = el.textContent;
    return String(raw).replace(/\r/g, '').replace(/\n+$/, '');
  }

  function collectBlocks() {
    return blockList().map(blockRawText);
  }

  // 第 index 块之前的空行数：载入、撤销重建时写进 data-gap；用户新建的块没有
  // 这个属性，第 0 块按文首 0 个、其余按 2 个（与改动前固定的 '\n\n' 一致）。
  function blockGap(el, first) {
    var value = el && el.dataset ? parseInt(el.dataset.gap, 10) : NaN;
    if (isNaN(value) || value < 0)
      return first ? 0 : 2;
    return value;
  }

  function collectGaps() {
    var list = blockList();
    var gaps = [];
    for (var i = 0; i < list.length; i++)
      gaps.push(blockGap(list[i], i === 0));
    return gaps;
  }

  function gapBefore(gaps, index) {
    if (gaps && index < gaps.length)
      return gaps[index];
    return index === 0 ? 0 : 2;
  }

  // 整篇文本 = 各块前的间隔 + 块原文 + 文末换行
  function layoutText(blocks, gaps, trail) {
    var out = '';
    for (var i = 0; i < blocks.length; i++) {
      for (var n = gapBefore(gaps, i); n > 0; n--)
        out += '\n';
      out += blocks[i];
    }
    for (var t = trail > 0 ? trail : 0; t > 0; t--)
      out += '\n';
    return out;
  }

  // 第 index 块在整篇文本里的起始偏移（绝对偏移 → 块内偏移的反向换算）
  function blockStartOffset(blocks, gaps, index) {
    var offset = 0;
    for (var i = 0; i <= index && i < blocks.length; i++) {
      offset += gapBefore(gaps, i);
      if (i < index)
        offset += blocks[i].length;
    }
    return offset;
  }

  function currentSource() {
    if (mode === 'source')
      return sourceEl.value;
    return layoutText(collectBlocks(), collectGaps(), trailingNewlines);
  }

  function scheduleDirty() {
    if (dirtyTimer)
      clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(function () {
      dirtyTimer = null;
      post({ type: 'dirty', value: currentSource() !== savedText });
      postWordCount();
    }, 220);
  }

  // 字数口径（README 与 PACKAGING 同步说明）：
  // - 中文：CJK 统一表意文字（含扩展 A 与兼容区）逐字计数；
  // - 英文：连续的字母/数字（允许词内 ' 与 -）算 1 个单词；
  // - 标点、空白、Markdown 标记符号（# > - * ` [ ](url) 等）不计；
  // - 代码块正文与表格单元格计入，围栏、行号、语言徽标不计。
  function plainTextOfRaw(raw) {
    var text = String(raw === undefined || raw === null ? '' : raw);
    if (/^```[^\n]*\n[\s\S]*\n?```\s*$/.test(text))
      return text.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
    return text.split('\n').map(function (line) {
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line))
        return '';
      if (line.indexOf('|') >= 0 && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
        return '';
      return line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' ');
    }).join('\n');
  }

  function countText(text) {
    var plain = text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1');
    var cjk = (plain.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    var words = (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    return { cjk: cjk, words: words };
  }

  function postWordCount() {
    var stats = countText(collectBlocks().map(plainTextOfRaw).join('\n'));
    var label = document.getElementById('status-stats');
    if (label)
      label.textContent = '中文 ' + stats.cjk + ' 字 · 英文 ' + stats.words + ' 词';
    post({ type: 'stats', cjk: stats.cjk, words: stats.words });
  }

  function blockOf(node) {
    while (node && node !== root) {
      if (node.classList && node.classList.contains('block'))
        return node;
      node = node.parentNode;
    }
    return null;
  }

  function setCaret(el, offset) {
    // 折叠标记模式下，偏移必须按零宽原子取整，否则光标会落进 <i> 里
    if (INLINE_PROTO) {
      setSelectionRange(el, offset);
      return;
    }
    var range = document.createRange();
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var remaining = offset;
    var node = null;

    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        range.setStart(node, remaining);
        range.collapse(true);
        break;
      }
      remaining -= node.nodeValue.length;
    }
    if (!node) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 任意 DOM 位置 → 相对 root 的字符偏移（只数字符，不计元素）。位置不在
  // root 内时返回 -1。
  function offsetIn(rootEl, container, offset) {
    var range = document.createRange();
    range.selectNodeContents(rootEl);
    try {
      range.setEnd(container, offset);
    } catch (error) {
      return -1;
    }
    return range.toString().length;
  }

  // 当前选区在某个元素内的字符范围；选区不在该元素内时返回 null
  function rangeIn(rootEl) {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (range.startContainer !== rootEl && !rootEl.contains(range.startContainer))
      return null;
    if (range.endContainer !== rootEl && !rootEl.contains(range.endContainer))
      return null;
    var start = offsetIn(rootEl, range.startContainer, range.startOffset);
    var end = offsetIn(rootEl, range.endContainer, range.endOffset);
    if (start < 0 || end < 0)
      return null;
    return { start: start, end: Math.max(start, end) };
  }

  // 徽标可能被原生编辑整块删掉（整块选中后退格/删除时，WebKit 会把不可编辑的
  // span 一起移除）。此时补回一个徽标，否则语言就再也改不回来。
  function ensureLangBadge(el) {
    var badge = el.querySelector('.code-lang');
    if (badge)
      return badge;
    var pre = el.querySelector('pre.code-block');
    if (!pre)
      return null;
    badge = document.createElement('span');
    badge.className = 'code-lang';
    badge.setAttribute('contenteditable', 'false');
    badge.setAttribute('spellcheck', 'false');
    badge.setAttribute('role', 'button');
    badge.setAttribute('aria-haspopup', 'listbox');
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-label', '代码语言');
    badge.textContent = el.dataset.lang || '';
    badge.title = el.dataset.lang || '';
    var tools = pre.querySelector('.code-tools');
    if (tools)
      tools.insertBefore(badge, tools.firstChild);
    else
      pre.insertBefore(badge, pre.firstChild);
    return badge;
  }

  // 整段替换 <code> 的 innerHTML 会把 .code-scroll 的横向滚动位置冲回 0，长行
  // 已经滚到右边时视野会跳回行首。替换前后保存/恢复；没滚动过就不写回，省掉
  // 一次强制布局。
  function setCodeHtml(el, code, html) {
    var scroller = el.querySelector('.code-scroll');
    var left = scroller ? scroller.scrollLeft : 0;
    var top = scroller ? scroller.scrollTop : 0;
    code.innerHTML = html;
    if (scroller && (left || top)) {
      scroller.scrollLeft = left;
      scroller.scrollTop = top;
    }
  }

  // 重着色 + 按字符偏移复位光标。用 lang+正文当签名：已经画过的这版内容不再
  // 整段替换（徽标合并重着色、连续 input 都会撞到）。
  function drawCode(el) {
    var code = codeEl(el);
    if (!code)
      return null;
    var text = code.textContent;
    var sig = (el.dataset.lang || '') + '\n' + text;
    if (el._codeDrawn === sig)
      return code;
    var range = rangeIn(code);
    setCodeHtml(el, code, highlightCode(el, text, el.dataset.lang).join('\n'));
    el._codeDrawn = sig;
    if (range)
      setSelectionRange(code, range.start, range.end);
    return code;
  }

  // 改语言：同步 dataset.lang → 原文首行围栏，并立即按新语言重着色。
  // 重着色只重建 <code> 的行内 span（只变颜色，不变字号/行高/宽度），
  // 因此块几何不变；光标在正文里时按字符偏移恢复。
  function applyCodeLang(el, value) {
    // 语言标识不允许空白与反引号（会破坏首行围栏），直接剔除；
    // 保证「徽标显示 === dataset.lang === 围栏内容」三者一致。
    var lang = String(value === undefined || value === null ? '' : value)
      .replace(/[\s`]/g, '');
    var badge = el.querySelector('.code-lang');
    if (badge && badge.textContent !== lang) {
      badge.textContent = lang;
      badge.title = lang;
    }
    el.dataset.lang = lang;
    el.dataset.raw = codeRaw(el);
    el._codeStale = false;
    if (codeEl(el))
      drawCode(el);
  }

  // 把代码正文重新着色：只重建 <code> 的行内 span（文本不变，字体/行高/宽度
  // 都不变），随后按字符偏移把光标放回原处。组合输入期间不调用。
  function syncCode(el, highlight) {
    var code = codeEl(el);
    if (!code)
      return;
    var text = code.textContent;
    el.dataset.raw = codeRaw(el, text);
    updateGutter(el, text);
    el._codeStale = false;
    if (highlight)
      drawCode(el);
  }

  // 在代码正文的选区处插入纯文本（回车、粘贴共用）。返回值表示是否处理成功；
  // 成功时同步原文/行号并保持光标在插入内容之后。
  function insertCodeText(el, text) {
    var code = codeEl(el);
    if (!code)
      return false;
    var range = rangeIn(code);
    var value = code.textContent;
    if (!range)
      range = { start: value.length, end: value.length };
    var next = value.slice(0, range.start) + text + value.slice(range.end);
    el.dataset.raw = codeRaw(el, next);
    updateGutter(el, next);
    el._codeStale = false;
    setCodeHtml(el, code, highlightCode(el, next, el.dataset.lang).join('\n'));
    el._codeDrawn = (el.dataset.lang || '') + '\n' + next;
    setSelectionRange(code, range.start + text.length);
    return true;
  }

  function caretOffset(el) {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return 0;
    // 代码块的光标偏移只按 <code> 里的正文计算，行号栏不能算进去
    var scope = isCodeBlock(el) ? codeEl(el) : el;
    if (!scope)
      return 0;
    var range = selection.getRangeAt(0);
    var prefix = range.cloneRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.endContainer, range.endOffset);
    } catch (error) {
      return 0;
    }
    return prefix.toString().length;
  }

  // caretOffset 对代码块给的是 <code> 内偏移，placeBlockCaret 收的却是块原文
  // 口径（dataset.raw，含围栏行）；要在两处之间存取光标（如查找栏开/关）必须
  // 先补齐围栏长度，否则回来时会被 placeBlockCaret 再减一次，光标往左偏。
  function rawCaretOffset(el) {
    return caretOffset(el) + (isCodeBlock(el) ? codePrefixLength(el) : 0);
  }

  function blockIndex(el) {
    return Array.prototype.indexOf.call(root.children, el);
  }

  // 字符偏移 → DOM 位置（用于撤销后恢复选区）。
  // 原型模式下列标记为零宽原子：落进标记内部时按左右边界取整，绝不把光标
  // 放进绝对定位的标记文本里（否则会出现看不见的光标 / 候选框错位）。
  function locateOffset(el, offset) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var remaining = Math.max(0, offset || 0);
    var node = null;
    var last = null;
    while ((node = walker.nextNode())) {
      if (INLINE_PROTO) {
        var mk = node.parentNode && node.parentNode.closest ? node.parentNode.closest('.mk') : null;
        if (mk) {
          var mkLen = node.nodeValue.length;
          var idx = Array.prototype.indexOf.call(mk.parentNode.childNodes, mk);
          if (remaining < mkLen)
            return remaining * 2 >= mkLen
              ? { node: mk.parentNode, offset: idx + 1 }
              : { node: mk.parentNode, offset: idx };
          remaining -= mkLen;
          last = { node: mk.parentNode, offset: idx + 1 };
          continue;
        }
      }
      last = { node: node, offset: node.nodeValue.length };
      if (remaining <= node.nodeValue.length)
        return { node: node, offset: remaining };
      remaining -= node.nodeValue.length;
    }
    if (last)
      return last;
    return { node: el, offset: 0 };
  }

  function setSelectionRange(el, start, end) {
    var from = locateOffset(el, start);
    var to = locateOffset(el, end === undefined ? start : end);
    var range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch (error) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 当前块内选区 → 整篇绝对偏移。失焦（没有活动编辑块）时 has 为 false
  function editingSelection() {
    var active = document.activeElement;
    var el = active ? blockOf(active) : null;
    var selection = window.getSelection();
    if (!el || !el.classList.contains('editing') || !selection.rangeCount)
      return { index: -1, start: 0, end: 0 };
    var code = isCodeBlock(el) ? codeEl(el) : null;
    var scope = code || el;
    var range = selection.getRangeAt(0);
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch (error) {
      prefix.selectNodeContents(scope);
    }
    // 代码块补上 "```lang\n" 前缀，才是与 dataset.raw 一致的块内偏移
    var start = prefix.toString().length + (code ? codePrefixLength(el) : 0);
    return { index: blockIndex(el), start: start, end: start + range.toString().length };
  }

  function absoluteOffsets(blocks, sel) {
    if (sel.index < 0)
      return { start: 0, end: 0, has: false };
    var base = blockStartOffset(blocks, collectGaps(), sel.index);
    return { start: base + sel.start, end: base + sel.end, has: true };
  }

  // 快照：wysiwyg 只保留块数组与块间空行（保住文首/文末空行），source 只保留
  // 纯文本。wysiwyg 的整篇文本由 layoutText 按需拼出，不额外存副本。
  function snapshotState() {
    if (mode === 'source') {
      var text = sourceEl.value;
      return {
        text: text, blocks: null, gaps: null, trail: trailingNewlineCount(text),
        start: sourceEl.selectionStart, end: sourceEl.selectionEnd,
        hasSel: document.activeElement === sourceEl
      };
    }
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var sel = editingSelection();
    var offsets = absoluteOffsets(blocks, sel);
    return {
      text: null,
      blocks: blocks, gaps: gaps, trail: trailingNewlines,
      start: offsets.start, end: offsets.end, hasSel: offsets.has
    };
  }

  function stateText(snap) {
    if (typeof snap.text === 'string')
      return snap.text;
    return layoutText(snap.blocks, snap.gaps, snap.trail);
  }

  function sameState(a, b) {
    // 同一模式的 wysiwyg 快照逐块比较即可，不必先把整篇拼成字符串
    if (a.blocks && b.blocks) {
      if (a.blocks.length !== b.blocks.length || a.trail !== b.trail)
        return false;
      for (var i = 0; i < a.blocks.length; i++)
        if (a.blocks[i] !== b.blocks[i])
          return false;
      // 块间空行也是文档内容：只改空行数量同样要落一个撤销步
      var gapsA = a.gaps || [];
      var gapsB = b.gaps || [];
      if (gapsA.length !== gapsB.length)
        return false;
      for (var g = 0; g < gapsA.length; g++)
        if (gapsA[g] !== gapsB[g])
          return false;
      return true;
    }
    return stateText(a) === stateText(b);
  }

  // 提交一个撤销步骤；文本未变化时只更新当前步的选区，避免进出编辑态
  // 或纯光标移动产生多余的历史记录
  function commitHistory() {
    // 批量转换期间（含焦点在块间移动触发的提交）不落历史，结尾统一提交一次
    if (suppressEvents || commitBatch > 0)
      return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    var snap = snapshotState();
    var current = history[historyIndex];
    if (current && sameState(current, snap)) {
      current.start = snap.start;
      current.end = snap.end;
      current.hasSel = snap.hasSel;
      scheduleDirty();
      return;
    }
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > MAX_HISTORY)
      history.splice(0, history.length - MAX_HISTORY);
    historyIndex = history.length - 1;
    scheduleDirty();
  }

  function scheduleCommit() {
    if (suppressEvents || composing || commitBatch > 0)
      return;
    if (commitTimer)
      clearTimeout(commitTimer);
    commitTimer = setTimeout(function () {
      commitTimer = null;
      commitHistory();
    }, COALESCE_MS);
  }

  // gaps 省略时全部按默认间隔（新建块之间的 2 个换行），供只关心文本的调用方使用
  function mountBlocks(blocks, gaps, trail) {
    // 整篇重建后旧的绝对偏移全部失效，跨块选区必须先清掉
    clearCrossSelection();
    closeLangMenu();
    root.innerHTML = '';
    for (var i = 0; i < blocks.length; i++) {
      var el = document.createElement('div');
      el.className = 'block';
      el.setAttribute('contenteditable', 'true');
      if (gaps)
        el.dataset.gap = String(gapBefore(gaps, i));
      renderBlock(el, blocks[i]);
      root.appendChild(el);
    }
    if (typeof trail === 'number')
      trailingNewlines = trail > 0 ? trail : 0;
    // 全部挂载完成、文档结构稳定后再归一化，避免逐个元素强制布局
    normalizeCodeScrolls();
    postWordCount();
  }

  // 绝对偏移 → 所在块下标与块内偏移（undo/redo 恢复选区用）
  function locateBlock(blocks, gaps, absStart) {
    var base = 0;
    for (var i = 0; i < blocks.length; i++) {
      base += gapBefore(gaps, i);
      var stop = base + blocks[i].length;
      if (absStart <= stop || i === blocks.length - 1)
        return { index: i, start: Math.max(0, absStart - base) };
      base = stop;
    }
    return { index: blocks.length - 1, start: 0 };
  }

  function rebuildFromSnapshot(snap) {
    suppressEvents = true;
    var scrollY = window.scrollY;

    if (mode === 'source') {
      sourceEl.value = stateText(snap);
      trailingNewlines = snap.trail > 0 ? snap.trail : 0;
    } else {
      var layout = snap.blocks
        ? { blocks: snap.blocks.slice(), gaps: snap.gaps || [], trail: snap.trail }
        : splitSourceLayout(stateText(snap));
      var blocks = layout.blocks;
      mountBlocks(blocks, layout.gaps, layout.trail);

      if (snap.hasSel) {
        var base = 0;
        var index = -1;
        var start = 0;
        var end = 0;
        for (var i = 0; i < blocks.length; i++) {
          base += gapBefore(layout.gaps, i);
          var stop = base + blocks[i].length;
          if (snap.start <= stop || i === blocks.length - 1) {
            index = i;
            start = Math.max(0, snap.start - base);
            end = Math.max(start, Math.min(snap.end, stop) - base);
            break;
          }
          base = stop;
        }
        if (index >= 0 && root.children[index]) {
          var target = root.children[index];
          if (inPlaceEditable(target)) {
            renderBlock(target, blocks[index]);
            normalizeCodeScrolls(target);
            target.classList.add('editing');
            target.focus();
            placeBlockCaret(target, start, end);
          } else {
            target.classList.add('editing');
            target.textContent = blocks[index];
            target.focus();
            setSelectionRange(target, start, end);
          }
        }
      }
    }

    suppressEvents = false;
    if (mode === 'source' && snap.hasSel) {
      try {
        sourceEl.focus();
        sourceEl.setSelectionRange(snap.start, snap.end);
      } catch (error) { /* ignore */ }
    }
    window.scrollTo(0, scrollY);
    scheduleDirty();
    refreshToc();
    // 撤销/重做会整篇重建，旧的命中区间已经失效；查找条开着就重扫一遍
    if (findBar)
      scheduleFind();
  }

  function undo() {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
      commitHistory();
    }
    if (historyIndex <= 0) {
      post({ type: 'log', message: 'undo skipped index=' + historyIndex + ' size=' + history.length });
      return;
    }
    historyIndex--;
    post({ type: 'log', message: 'undo -> index=' + historyIndex + ' size=' + history.length });
    rebuildFromSnapshot(history[historyIndex]);
  }

  function redo() {
    if (historyIndex < 0 || historyIndex >= history.length - 1) {
      post({ type: 'log', message: 'redo skipped index=' + historyIndex + ' size=' + history.length });
      return;
    }
    historyIndex++;
    post({ type: 'log', message: 'redo -> index=' + historyIndex + ' size=' + history.length });
    rebuildFromSnapshot(history[historyIndex]);
  }

  /* ---------------- 所见即所得编辑 ---------------- */

  // 行内折叠接管「渲染态 == 原文」的块：段落/标题/列表/引用/代码块，以及
  // 用零宽标记补回 | 与对齐行的表格、用绝对定位叠出原文的 <hr>。回退模式下
  // 仍走整块替换。
  function inPlaceEditable(el) {
    return INLINE_PROTO;
  }

  function caretAtEdge(node, atStart) {
    var range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(!!atStart);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function activeCell(el) {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return null;
    var node = selection.getRangeAt(0).startContainer;
    var parent = node.nodeType === 1 ? node : node.parentNode;
    var cell = parent && parent.closest ? parent.closest('th,td') : null;
    return cell && el.contains(cell) && !cell.closest('.tbl-align') ? cell : null;
  }

  // 光标在单元格可见文本里的位置（标记不计入）。offset 为 -1 表示判断不了
  // （例如光标落进了不可编辑标记内部），调用方按“不是边界”处理。
  function cellCaretInfo(cell, range) {
    var nodes = editableTextNodes(cell);
    var total = 0;
    var i;
    for (i = 0; i < nodes.length; i++)
      total += nodes[i].nodeValue.length;
    // 容器是元素节点时（空格子里 WebKit 常把光标放在子节点之间，比如尾部 |
    // 标记旁），按边界比较数出光标左侧的可见字符数，同样能判断格首/格尾。
    if (range.startContainer.nodeType === 1) {
      var offset = 0;
      for (i = 0; i < nodes.length; i++) {
        var probe = document.createRange();
        probe.selectNodeContents(nodes[i]);
        if (probe.compareBoundaryPoints(Range.END_TO_END, range) > 0)
          break;
        offset += nodes[i].nodeValue.length;
      }
      return { offset: offset, total: total };
    }
    var acc = 0;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] === range.startContainer)
        return { offset: acc + range.startOffset, total: total };
      acc += nodes[i].nodeValue.length;
    }
    return { offset: -1, total: total };
  }

  // 单元格边界上的退格/删除定义为“不动”：跨格删字会悄悄吃掉 padding 空格，
  // 还会让光标跳到相邻单元格，语义不清。结构改动只走 Tab / 粘贴。
  function atCellEdge(el, backward, event) {
    var cell = activeCell(el);
    if (!cell)
      return false;
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return false;
    var range = selection.getRangeAt(0);
    if (!range.collapsed)
      return false;
    var info = cellCaretInfo(cell, range);
    if (info.offset < 0)
      return false;
    if (backward ? info.offset === 0 : info.offset >= info.total) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  function cellOfNode(el, node) {
    var parent = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    var cell = parent && parent.closest ? parent.closest('th,td') : null;
    return cell && el.contains(cell) && !cell.closest('.tbl-align') ? cell : null;
  }

  function rangeCrossesCells(el, range) {
    var a = cellOfNode(el, range.startContainer);
    var b = cellOfNode(el, range.endContainer);
    return !!(a || b) && a !== b;
  }

  // 单元格里"可见文本"（不含任何零宽标记里的原文）
  function cellVisibleText(cell) {
    var out = '';
    var walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var host = node.parentNode;
      if (host && host.closest && host.closest('.mk'))
        continue;
      out += node.nodeValue;
    }
    return out;
  }

  // 清理策略：跨格删除只清可见文本，行内标记（**、`、[]() 等）是零宽原子、
  // 不会被删掉。若某格删完后已无可见文本，这些标记就失去了承载内容——留着会在
  // 下次重渲染时显形（例如只剩 ****、[](url)）。此时把该格里除结构性标记
  // （| 与 \n）以外的元素全部移除，得到真正的空单元格。
  // 兜底：| 与 \n 结构标记始终保留，因此列数不会被改变；清理本身若异常，
  // 调用方退回“只清可见文本”，结构安全优先。
  function purgeCellFormatting(cell) {
    var nodes = cell.querySelectorAll('*');
    for (var i = nodes.length - 1; i >= 0; i--) {
      var node = nodes[i];
      if (node.classList && (node.classList.contains('mk-pipe')
          || node.classList.contains('mk-nl') || node.classList.contains('mk-pipeesc')))
        continue;
      if (node.parentNode && cell.contains(node))
        node.parentNode.removeChild(node);
    }
  }

  // 跨格删除：只清可见文本，保留 | 与对齐行标记。交给原生删除会把选区里的
  // contenteditable=false 标记一起带走，列数就变了（重排后整行少一列）。
  function clearSelectedCellText(el, range) {
    var startNode = range.startContainer;
    var startOffset = range.startOffset;
    var scope = range.commonAncestorContainer;
    if (scope.nodeType !== 1)
      scope = scope.parentNode;
    if (!scope || !el.contains(scope))
      scope = el;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    var hits = [];
    var node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node))
        continue;
      var host = node.parentNode;
      if (!host || !host.closest)
        continue;
      if (host.closest('.mk') || !host.closest('th,td'))
        continue;
      var s = node === startNode ? startOffset : 0;
      var e = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      // 所属单元格在这里就记下来：下面的清理可能把承载它的格式容器整段摘掉，
      // 之后再从 node.parentNode 往上找就找不到 <td> 了。
      if (e > s)
        hits.push({ node: node, start: s, end: e, cell: host.closest('th,td') });
    }
    if (!hits.length)
      return false;
    var cells = [];
    for (var i = 0; i < hits.length; i++) {
      var value = hits[i].node.nodeValue;
      hits[i].node.nodeValue = value.slice(0, hits[i].start) + value.slice(hits[i].end);
      var cell = hits[i].cell;
      if (cell && cell.closest('table') && cells.indexOf(cell) < 0)
        cells.push(cell);
    }
    for (var c = 0; c < cells.length; c++) {
      if (cellVisibleText(cells[c]).replace(/\s/g, '') !== '')
        continue;
      try {
        purgeCellFormatting(cells[c]);
      } catch (error) {
        // 兜底：清理失败就保留标记，仅清可见文本（列结构不受影响）
      }
    }
    var first = hits[0];
    var firstCell = first.cell;
    if (firstCell && !first.node.isConnected) {
      // 清理把承载起点的那段格式容器删掉了：光标落回该格可见文本末尾；
      // 若该格已空，就落在格内首个可编辑位置（结构标记之间）。
      if (cellVisibleText(firstCell).length)
        caretInCellEnd(firstCell);
      else
        caretAtEdge(firstCell, false);
    } else if (first.node.isConnected) {
      var caret = document.createRange();
      var offset = first.node === startNode ? Math.min(startOffset, first.node.nodeValue.length) : 0;
      caret.setStart(first.node, offset);
      caret.collapse(true);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    el.dataset.raw = el.textContent;
    scheduleDirty();
    scheduleCommit();
    return true;
  }

  // 命中点落在格线/边框/内边距上时，按几何距离挑最近的单元格
  function cellFromPoint(el, x, y) {
    var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    for (var i = 0; i < stack.length; i++) {
      var hit = stack[i].closest ? stack[i].closest('th,td') : null;
      if (hit && el.contains(hit) && !hit.closest('.tbl-align'))
        return hit;
    }
    var cells = el.querySelectorAll('th, td');
    var best = null;
    var bestDist = Infinity;
    for (var c = 0; c < cells.length; c++) {
      if (cells[c].closest('.tbl-align'))
        continue;
      var rect = cells[c].getBoundingClientRect();
      var dx = Math.max(rect.left - x, 0, x - rect.right);
      var dy = Math.max(rect.top - y, 0, y - rect.bottom);
      var dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = cells[c];
      }
    }
    return best;
  }

  // 单元格末尾必须落在最后一个可见文本节点之后、尾部 | 标记之前：
  // 落在标记之后会让新输入跑到 `|` 外面，重排时那一行会凭空多出一列。
  function caretInCellEnd(cell) {
    var nodes = editableTextNodes(cell);
    var range = document.createRange();
    if (!nodes.length) {
      // 空格子里没有可依附的可见文本：光标要放在尾部结构标记（| / \n）之前。
      // 放到单元格末尾（标记之后）时，新输入会写到分隔符外面，重排多出一列。
      var i = cell.childNodes.length;
      while (i > 0) {
        var prev = cell.childNodes[i - 1];
        if (prev.nodeType === 1 && prev.classList
            && (prev.classList.contains('mk-pipe') || prev.classList.contains('mk-nl')))
          i--;
        else
          break;
      }
      range.setStart(cell, i);
    } else {
      var last = nodes[nodes.length - 1];
      range.setStart(last, last.nodeValue.length);
    }
    range.collapse(true);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 光标必须落在单元格里：一旦落到表格外，后续输入会写进块级文本（甚至 <hr>
  // 外侧），原文就坏了。这里只兜底，不改变正常点击的位置。
  function ensureCellCaret(el) {
    var cell = activeCell(el);
    if (cell) {
      // 元素级光标停在单元格末尾（尾部 | 之后）同样会写坏原文：新输入会跑到
      // 分隔符外面，下次重排那一行就多出一列。收回到可见文本末尾。
      var selection = window.getSelection();
      var range = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (range && range.collapsed && range.startContainer === cell
          && range.startOffset >= cell.childNodes.length)
        caretInCellEnd(cell);
      return;
    }
    var first = el.querySelector('th, td');
    if (first)
      caretInCellEnd(first);
  }

  function ensureHrSource(el) {
    var src = el.querySelector('.hr-src');
    if (!src) {
      src = document.createElement('span');
      src.className = 'hr-src';
      src.textContent = el.dataset.raw || '';
      el.appendChild(src);
    }
    return src;
  }

  // 整篇重建（撤销/重做、源码→预览）后按块类型恢复光标；偏移一律是块原文口径
  function placeBlockCaret(el, start, end) {
    // 只给起点时按点光标处理：让 undefined 参与下面的减法会得到 NaN，范围与
    // 光标都会被算成 0（代码块里就表现为光标跳到块首）
    if (end === undefined || end === null)
      end = start;
    if (el.classList.contains('hr')) {
      var src = ensureHrSource(el);
      var hrLen = src.textContent.length;
      setSelectionRange(src, Math.max(0, Math.min(start, hrLen)), Math.max(0, Math.min(end, hrLen)));
      return;
    }
    if (isCodeBlock(el)) {
      // 快照里是 dataset.raw 口径（含围栏），换成 <code> 内偏移
      var code = codeEl(el);
      var prefix = codePrefixLength(el);
      var limit = code.textContent.length;
      setSelectionRange(code, Math.max(0, Math.min(start - prefix, limit)),
        Math.max(0, Math.min(end - prefix, limit)));
      return;
    }
    setSelectionRange(el, start, end);
    if (el.classList.contains('table'))
      ensureCellCaret(el);
  }

  function enterEdit(el) {
    if (el.classList.contains('editing'))
      return;
    el.classList.add('editing');

    if (inPlaceEditable(el)) {
      // 不重建内容。渲染态 DOM 原样进入编辑，标记/行号栏本来就常驻，
      // 因此进入某块只切换一个 class，不产生任何重排。
      var at = pendingOffset;
      pendingOffset = null;
      if (el.classList.contains('hr')) {
        // 横线保持原位，原文以绝对定位的淡色行叠在线上（不占高度）
        caretAtEdge(ensureHrSource(el), false);
        return;
      }
      if (isCodeBlock(el)) {
        var code = codeEl(el);
        if (!code)
          return;
        ensureLangBadge(el);
        var limit = code.textContent.length;
        setSelectionRange(code, at === null ? limit : Math.max(0, Math.min(at, limit)));
        return;
      }
      // 必须走 locateOffset（标记按零宽原子取整）：setCaret 会数进标记文本，
      // 点击行首时可能把光标塞进折叠标记里。
      if (el.classList.contains('table')) {
        if (at === null) {
          var cells = tableCellList(el);
          if (cells.length) {
            caretInCellEnd(cells[cells.length - 1]);
            return;
          }
        }
        setSelectionRange(el, at === null ? el.textContent.length
                                          : Math.max(0, Math.min(at, el.textContent.length)));
        ensureCellCaret(el);
        return;
      }
      setSelectionRange(el, at === null ? el.textContent.length
                                        : Math.max(0, Math.min(at, el.textContent.length)));
      return;
    }

    el.textContent = el.dataset.raw === undefined ? el.textContent : el.dataset.raw;
    var offset = pendingOffset === null ? el.textContent.length : pendingOffset;
    pendingOffset = null;
    setCaret(el, Math.max(0, Math.min(offset, el.textContent.length)));
  }

  function leaveEdit(el) {
    if (!el.classList.contains('editing'))
      return;
    // 撤销时整篇重建会把旧节点摘掉，focusout 可能在游离节点上触发
    if (!el.isConnected)
      return;
    if (isCodeBlock(el)) {
      // 编辑期间 DOM 一直保持渲染态（行号栏 + 高亮 span），离开只摘掉 class。
      // 组合输入若没来得及收尾，这里补一次同步，仍不重建整块结构。
      if (el._codeStale)
        syncCode(el, true);
      el.classList.remove('editing');
      commitHistory();
      scheduleTocRefresh();
      return;
    }
    if (el.classList.contains('hr') || el.classList.contains('table')) {
      // 编辑期间结构一直是渲染态（表格行/单元格/横线都在），离开时按 DOM 原文
      // 重排一次：表格对齐行回到隐藏行、单元格内新输入的 ** 等标记重新着色。
      renderBlock(el, el.textContent);
      commitHistory();
      scheduleTocRefresh();
      return;
    }
    renderBlock(el, el.textContent.replace(/\n+$/, ''));
    commitHistory();
    scheduleTocRefresh();
  }


  function splitBlock(el) {
    commitHistory();   // 先把分段前的状态固定为一个步骤

    var raw = el.textContent;
    var offset = caretOffset(el);
    var before = raw.slice(0, offset);
    var after = raw.slice(offset);

    renderBlock(el, before);

    var neo = document.createElement('div');
    neo.className = 'block';
    neo.setAttribute('contenteditable', 'true');
    root.insertBefore(neo, el.nextSibling);
    renderBlock(neo, after);
    neo.classList.add('editing');
    neo.focus();
    setCaret(neo, 0);
    scheduleDirty();
    commitHistory();   // 分段后的状态单独成一个步骤
    scheduleTocRefresh();
  }

  // 结构类型：只有类型相同的相邻块才允许合并。段落原文接进表格、标题、列表或
  // 引用的原文里会把结构写坏（表格会把段落文字并进最后一行末格）。
  function blockType(el) {
    if (isCodeBlock(el))
      return 'code';
    for (var level = 1; level <= 6; level++) {
      if (el.classList.contains('h' + level))
        return 'h' + level;
    }
    var kinds = ['table', 'ul', 'ol', 'quote', 'hr'];
    for (var i = 0; i < kinds.length; i++) {
      if (el.classList.contains(kinds[i]))
        return kinds[i];
    }
    return 'p';
  }

  function mergeBack(el) {
    var previous = el.previousElementSibling;
    if (!previous || !previous.classList.contains('block'))
      return;

    // 相邻块结构类型不同时不合并：两段原文直接拼接会得到坏 Markdown
    if (blockType(el) !== blockType(previous))
      return;

    // 代码块首行行首退格 → 与上一块合并。相邻也是代码块时合并正文（保留上一块
    // 的语言）；相邻是普通块时不把围栏塞进段落（那会得到坏 Markdown），保持不动。
    if (isCodeBlock(el)) {
      if (!isCodeBlock(previous))
        return;
      commitHistory();   // 合并前的状态单独成一个步骤
      var junction = codeText(previous).length;
      var joined = codeText(previous) + codeText(el);
      renderBlock(previous, codeRaw(previous, joined));
      normalizeCodeScrolls(previous);
      el.remove();
      previous.classList.add('editing');
      previous.focus();
      setSelectionRange(codeEl(previous), junction);
      scheduleDirty();
      commitHistory();
      scheduleTocRefresh();
      return;
    }

    commitHistory();   // 合并前的状态单独成一个步骤

    var previousRaw = previous.dataset.raw === undefined ? previous.textContent : previous.dataset.raw;
    var merged = previousRaw + el.textContent;
    el.remove();
    renderBlock(previous, merged);
    normalizeCodeScrolls(previous);
    previous.classList.add('editing');
    previous.focus();
    setCaret(previous, previousRaw.length);
    scheduleDirty();
    commitHistory();
    scheduleTocRefresh();
  }

  /* ---------------- 目录侧栏 ---------------- */

  function headingLevel(el) {
    for (var level = 1; level <= 6; level++) {
      if (el.classList.contains('h' + level))
        return level;
    }
    return 0;
  }

  function plainLabel(raw) {
    return String(raw)
      .replace(/^#+\s*/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`]/g, '')
      .trim();
  }

  // 标题锚点：按 GitHub 风格从标题文本生成 slug（保留中文，去标点，空格转 -），
  // 同名标题依次追加 -1、-2，这样 `#标题` 链接才能找到目标。
  function headingSlug(raw) {
    var text = plainLabel(raw).toLowerCase();
    text = text.replace(/[!"#$%&'()*+,.\/:;<=>?@\[\\\]^`{|}~]/g, '');
    text = text.replace(/[，。、：；！？（）【】《》「」『』—…·]/g, '');
    text = text.replace(/[\s\u3000]+/g, '-');
    return text.replace(/^-+|-+$/g, '');
  }

  function headingAnchors() {
    var map = {};
    var seen = {};
    if (mode !== 'wysiwyg')
      return map;
    for (var i = 0; i < root.children.length; i++) {
      var el = root.children[i];
      if (!el.classList || !el.classList.contains('block'))
        continue;
      if (!headingLevel(el))
        continue;
      // 锚点用渲染态原文算 slug：正在编辑的块 textContent 会带上零宽标记，
      // 直接取会把标记也算进 slug，导致跳转失灵
      var raw = el.dataset.raw || el.textContent;
      var slug = headingSlug(raw);
      if (!slug)
        continue;
      var count = seen[slug] || 0;
      seen[slug] = count + 1;
      var key = count ? slug + '-' + count : slug;
      if (!map[key])
        map[key] = el;
    }
    return map;
  }

  // 文档内锚点：命中就滚到对应标题，返回是否找到
  function scrollToAnchor(href) {
    var id = String(href || '').replace(/^#/, '');
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      // 非法的百分号编码：按字面值匹配
    }
    if (!id)
      return false;
    var map = headingAnchors();
    var target = map[id] || map[id.toLowerCase()];
    if (!target)
      return false;
    target.scrollIntoView({ block: 'start' });
    return true;
  }

  function tocData() {
    var items = [];
    if (mode !== 'wysiwyg')
      return items;
    for (var i = 0; i < root.children.length; i++) {
      var el = root.children[i];
      if (!el.classList || !el.classList.contains('block'))
        continue;
      var level = headingLevel(el);
      if (!level)
        continue;
      var raw = el.classList.contains('editing') ? el.textContent : (el.dataset.raw || '');
      items.push({ level: level, label: plainLabel(raw), el: el });
    }
    return items;
  }

  function refreshToc() {
    if (!tocVisible || !tocList) {
      tocSig = null;
      return;
    }
    var items = tocData();
    var sig = '';
    for (var k = 0; k < items.length; k++)
      sig += items[k].level + '|' + items[k].label + '\n';
    // 标题没变且原节点仍在文档里：只重算高亮，不重建 innerHTML
    if (sig === tocSig && items.length === tocItems.length
        && (!items.length || (tocItems[0].el && tocItems[0].el.isConnected))) {
      updateActiveHeading();
      return;
    }
    tocSig = sig;
    tocItems = items;
    var html = '';
    for (var i = 0; i < tocItems.length; i++) {
      var item = tocItems[i];
      html += '<a class="toc-item" data-toc="' + i + '" style="padding-left:'
        + (0.5 + (item.level - 1) * 0.75) + 'rem">' + escapeHtml(item.label) + '</a>';
    }
    tocList.innerHTML = html || '<div class="toc-empty">没有标题</div>';
    tocTops = null;
    updateActiveHeading();
  }

  function scheduleTocRefresh() {
    if (!tocVisible)
      return;
    if (tocTimer)
      clearTimeout(tocTimer);
    tocTimer = setTimeout(function () {
      tocTimer = null;
      refreshToc();
    }, 260);
  }

  // 以视口顶部往下 80px 为判定线：最后一个越过判定线的标题即“当前标题”。
  // 降级点：只在渲染态按块位置计算，编辑中的块尚未重排，滚动时可能滞后一帧。
  function tocOffsets() {
    if (tocTops && tocTops.length === tocItems.length)
      return tocTops;
    tocTops = [];
    for (var i = 0; i < tocItems.length; i++)
      tocTops.push(tocItems[i].el.getBoundingClientRect().top + window.scrollY);
    return tocTops;
  }

  function updateActiveHeading() {
    if (!tocVisible || !tocItems.length)
      return;
    var tops = tocOffsets();
    var y = window.scrollY + 80;
    // 最后一个 top <= y 的项；二分避免逐项读布局
    var lo = 0, hi = tops.length - 1, active = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tops[mid] <= y) {
        active = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    var nodes = tocList.querySelectorAll('.toc-item');
    for (var j = 0; j < nodes.length; j++)
      nodes[j].classList.toggle('active', j === active);
  }

  function toggleToc() {
    tocVisible = !tocVisible;
    document.body.classList.toggle('toc-open', tocVisible);
    // 先让侧栏出现，列表放到下一轮事件循环再建：900 个标题的构建约 40ms，
    // 同步做会把点击/快捷键那一帧顶住。
    if (tocVisible)
      setTimeout(function () { if (tocVisible) refreshToc(); }, 0);
    postView();
  }

  /* ---------------- 缩放与视图状态 ---------------- */

  function applyZoom() {
    document.documentElement.style.fontSize = (16.5 * zoomLevel).toFixed(2) + 'px';
  }

  // 主题只切换 CSS 变量（data-theme），不触碰 DOM 内容与尺寸：
  // 正文、代码高亮、目录、查找、浮层、状态栏颜色都走同一套变量。
  function setTheme(mode) {
    var el = document.documentElement;
    if (mode === 'dark' || mode === 'light')
      el.setAttribute('data-theme', mode);
    else
      el.removeAttribute('data-theme');
  }

  function clampZoom(value) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value * 100) / 100));
  }

  function setZoom(value) {
    var next = clampZoom(value);
    if (next === zoomLevel)
      return;
    zoomLevel = next;
    applyZoom();
    scheduleFindPaint();
    postView();
  }

  function postView() {
    post({
      type: 'view',
      toc: tocVisible,
      source: mode === 'source',
      zoom: zoomLevel
    });
  }

  function currentCaretOffset() {
    if (mode === 'source')
      return sourceEl.selectionStart;
    var el = blockOf(document.activeElement);
    if (!el || !el.classList.contains('editing'))
      return 0;
    var blocks = collectBlocks();
    return absoluteOffsets(blocks, editingSelection()).start;
  }

  function setMode(next) {
    if (next === mode)
      return;
    // 自建跨块选区只在渲染态有效：切模式前先收起覆盖层
    clearCrossSelection();
    // 查找/替换绑定当前模式的命中（DOM 区间或 textarea 区间），切模式前先关掉
    if (findBar)
      closeFind();
    closeLangMenu();
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    commitHistory();

    var text = currentSource();
    var caret = currentCaretOffset();

    suppressEvents = true;
    if (next === 'source') {
      mode = 'source';
      sourceEl.value = text;
      document.body.classList.add('source-mode');
      suppressEvents = false;
      try {
        sourceEl.focus();
        sourceEl.setSelectionRange(Math.min(caret, text.length), Math.min(caret, text.length));
      } catch (error) { /* ignore */ }
    } else {
      mode = 'wysiwyg';
      var layout = splitSourceLayout(text);
      var blocks = layout.blocks;
      mountBlocks(blocks, layout.gaps, layout.trail);
      document.body.classList.remove('source-mode');
      suppressEvents = false;

      var base = 0;
      for (var i = 0; i < blocks.length; i++) {
        base += gapBefore(layout.gaps, i);
        var stop = base + blocks[i].length;
        if (caret <= stop || i === blocks.length - 1) {
          var target = root.children[i];
          if (target) {
            if (inPlaceEditable(target)) {
              renderBlock(target, blocks[i]);
              target.classList.add('editing');
              target.focus();
              var rel = Math.max(0, caret - base);
              placeBlockCaret(target, rel, rel);
            } else {
              target.classList.add('editing');
              target.textContent = blocks[i];
              target.focus();
              setSelectionRange(target, Math.max(0, Math.min(caret - base, blocks[i].length)));
            }
          }
          break;
        }
        base = stop;
      }
    }

    // 同一份文本：这里只同步选区，不会新增撤销步骤
    commitHistory();
    scheduleDirty();
    refreshToc();
    postView();
  }

  /* ---------------- 标记标签避让 ---------------- */

  var liveFrame = 0;

  function clearLiveMarkers() {
    var nodes = root.querySelectorAll('.mk.mk-live');
    for (var i = 0; i < nodes.length; i++)
      nodes[i].classList.remove('mk-live');
  }

  // 相邻标记（如 **粗** 紧挨 *斜*）的淡色标签会重叠。标签本身绝对定位、零宽，
  // 不参与任何排版；因此只让离光标最近的一个标记显示标签，其余保持隐藏：
  // 无论多密集都不会叠字，也不会改变行高、宽度或块坐标。
  function updateLiveMarker() {
    if (!INLINE_PROTO || composing)
      return;
    clearLiveMarkers();
    var el = blockOf(document.activeElement);
    if (!el || !el.classList.contains('editing'))
      return;
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return;
    var range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer))
      return;
    var markers = el.querySelectorAll('.mk');
    if (!markers.length)
      return;
    var caret = offsetIn(el, range.startContainer, range.startOffset);
    if (caret < 0)
      return;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < markers.length; i++) {
      var mk = markers[i];
      var index = Array.prototype.indexOf.call(mk.parentNode.childNodes, mk);
      var start = offsetIn(el, mk.parentNode, index);
      if (start < 0)
        continue;
      var end = start + mk.textContent.length;
      var dist = caret < start ? start - caret : (caret > end ? caret - end : 0);
      if (dist < bestDist) {
        bestDist = dist;
        best = mk;
      }
      if (!dist)
        break;
    }
    if (best)
      best.classList.add('mk-live');
  }

  function scheduleLiveMarker() {
    if (!INLINE_PROTO || liveFrame)
      return;
    // 用定时器而不是 rAF：拖选时 selectionchange 很密，节流到一帧即可；
    // 窗口在后台/锁屏时 rAF 可能不跑，定时器仍能保证标签状态正确。
    liveFrame = setTimeout(function () {
      liveFrame = 0;
      updateLiveMarker();
    }, 16);
  }

  document.addEventListener('selectionchange', scheduleLiveMarker);

  /* ---------------- DOM 事件 ---------------- */

  // 点击渲染态时记录光标大致位置，切到源码态后尽量落在同一处
  document.addEventListener('mousedown', function (event) {
    // 任何一次按下都结束自建跨块选区：原生选区接管，覆盖层不能残留
    clearCrossSelection();
    var el = blockOf(event.target);
    if (!el || !document.caretRangeFromPoint) {
      pendingOffset = null;
      return;
    }

    // 语言徽标：单击打开语言选择器，不进入代码编辑态。捕获阶段 preventDefault
    // 后原生不会把焦点/光标挪进徽标；下拉挂在 body 上，不受代码块 overflow 影响。
    var badgeHit = isCodeBlock(el) && event.target.closest
      ? event.target.closest('.code-lang') : null;
    if (badgeHit) {
      event.preventDefault();
      pendingOffset = null;
      openLangMenu(el, badgeHit);
      return;
    }

    // 行号栏不可编辑：点它时把光标放到同一行的代码行首，绝不让光标落进栏里
    // （否则接下来的输入会写进行号栏或 <pre> 外层，结构会坏）。
    var gutter = isCodeBlock(el) && event.target.closest ? event.target.closest('.gutter') : null;
    if (gutter) {
      event.preventDefault();
      var code = codeEl(el);
      if (!code)
        return;
      var offset = codeLineStart(code, gutterLineAt(gutter, event.clientY));
      if (el.classList.contains('editing')) {
        setSelectionRange(code, offset);
      } else {
        pendingOffset = offset;
        el.focus();
      }
      return;
    }

    // 表格：点在格线、边框或格内标记上时，光标必须收回单元格里
    if (INLINE_PROTO && el.classList.contains('table')) {
      var tableHit = document.caretRangeFromPoint(event.clientX, event.clientY);
      var hitNode = tableHit ? tableHit.startContainer : null;
      var hitParent = hitNode ? (hitNode.nodeType === 1 ? hitNode : hitNode.parentNode) : null;
      var cell = hitParent && hitParent.closest ? hitParent.closest('th,td') : null;
      if (cell && cell.closest('.tbl-align'))
        cell = null;
      if (!cell) {
        var nearest = cellFromPoint(el, event.clientX, event.clientY);
        if (nearest) {
          event.preventDefault();
          if (!el.classList.contains('editing')) {
            pendingOffset = null;
            el.focus();
          }
          caretInCellEnd(nearest);
        }
        return;
      }
    }

    // 分隔线：点到横线本身（而不是叠在上面的原文）时，光标放回原文行尾
    if (INLINE_PROTO && el.classList.contains('hr') && el.classList.contains('editing')) {
      var hrSrc = el.querySelector('.hr-src');
      var hrHit = document.caretRangeFromPoint(event.clientX, event.clientY);
      var inSource = hrSrc && hrHit
        && (hrSrc === hrHit.startContainer || hrSrc.contains(hrHit.startContainer));
      if (hrSrc && !inSource) {
        event.preventDefault();
        caretAtEdge(hrSrc, false);
        return;
      }
    }

    if (el.classList.contains('editing')) {
      // 代码块已经在编辑态时，点在块内空白处（行号栏右侧、代码下方）可能让
      // 光标落到 <pre>/块外，后续输入会写坏结构：这里把光标收回 <code> 末尾。
      if (isCodeBlock(el) && document.caretRangeFromPoint) {
        var inner = codeEl(el);
        var hitRange = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (inner && hitRange && hitRange.startContainer !== inner
            && !inner.contains(hitRange.startContainer)) {
          event.preventDefault();
          setSelectionRange(inner, inner.textContent.length);
        }
      }
      pendingOffset = null;
      return;
    }
    var range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (!range) {
      pendingOffset = null;
      return;
    }
    // 代码块只统计 <code> 正文，行号栏的数字不能算进偏移
    var scope = isCodeBlock(el) ? codeEl(el) : el;
    if (!scope) {
      pendingOffset = null;
      return;
    }
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch (error) {
      pendingOffset = null;
      return;
    }
    pendingOffset = prefix.toString().length;
  }, true);

  root.addEventListener('focusin', function (event) {
    if (composing || suppressEvents)
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    enterEdit(el);
  });

  root.addEventListener('focusout', function (event) {
    if (suppressEvents)
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    if (event.relatedTarget && el.contains(event.relatedTarget))
      return;
    leaveEdit(el);
  });

  // 任务复选框：按下时阻止聚焦与选区折叠，点击只切换该行的勾选标记。
  root.addEventListener('mousedown', function (event) {
    var box = event.target;
    // 复制按钮不抢焦点：preventDefault 后选区/光标都留在原处，既不会把代码块
    // 切进编辑态，也不会触发 focusin 里的编辑流程。
    if (box && box.closest && box.closest('.code-copy')) {
      event.preventDefault();
      return;
    }
    if (box && box.classList && box.classList.contains('task-check'))
      event.preventDefault();
  });

  root.addEventListener('click', function (event) {
    var target = event.target;
    var copyBtn = target && target.closest ? target.closest('.code-copy') : null;
    if (copyBtn) {
      event.preventDefault();
      copyCodeBlock(copyBtn);
      return;
    }
    var anchor = target && target.closest ? target.closest('a.md-link') : null;
    if (anchor) {
      // 链接永远不让 WebView 自己导航：普通点击只落到「进入编辑」，
      // Cmd/Ctrl+Click 交给外壳决定（浏览器 / 应用内打开 .md）。
      event.preventDefault();
      var href = anchor.getAttribute('data-href') || anchor.getAttribute('href') || '';
      // 文档内锚点自己跳，不交给外壳：外壳没有标题锚点，只会提示「暂不支持」
      if (href.charAt(0) === '#') {
        if (!scrollToAnchor(href))
          post({ type: 'status', message: '锚点链接 ' + href + ' 未找到对应标题' });
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        post({ type: 'openLink', href: href });
      }
      return;
    }
    var box = target;
    if (!box || !box.classList || !box.classList.contains('task-check'))
      return;
    event.preventDefault();
    toggleTaskCheckbox(box);
  });

  root.addEventListener('input', function (event) {
    if (suppressEvents)
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    if (findBar)
      scheduleFind();
    if (isCodeBlock(el)) {
      // 徽标被原生删除（整块选中后删除）：语义等于清空语言，补回空徽标，
      // 用户可再点开选择器重选；徽标不可编辑，光标放回正文首行。
      if (!el.querySelector('.code-lang')) {
        el.dataset.lang = '';
        el.dataset.raw = codeRaw(el);
        var revived = ensureLangBadge(el);
        var codeStart = codeEl(el);
        if (revived && codeStart)
          setSelectionRange(codeStart, 0);
        scheduleDirty();
        scheduleCommit();
        return;
      }
      if (composing) {
        // 组合输入期间不重建 DOM（会打断输入法），只同步原文；结构等
        // compositionend 再一次性整理，光标位置交给输入法自己维护。
        el.dataset.raw = codeRaw(el, codeText(el));
        el._codeStale = true;
        return;
      }
      // 只重建 <code> 的行内 span，文本、字体、行高、宽度都不变；随后恢复光标
      syncCode(el, true);
      scheduleDirty();
      scheduleCommit();
      return;
    }
    if (composing)
      return;
    el.dataset.raw = el.textContent;
    updatePlaceholder();
    handleSlashInput(el);
    scheduleDirty();
    scheduleCommit();
    scheduleTocRefresh();
  });

  // 组合输入期间不落历史步骤，也不设置合并定时器；compositionend 时整段提交，
  // 这样中文候选上屏要么整体进入一步，要么整体回退，不会被切成多个碎片。
  root.addEventListener('compositionstart', function () {
    if (suppressEvents)
      return;
    // 组合输入不在原型范围，但也不能「选了却没删」：先按整篇源码删掉跨块选区，
    // 候选上屏就落在替换点上；若输入法因此中断，用户重新输入即可。
    if (crossSel)
      replaceCrossSelection('');
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    commitHistory();   // 组合输入前的已输入内容先单独成步
    composing = true;
  });

  root.addEventListener('compositionend', function (event) {
    composing = false;
    var el = blockOf(event.target);
    if (el) {
      if (isCodeBlock(el))
        syncCode(el, true);   // 上屏后补一次着色，会话期间没有动过 DOM 结构
      else
        el.dataset.raw = el.textContent;
      scheduleDirty();
    }
    commitHistory();   // 上屏内容整体作为一步
  });

  // 源码模式：textarea 自己的原生撤销也会被 beforeinput 拦下，统一走自建栈
  sourceEl.addEventListener('input', function () {
    if (suppressEvents)
      return;
    if (findBar)
      scheduleFind();
    scheduleDirty();
    scheduleCommit();
    scheduleTocRefresh();
  });

  sourceEl.addEventListener('compositionstart', function () {
    if (suppressEvents)
      return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    commitHistory();
    composing = true;
  });

  sourceEl.addEventListener('compositionend', function () {
    composing = false;
    commitHistory();
  });

  sourceEl.addEventListener('paste', function (event) {
    var clipboard = event.clipboardData || window.clipboardData;
    var picture = clipboard ? clipboardImageFile(clipboard) : null;
    if (picture) {
      // 源码态没有渲染节点：仍先落盘，由原生回调 insertImage 插到 textarea 光标处
      event.preventDefault();
      postImageFile(picture, 'paste');
      return;
    }
    commitHistory();
    setTimeout(commitHistory, 0);
  });

  // 撤销/重做挂到 document 上，未聚焦任何块时也能用；并拦住 WebKit 自带的
  // 原生撤销，避免和自建历史各走一套
  document.addEventListener('beforeinput', function (event) {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo')
      event.preventDefault();
    // 跨块选区上的输入：折叠光标只覆盖焦点一个字符，必须先按整篇源码替换区间
    if (crossSel && !suppressEvents && mode === 'wysiwyg') {
      if (event.inputType === 'insertText' && typeof event.data === 'string') {
        event.preventDefault();
        replaceCrossSelection(event.data);
        return;
      }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
        replaceCrossSelection('\n');
        return;
      }
      // 其余输入类型不由这里接管：先收起自建选区，避免原生操作折叠光标
      clearCrossSelection();
    }
    // 表格单元格内输入裸 |：转成转义的 \|，否则下次重排会被当成列分隔符、
    // 把整表撑出多余一列。渲染时 \| 显示为 |（反斜杠零宽），raw 保留转义。
    if (event.inputType === 'insertText' && event.data === '|' && !suppressEvents) {
      var el = blockOf(event.target);
      if (el && el.classList.contains('table') && activeCell(el)) {
        event.preventDefault();
        document.execCommand('insertText', false, '\\|');
      }
    }
  }, true);

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (composing)
        return;
      var key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey)
          redo();
        else
          undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        post({ type: 'save', text: currentSource() });
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        post({ type: 'open' });
        return;
      }
    }
  }, true);

  // 原型模式：标记是 contenteditable=false 的原子对象，退格/删除一旦作用到它
  // 就会只删掉一半 * 或 `，留下坏结构。这里判断光标与标记之间是否“没有可见字符”，
  // 是则把光标移到标记另一侧，绝不删除标记本身。
  function collapseAt(node, atStart) {
    var range = document.createRange();
    if (atStart)
      range.setStartBefore(node);
    else
      range.setStartAfter(node);
    range.collapse(true);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 任务标记（[ ] / [x]）在编辑态是可见文本，用户可以像普通文字一样用键盘
  // 改写它；其余标记仍是不可编辑的原子对象，方向键/退格不进入。
  function editableMarker(mk) {
    return !!(mk && mk.classList && mk.classList.contains('mk-task'));
  }

  function markerAdjacent(el, direction) {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (!range.collapsed)
      return null;
    var markers = el.querySelectorAll('.mk');
    for (var i = 0; i < markers.length; i++) {
      var mk = markers[i];
      if (editableMarker(mk))
        continue;
      // compareBoundaryPoints 的参数方向容易搞反，这里用两个折叠 Range +
      // comparePoint 明确表达“光标在标记起点/终点的哪一侧”。
      var edge = document.createRange();
      if (direction < 0)
        edge.setStartAfter(mk);
      else
        edge.setStartBefore(mk);
      edge.collapse(true);
      var side;
      try {
        side = edge.comparePoint(range.startContainer, range.startOffset);
      } catch (error) {
        continue;
      }
      if (direction < 0) {
        if (side < 0)      // 光标在标记终点之前：标记不在退格方向上
          continue;
      } else if (side > 0) { // 光标在标记起点之后：标记不在删除方向上
        continue;
      }
      var probe = document.createRange();
      try {
        if (direction < 0) {
          probe.setStartAfter(mk);
          probe.setEnd(range.startContainer, range.startOffset);
        } else {
          probe.setStart(range.startContainer, range.startOffset);
          probe.setEndBefore(mk);
        }
      } catch (error) {
        continue;
      }
      if (probe.toString() === '')
        return mk;
    }
    return null;
  }

  function caretInsideMarker() {
    var selection = window.getSelection();
    if (!selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== 3)
      return null;
    var node = range.startContainer;
    var mk = node.parentNode && node.parentNode.closest ? node.parentNode.closest('.mk') : null;
    return editableMarker(mk) ? null : mk;
  }

  // 标记（contenteditable=false 的原子对象）紧贴光标时，WebKit 的原生退格/删除
  // 会“什么都不做”。这种情况由这里直接删掉标记另一侧的可见字符，再补发 input，
  // 让 dataset.raw / 脏标记 / 历史栈走与原生输入完全相同的路径。
  function editableTextNodes(el) {
    var out = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (node.parentNode.closest && node.parentNode.closest('.mk'))
        continue;
      out.push(node);
    }
    return out;
  }

  // 标记不可见，退格/删除的语义应当是“删掉它另一侧的可见字符”。但只允许跨
  // 同一条行内流：中间有 <br>、或落进另一个 li / 引用段，就放弃，免得误删
  // 上一行或上一项。
  function lineRoot(node) {
    var el = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    while (el && el.nodeType === 1) {
      if (el.nodeName === 'LI' || el.nodeName === 'BLOCKQUOTE' || el.nodeName === 'TD'
          || el.nodeName === 'TH' || (el.classList && el.classList.contains('block')))
        return el;
      el = el.parentNode;
    }
    return null;
  }

  function sameFlow(node, mk, backward) {
    if (lineRoot(node) !== lineRoot(mk))
      return false;
    var span = document.createRange();
    try {
      if (backward) {          // node 在标记左侧：node 末尾 → 标记起点
        span.setStart(node, node.nodeValue.length);
        span.setEnd(mk, 0);
      } else {                 // node 在标记右侧：标记起点 → node 开头
        span.setStart(mk, 0);
        span.setEnd(node, 0);
      }
    } catch (error) {
      return false;
    }
    var fragment = span.cloneContents();
    return !(fragment.querySelector && fragment.querySelector('br'));
  }

  function deleteVisibleChar(el, range, backward, mk) {
    var nodes = editableTextNodes(el);
    var i, node, probe;
    if (backward) {
      for (i = nodes.length - 1; i >= 0; i--) {
        node = nodes[i];
        probe = document.createRange();
        probe.selectNodeContents(node);
        if (!node.nodeValue.length || probe.compareBoundaryPoints(Range.END_TO_END, range) > 0)
          continue;
        if (mk && !sameFlow(node, mk, true))
          continue;
        node.nodeValue = node.nodeValue.slice(0, node.nodeValue.length - 1);
        var caret = document.createRange();
        caret.setStart(node, node.nodeValue.length);
        caret.collapse(true);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(caret);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return true;
      }
      return false;
    }
    for (i = 0; i < nodes.length; i++) {
      node = nodes[i];
      probe = document.createRange();
      probe.selectNodeContents(node);
      if (!node.nodeValue.length || probe.compareBoundaryPoints(Range.START_TO_START, range) < 0)
        continue;
      if (mk && !sameFlow(node, mk, false))
        continue;
      node.nodeValue = node.nodeValue.slice(1);
      var after = document.createRange();
      after.setStart(node, 0);
      after.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(after);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  /* ---------------- 上下方向键跨块 ----------------
     每个块是独立的 contenteditable，WebKit 在块首/块尾会停住。这里只在
     「光标位于块的第一/最后一可视行」时接管，把光标搬到相邻块对应位置；
     其余情况交回原生，块内逐行移动、表格/代码块内部导航都不受影响。 */

  // 导航作用域：代码块只看 <code>（行号栏不参与），普通块就是块本身。
  function navScope(el) {
    return isCodeBlock(el) ? codeEl(el) : el;
  }

  // 取 scope 内首/末一个「可见字符」的矩形。折叠 Range 在 WebKit 里常是 0×0，
  // 所以量真实字符；零宽标记、行号栏、语言徽标与隐藏的对齐行都要跳过。
  function textCharRect(scope, atEnd) {
    if (!scope)
      return null;
    var nodes = [];
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var host = node.parentNode;
      if (host && host.closest && host.closest('.mk, .gutter, .code-lang, .tbl-align'))
        continue;
      if (node.nodeValue)
        nodes.push(node);
    }
    if (!nodes.length)
      return null;
    node = nodes[atEnd ? nodes.length - 1 : 0];
    var len = node.nodeValue.length;
    var range = document.createRange();
    if (atEnd) {
      range.setStart(node, len - 1);
      range.setEnd(node, len);
    } else {
      range.setStart(node, 0);
      range.setEnd(node, Math.min(1, len));
    }
    var rect = range.getBoundingClientRect();
    if (rect && (rect.height > 0.5 || rect.width > 0.5))
      return rect;
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].height > 0.5 || rects[i].width > 0.5)
        return rects[i];
    }
    return null;
  }

  // 块内首行（atEnd=false）/末行（atEnd=true）的文字矩形。用块内首/末字符取，
  // 比 getBoundingClientRect 更贴近文字本身，不受块上下 padding 影响。
  function contentEdgeRect(el, atEnd) {
    if (el.classList.contains('hr'))
      return textCharRect(el.querySelector('.hr-src'), atEnd);
    if (el.classList.contains('table')) {
      var cells = tableCellList(el);
      if (!cells.length)
        return null;
      for (var i = 0; i < cells.length; i++) {
        var rect = textCharRect(cells[atEnd ? cells.length - 1 - i : i], atEnd);
        if (rect)
          return rect;
      }
      return null;
    }
    return textCharRect(navScope(el), atEnd);
  }

  // 当前折叠光标的文字矩形；取不到时返回 null，由调用方退化为字符偏移判断。
  // WebKit 对折叠 Range 常返回 0×0：改为量光标旁边那个字符的矩形，上下边与
  // 所在行一致，横向位置按光标在该字符左/右取 left/right。
  function caretRectOfSelection() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return null;
    var range = selection.getRangeAt(0);
    if (!range.collapsed) {
      var whole = range.getBoundingClientRect();
      return whole && (whole.height > 0.5 || whole.width > 0.5) ? whole : null;
    }
    var node = range.startContainer;
    var offset = range.startOffset;
    try {
      if (node.nodeType === 3 && node.nodeValue.length) {
        var from = Math.min(offset, node.nodeValue.length - 1);
        var probe = document.createRange();
        probe.setStart(node, from);
        probe.setEnd(node, from + 1);
        var rect = probe.getBoundingClientRect();
        if (rect && (rect.height > 0.5 || rect.width > 0.5)) {
          return {
            left: offset < node.nodeValue.length ? rect.left : rect.right,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height
          };
        }
      } else if (node.nodeType === 1 && node.childNodes.length) {
        // 元素容器（空块等）：用光标后一个子节点，没有就取前一个
        var anchor = node.childNodes[Math.min(offset, node.childNodes.length - 1)]
          || node.childNodes[Math.max(0, offset - 1)];
        if (anchor && anchor.nodeType === 1) {
          var box = anchor.getBoundingClientRect();
          if (box && (box.height > 0.5 || box.width > 0.5))
            return box;
        }
      }
    } catch (error) { /* ignore */ }
    return null;
  }

  // 光标是否在本块首行（up）/末行（down）。
  function caretAtBlockEdge(el, up, caret) {
    var line = contentEdgeRect(el, !up);
    if (caret && line) {
      var height = line.height || 20;
      return up
        ? caret.top <= line.top + height * 0.5
        : caret.bottom >= line.bottom - height * 0.5;
    }
    var scope = navScope(el) || el;
    return up ? caretOffset(el) === 0 : caretOffset(el) >= scope.textContent.length;
  }

  // 投点是否落在目标块可编辑范围内（表格必须落进单元格，代码块必须落进 <code>）。
  function pointInNavScope(el, node) {
    if (!node)
      return false;
    if (el.classList.contains('table')) {
      var parent = node.nodeType === 1 ? node : node.parentNode;
      var cell = parent && parent.closest ? parent.closest('th,td') : null;
      return !!(cell && el.contains(cell) && !cell.closest('.tbl-align'));
    }
    if (el.classList.contains('hr')) {
      var src = el.querySelector('.hr-src');
      return !!(src && (node === src || src.contains(node)));
    }
    var scope = navScope(el) || el;
    return node === scope || scope.contains(node);
  }

  // 目标块落点：优先按原光标的横向位置投到目标块的末行/首行；投不到时回退到
  // 结构上的块尾/块首（表格落单元格、代码落 <code>、分隔线落原文行）。
  function placeCaretInBlock(target, up, x) {
    if (target.classList.contains('hr')) {
      var src = ensureHrSource(target);
      setSelectionRange(src, up ? src.textContent.length : 0);
      return;
    }
    var line = contentEdgeRect(target, up);
    if (x !== null && line && document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(x, line.top + line.height * 0.5);
      if (range && pointInNavScope(target, range.startContainer)) {
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    }
    if (target.classList.contains('table')) {
      var cells = tableCellList(target);
      if (!cells.length)
        return;
      if (up)
        caretInCellEnd(cells[cells.length - 1]);
      else
        caretAtEdge(cells[0], true);
      return;
    }
    var scope = navScope(target);
    if (scope)
      setSelectionRange(scope, up ? scope.textContent.length : 0);
  }

  // 在相邻块之间搬光标；返回 false 表示不该接管（还在块内、或已是首/末块）。
  function moveCaretAcrossBlock(el, up) {
    var target = up ? el.previousElementSibling : el.nextElementSibling;
    while (target && !(target.classList && target.classList.contains('block')))
      target = up ? target.previousElementSibling : target.nextElementSibling;
    if (!target)
      return false;

    var caret = caretRectOfSelection();
    if (!caretAtBlockEdge(el, up, caret))
      return false;

    var x = caret ? caret.left : null;
    target.focus();   // focusin → enterEdit；INLINE_PROTO 下不重排
    placeCaretInBlock(target, up, x);
    return true;
  }

  /* ---------------- 跨块 Shift+方向键选区（原型） ----------------
     每个块是独立 contenteditable，WebKit 会把跨块的 Selection.extend() 夹回原
     块，原生选区跨不出块。这里自建一份「整篇绝对偏移」选区状态，用 body 上的
     覆盖层画高亮；原生选区只保留焦点处的折叠光标，保证光标可见、滚动与输入法
     正常。偏移口径与撤销栈一致：blockStartOffset + 块内 raw 偏移。

     范围只在 Shift+↑/↓ 时建立/扩展；点击、Esc、普通按键、撤销重建、打开查找、
     切源码模式都会清除。原型边界：鼠标拖选、Shift+←/→、输入法组合输入、跨表格
     单元格的精细边界都不接管，遇到时回退到原生单块行为。 */

  var crossSel = null;        // { anchor, focus, goalX }，整篇绝对字符偏移
  var crossLayer = null;      // 覆盖层（position:absolute，挂在 body）
  var crossAnnounced = false; // 与外壳同步的「是否有跨块选区」状态

  function dropCrossLayer() {
    if (crossLayer && crossLayer.parentNode)
      crossLayer.parentNode.removeChild(crossLayer);
    crossLayer = null;
  }

  function ensureCrossLayer() {
    if (!crossLayer) {
      crossLayer = document.createElement('div');
      crossLayer.id = 'cross-layer';
      crossLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(crossLayer);
    }
    return crossLayer;
  }

  // 状态变化才回报：macOS 菜单的复制/剪切在折叠选区下会被 WebKit 判成「不可
  // 复制」，需要外壳改走 EditorController::clipboardCommand 这条回路。
  function announceCross() {
    var active = !!crossSel;
    if (active === crossAnnounced)
      return;
    crossAnnounced = active;
    post({ type: 'crossSelection', active: active });
  }

  function clearCrossSelection() {
    if (!crossSel)
      return;
    crossSel = null;
    dropCrossLayer();
    announceCross();
  }

  // 第 index 块在整篇里的字符长度与起点（与撤销栈同一口径）
  function blockAbsoluteSpan(blocks, gaps, index) {
    var base = blockStartOffset(blocks, gaps, index);
    return { base: base, stop: base + blocks[index].length };
  }

  // 区间里是否真的有块正文：块间空白处投点得到的「只跨过空行」区间画不出任何
  // 高亮，扩展时要跳过这种落点，继续往下一可视行找。
  function crossRangeCoversText(from, to) {
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var base = 0;
    for (var i = 0; i < blocks.length && base < to; i++) {
      var span = blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      if (span.stop > span.base
          && Math.min(to, span.stop) > Math.max(from, span.base))
        return true;
      base = span.stop;
    }
    return false;
  }

  function absoluteOf(el, node, offset) {
    var list = blockList();
    var index = list.indexOf(el);
    if (index < 0)
      return null;
    var blocks = collectBlocks();
    var gaps = collectGaps();
    return blockStartOffset(blocks, gaps, index) + rawOffsetAtPoint(el, node, offset);
  }

  // 块内某个 DOM 点 → 块内 raw 偏移（代码块补上围栏前缀）
  function rawOffsetAtPoint(el, node, offset) {
    var scope = navScope(el) || el;
    var prefix = document.createRange();
    prefix.selectNodeContents(scope);
    try {
      prefix.setEnd(node, offset);
    } catch (error) {
      return 0;
    }
    return prefix.toString().length + (isCodeBlock(el) ? codePrefixLength(el) : 0);
  }

  // 块内 raw 区间 → Range。分隔线没有可量测的文字，原型里不画它的高亮。
  function crossBlockRange(el, start, end) {
    if (!el || el.classList.contains('hr'))
      return null;
    var scope = navScope(el);
    if (!scope)
      return null;
    var prefix = isCodeBlock(el) ? codePrefixLength(el) : 0;
    var limit = scope.textContent.length;
    var from = Math.max(0, Math.min(start - prefix, limit));
    var to = Math.max(0, Math.min(end - prefix, limit));
    if (to <= from)
      return null;
    var a = locateOffset(scope, from);
    var b = locateOffset(scope, to);
    var range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (error) {
      return null;
    }
    return range;
  }

  // 逐块切开绝对区间取客户矩形，画成覆盖层色块（不插入任何正文节点）
  function paintCrossSelection() {
    if (!crossSel) {
      dropCrossLayer();
      return;
    }
    var from = Math.min(crossSel.anchor, crossSel.focus);
    var to = Math.max(crossSel.anchor, crossSel.focus);
    if (from === to) {
      dropCrossLayer();
      return;
    }
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var list = blockList();
    var layer = ensureCrossLayer();
    while (layer.firstChild)
      layer.removeChild(layer.firstChild);
    var base = 0;
    for (var i = 0; i < blocks.length && base < to; i++) {
      var span = blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      var lo = Math.max(from, span.base);
      var hi = Math.min(to, span.stop);
      if (hi > lo) {
        var range = crossBlockRange(list[i], lo - span.base, hi - span.base);
        var rects = range ? range.getClientRects() : [];
        for (var r = 0; r < rects.length; r++) {
          if (rects[r].width <= 0.5 || rects[r].height <= 0.5)
            continue;
          var box = document.createElement('div');
          box.className = 'cross-hit';
          box.style.left = (rects[r].left + window.scrollX) + 'px';
          box.style.top = (rects[r].top + window.scrollY) + 'px';
          box.style.width = rects[r].width + 'px';
          box.style.height = rects[r].height + 'px';
          layer.appendChild(box);
        }
      }
      base = span.stop;
    }
  }

  // 投点是否落在可编辑正文里：行号栏、语言徽标与工具条都不是正文
  function crossHitNodeOk(el, node) {
    if (!node || !pointInNavScope(el, node))
      return false;
    var host = node.nodeType === 1 ? node : node.parentNode;
    if (host && host.closest && host.closest('.gutter, .code-lang, .code-tools'))
      return false;
    return true;
  }

  function blockAtAbsolute(abs) {
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var at = locateBlock(blocks, gaps, abs);
    return { el: blockList()[at.index] || null, index: at.index, start: at.start };
  }

  // 量某个 DOM 点旁边那个字符的矩形（WebKit 的折叠 Range 常是 0×0）。
  // 用来判断投点是否真的换了一可视行，而不是同一行内横向漂移。
  function pointCharRect(node, offset, forward) {
    if (!node || node.nodeType !== 3 || !node.nodeValue.length)
      return null;
    var index = forward
      ? Math.min(offset, node.nodeValue.length - 1)
      : Math.max(0, offset - 1);
    var range = document.createRange();
    try {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
    } catch (error) {
      return null;
    }
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].height > 0.5)
        return rects[i];
    }
    return null;
  }

  // 从焦点光标往 up/down 走一可视行。优先按目标列投点（caretRangeFromPoint），
  // 投不到（块间空白比一行宽、目标在视口外）时退到相邻块的首/末行。
  function moveCrossFocus(up) {
    if (!crossSel)
      return false;
    var at = blockAtAbsolute(crossSel.focus);
    var el = at.el;
    if (!el)
      return false;
    var caret = caretRectOfSelection();
    var line = caret || contentEdgeRect(el, up);
    if (!line)
      return false;
    var height = line.height || 20;
    var x = typeof crossSel.goalX === 'number' ? crossSel.goalX : line.left;
    var startY = up ? line.top : line.bottom;
    // 块上下有内边距/外边距（代码块尤其高）：投点要够远才能落到下一块的正文行
    var limit = Math.max(32, height * 5);
    var hit = null;
    if (document.caretRangeFromPoint) {
      for (var d = 1; d <= limit; d += 2) {
        var probe = document.caretRangeFromPoint(x, up ? startY - d : startY + d);
        if (!probe)
          continue;
        var node = probe.startContainer;
        var target = blockOf(node);
        if (!target || !crossHitNodeOk(target, node))
          continue;
        var abs = absoluteOf(target, node, probe.startOffset);
        // 只认「按方向真正前进」的落点：块内边距里投点会得到更靠后的坐标，
        // 反向落点会让选区原地打转
        if (abs === null || (up ? abs >= crossSel.focus : abs <= crossSel.focus))
          continue;
        // 同一可视行内的投点只是横向漂移（行尾/行首），不算换行
        var charRect = pointCharRect(node, probe.startOffset, !up);
        if (charRect && (up ? charRect.bottom > line.top + 1 : charRect.top < line.bottom - 1))
          continue;
        // 块间空白处的投点只会得到「跨过空行」的区间，画不出高亮：继续往下找
        if (!crossRangeCoversText(crossSel.focus, abs))
          continue;
        hit = { el: target, range: probe, abs: abs };
        break;
      }
    }
    if (!hit) {
      var next = up ? el.previousElementSibling : el.nextElementSibling;
      while (next && !(next.classList && next.classList.contains('block')))
        next = up ? next.previousElementSibling : next.nextElementSibling;
      if (!next)
        return false;
      next.focus();   // 视口外时由焦点滚动带进视野
      placeCaretInBlock(next, up, x);
      var selection = window.getSelection();
      if (!selection.rangeCount)
        return false;
      var settled = selection.getRangeAt(0);
      var settledAbs = absoluteOf(next, settled.startContainer, settled.startOffset);
      if (settledAbs === null)
        return false;
      hit = { el: next, range: settled.cloneRange(), abs: settledAbs };
    }
    if (document.activeElement !== hit.el)
      hit.el.focus();
    var range = window.getSelection();
    range.removeAllRanges();
    range.addRange(hit.range);
    crossSel.focus = hit.abs;
    return true;
  }

  // Shift+↑/↓：块首/块尾才升级成跨块选区；升级后一直由这里接管，直到清除
  function extendCrossSelection(el, up) {
    if (mode !== 'wysiwyg' || !el.classList.contains('editing'))
      return false;
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return false;
    var range = selection.getRangeAt(0);
    if (!crossSel) {
      var caret = caretRectOfSelection();
      if (!caretAtBlockEdge(el, up, caret))
        return false;
      var index = blockList().indexOf(el);
      if (index < 0)
        return false;
      var blocks = collectBlocks();
      var gaps = collectGaps();
      var base = blockStartOffset(blocks, gaps, index);
      var anchorAbs, focusAbs;
      if (range.collapsed) {
        anchorAbs = focusAbs = base + rawOffsetAtPoint(el, range.startContainer, range.startOffset);
      } else {
        // 原生单块选区升格：锚点取 anchor 端，焦点取 focus 端；随后把原生选区
        // 收成焦点处的折叠光标，高亮整段交给覆盖层
        anchorAbs = base + rawOffsetAtPoint(el, selection.anchorNode, selection.anchorOffset);
        focusAbs = base + rawOffsetAtPoint(el, selection.focusNode, selection.focusOffset);
        var collapsed = document.createRange();
        try {
          collapsed.setStart(selection.focusNode, selection.focusOffset);
          collapsed.collapse(true);
          selection.removeAllRanges();
          selection.addRange(collapsed);
        } catch (error) { /* ignore */ }
        caret = caretRectOfSelection();
      }
      crossSel = {
        anchor: anchorAbs,
        focus: focusAbs,
        goalX: caret ? caret.left : null
      };
    }
    moveCrossFocus(up);
    if (crossSel.anchor === crossSel.focus)
      clearCrossSelection();
    else
      paintCrossSelection();
    announceCross();
    return true;
  }

  function crossBounds() {
    if (!crossSel)
      return null;
    return {
      from: Math.min(crossSel.anchor, crossSel.focus),
      to: Math.max(crossSel.anchor, crossSel.focus)
    };
  }

  // 跨块选区的纯文本：逐块裁剪后按块拼接，口径与原生复制一致
  function crossSelectionPlainText() {
    var bounds = crossBounds();
    if (!bounds || bounds.from === bounds.to)
      return '';
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var list = blockList();
    var parts = [];
    var base = 0;
    for (var i = 0; i < blocks.length && base < bounds.to; i++) {
      var span = blockAbsoluteSpan(blocks, gaps, i);
      base = span.base;
      var lo = Math.max(bounds.from, span.base);
      var hi = Math.min(bounds.to, span.stop);
      if (hi <= lo || !list[i] || list[i].classList.contains('hr')) {
        base = span.stop;
        continue;
      }
      var range = crossBlockRange(list[i], lo - span.base, hi - span.base);
      parts.push(range ? cleanCopyFragment(range.cloneContents()) : '');
      base = span.stop;
    }
    return parts.join('\n');
  }

  // 用 insert 替换跨块选区：整篇源码拼接后一次重建（一步撤销），光标落到替换末尾
  function replaceCrossSelection(insert) {
    var bounds = crossBounds();
    if (!bounds)
      return false;
    var text = currentSource();
    var from = Math.max(0, Math.min(bounds.from, text.length));
    var to = Math.max(0, Math.min(bounds.to, text.length));
    var next = text.slice(0, from) + insert + text.slice(to);
    crossSel = null;
    dropCrossLayer();
    announceCross();
    // 改动前的整篇状态先入栈：撤销要回到「选区还在」的那一步
    commitHistory();
    var landed = rebuildFromSourceText(next, from + insert.length);
    if (landed && landed.block) {
      landed.block.classList.add('editing');
      landed.block.focus();
      placeBlockCaret(landed.block, landed.offset);
    }
    return true;
  }

  /* ---------------- 鼠标拖选跨块（原型） ----------------
     原生拖选同样出不了块：指针移出锚点块后交给自建选区。锚点在按下时按投点
     记住，之后每次移动只更新 focus；原生选区收成焦点处的折叠光标，高亮由
     覆盖层画。松手后选区保留，可直接删除/输入/复制，与 Shift+方向键同一套
     状态与清除时机。 */

  var dragCross = null;       // { anchor, el, x, y, goalX }
  var dragScrollTimer = 0;
  var DRAG_EDGE = 24;         // 距视口上下边缘多近开始自动滚动
  var DRAG_STEP = 18;

  function stopDragScroll() {
    if (dragScrollTimer) {
      clearInterval(dragScrollTimer);
      dragScrollTimer = 0;
    }
  }

  // 指针处的落点；行号栏/语言徽标/工具条不算正文
  function crossHitAt(x, y) {
    if (!document.caretRangeFromPoint)
      return null;
    var range = document.caretRangeFromPoint(x, y);
    if (!range)
      return null;
    var el = blockOf(range.startContainer);
    if (!el || !crossHitNodeOk(el, range.startContainer))
      return null;
    var abs = absoluteOf(el, range.startContainer, range.startOffset);
    if (abs === null)
      return null;
    return { el: el, range: range, abs: abs };
  }

  // 原生选区收成焦点处的折叠光标：焦点块先 focus（触发 enterEdit），再落点
  function collapseAtCrossHit(hit) {
    if (document.activeElement !== hit.el)
      hit.el.focus();
    var selection = window.getSelection();
    if (!selection)
      return;
    selection.removeAllRanges();
    selection.addRange(hit.range);
  }

  function dragScrollTick() {
    if (!dragCross) {
      stopDragScroll();
      return;
    }
    var y = dragCross.y;
    var step = y < DRAG_EDGE ? -DRAG_STEP
      : (y > window.innerHeight - DRAG_EDGE ? DRAG_STEP : 0);
    if (!step) {
      stopDragScroll();
      return;
    }
    var before = window.scrollY;
    window.scrollBy(0, step);
    if (window.scrollY === before) {
      stopDragScroll();
      return;
    }
    updateCrossDrag(dragCross.x, y);
  }

  function updateCrossDrag(x, y) {
    if (!dragCross)
      return;
    dragCross.x = x;
    dragCross.y = y;
    // 拖到视口上下边缘时自己滚：原生拖选的自动滚动已经被折叠光标打断
    if (y < DRAG_EDGE || y > window.innerHeight - DRAG_EDGE) {
      if (!dragScrollTimer)
        dragScrollTimer = setInterval(dragScrollTick, 60);
    } else {
      stopDragScroll();
    }
    var hit = crossHitAt(x, Math.max(0, Math.min(y, window.innerHeight - 1)));
    if (!hit)
      return;
    if (!crossSel) {
      // 还在锚点块内：交回原生拖选，越出锚点块才升格
      if (hit.el === dragCross.el)
        return;
      crossSel = { anchor: dragCross.anchor, focus: hit.abs, goalX: dragCross.goalX };
      announceCross();
    } else if (hit.abs === crossSel.anchor) {
      clearCrossSelection();
      return;
    }
    crossSel.focus = hit.abs;
    collapseAtCrossHit(hit);
    paintCrossSelection();
  }

  // 在冒泡阶段记录锚点：块内的特殊按下（徽标、行号栏、表格格线）已经
  // preventDefault，不能再起拖选
  document.addEventListener('mousedown', function (event) {
    dragCross = null;
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey
        || mode !== 'wysiwyg')
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    var hit = crossHitAt(event.clientX, event.clientY);
    if (!hit || hit.el !== el)
      return;
    dragCross = {
      anchor: hit.abs,
      el: el,
      x: event.clientX,
      y: event.clientY,
      goalX: event.clientX
    };
  });

  document.addEventListener('mousemove', function (event) {
    if (!dragCross || event.buttons !== 1)
      return;
    updateCrossDrag(event.clientX, event.clientY);
  });

  document.addEventListener('mouseup', function () {
    if (!dragCross)
      return;
    dragCross = null;
    stopDragScroll();
  });

  root.addEventListener('keydown', function (event) {
    var el = blockOf(event.target);
    if (!el)
      return;

    // 组合输入（中文等）期间按键属于输入法：方向键选候选、回车/Esc 上屏或取消，
    // 一个都不能被下面的浮层或块级逻辑吃掉。判断必须放在最前面。
    if (composing)
      return;

    // 斜杠浮层打开时先吃掉导航键：上下选择、Enter/Tab 插入、Esc 删除已输入的 /
    if (slashState) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSlash(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertSlashItem();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        slashState.end = caretOffset(slashState.el);
        closeSlash(true);
        return;
      }
    }

    // 跨块选区（原型）：编辑键先在整篇源码上生效，避免落到折叠光标上只改一个字符
    var plainKeys = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (crossSel) {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        replaceCrossSelection('');
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceCrossSelection('\n');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clearCrossSelection();
        return;
      }
    }

    // Shift+↑/↓ 扩展选区：块首/块尾升级为跨块选区，之后由覆盖层显示
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && event.shiftKey && plainKeys
        && extendCrossSelection(el, event.key === 'ArrowUp')) {
      event.preventDefault();
      return;
    }

    // 横向/翻页/制表键会让原生选区离开覆盖层范围：先收起，交回原生。
    // 普通字符键不能在这里清除：输入要经过 beforeinput 才能按整篇源码替换选区。
    if (crossSel && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                     || event.key === 'Home' || event.key === 'End'
                     || event.key === 'PageUp' || event.key === 'PageDown'
                     || event.key === 'Tab'
                     || ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey)))
      clearCrossSelection();

    // 上下方向键跨块：只在块首/块尾接管，块内与表格/代码块内部导航保持原生。
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      var navSelection = window.getSelection();
      if (navSelection && navSelection.rangeCount
          && navSelection.getRangeAt(0).collapsed
          && el.contains(navSelection.getRangeAt(0).startContainer)
          && moveCaretAcrossBlock(el, event.key === 'ArrowUp')) {
        event.preventDefault();
        return;
      }
    }

    var inTable = el.classList.contains('table');

    if (inTable && event.key === 'Tab') {
      event.preventDefault();
      moveTableCell(el, event.shiftKey ? -1 : 1);
      return;
    }

    if (inTable && event.key === 'Enter') {
      // Cmd/Ctrl+Enter 在当前行下方加一行、加 Shift 在上方加一行（光标落新行
      // 同列首格）；裸回车既不新增行也不插入换行，避免一次误触改掉表格结构。
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && !event.altKey)
        insertTableRow(el, !event.shiftKey);
      return;
    }

    if (inTable && (event.key === 'Backspace' || event.key === 'Delete')) {
      var tableSel = window.getSelection();
      if (tableSel.rangeCount && !tableSel.getRangeAt(0).collapsed
          && rangeCrossesCells(el, tableSel.getRangeAt(0))) {
        event.preventDefault();
        clearSelectedCellText(el, tableSel.getRangeAt(0));
        return;
      }
      if (atCellEdge(el, event.key === 'Backspace', event))
        return;
    }

    if (INLINE_PROTO && (event.key === 'Backspace' || event.key === 'Delete')) {
      var backward = event.key === 'Backspace';
      var neighbour = markerAdjacent(el, backward ? -1 : 1);
      if (neighbour) {
        event.preventDefault();
        // 标记不可见：直接删掉它另一侧同一行内的可见字符，而不是把光标停在
        // 标记边上（那样看起来像没反应）。跨行/跨列表项时退回“跨过标记”。
        var caret = window.getSelection().getRangeAt(0);
        var prefix = neighbour.classList.contains('mk-head')
          || neighbour.classList.contains('mk-bullet')
          || neighbour.classList.contains('mk-quote');
        if (!prefix && deleteVisibleChar(el, caret, backward, neighbour))
          return;
        collapseAt(neighbour, backward);
        return;
      }
      // 标记在光标前方挡住原生删除时，自己删掉光标另一侧的可见字符。
      // 删不动也必须 preventDefault：原生删除会紧贴着 contenteditable=false
      // 的原子对象执行，可能把它或相邻结构一起带走。
      var blocking = markerAdjacent(el, backward ? 1 : -1);
      if (blocking) {
        event.preventDefault();
        var range = window.getSelection().getRangeAt(0);
        deleteVisibleChar(el, range, backward, blocking);
        return;
      }
    }

    if (INLINE_PROTO && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // 正常方向键会跳过零宽原子；只有程序化选区落进标记内部时才需要纠正。
      var inside = caretInsideMarker();
      if (inside) {
        event.preventDefault();
        collapseAt(inside, event.key === 'ArrowLeft');
        return;
      }
      // 块首（或行首）紧贴不可编辑原子对象时，WebKit 的左/右箭头会原地不动，
      // 光标看起来“卡”在折叠标记边上。这里显式跨过紧贴光标的标记。
      var adjacent = markerAdjacent(el, event.key === 'ArrowLeft' ? -1 : 1);
      if (adjacent) {
        event.preventDefault();
        collapseAt(adjacent, event.key === 'ArrowLeft');
        return;
      }
    }

    if (event.key === 'Enter') {
      if (isCodeBlock(el)) {
        // 代码块里的回车只加一行，不切块；Shift+Enter 同样按换行处理
        event.preventDefault();
        if (insertCodeText(el, '\n')) {
          scheduleDirty();
          scheduleCommit();
        }
        return;
      }
      if (!event.shiftKey) {
        event.preventDefault();
        splitBlock(el);
        return;
      }
    }

    // 表格单元格外没有“块首”这个概念：光标停在首格行首时不能把整张表并进
    // 上一段（caretOffset(el) 会恰好等于 0）。
    if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !inTable
        && caretOffset(el) === 0
        && el.previousElementSibling && el.previousElementSibling.classList.contains('block')) {
      event.preventDefault();
      mergeBack(el);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  }, true);

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

  // 选区 → 纯文本。块与块之间必须补一个换行：textContent 会把相邻块的文字
  // 直接粘在一起（跨两段复制曾得到「第一段第二段」）。块内仍按复制规则清理。
  // 复制、剪切与右键菜单共用这一个口径。
  function selectionPlainText() {
    // 自建跨块选区：原生选区是折叠的，必须按绝对区间自己取文本
    if (crossSel)
      return crossSelectionPlainText();
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return '';
    var range = selection.getRangeAt(0);
    var blocks = selectedBlocks();
    var parts = [];
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var sub = document.createRange();
      sub.selectNodeContents(el);
      if (el.contains(range.startContainer))
        sub.setStart(range.startContainer, range.startOffset);
      if (el.contains(range.endContainer))
        sub.setEnd(range.endContainer, range.endOffset);
      parts.push(cleanCopyFragment(sub.cloneContents()));
    }
    return parts.join('\n');
  }

  // 块内真正的语义元素（h1/ul/pre…）。段落块没有内层元素，包装时用 <p>。
  function blockSemantic(el) {
    if (!el || !el.querySelector)
      return null;
    return el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, ' +
                             ':scope > h5, :scope > h6, :scope > p, :scope > ul, ' +
                             ':scope > ol, :scope > blockquote, :scope > pre, ' +
                             ':scope > table');
  }

  // 外部应用没有本页 CSS，只靠 class 拿不到标题字号与列表符号，必须把计算样式
  // 内联。WKWebView 写剪贴板时会保留 style 属性、丢掉 class，这层正好兜住。
  var COPY_STYLE_PROPS = ['font-size', 'font-weight', 'font-style', 'font-family',
                          'color', 'text-decoration', 'list-style-type',
                          'margin-top', 'margin-bottom', 'padding-left',
                          'white-space', 'background-color'];

  function applyCopyStyle(source, target) {
    if (!source || !window.getComputedStyle || !target.style)
      return;
    var cs = window.getComputedStyle(source);
    for (var i = 0; i < COPY_STYLE_PROPS.length; i++) {
      var value = cs.getPropertyValue(COPY_STYLE_PROPS[i]);
      if (value)
        target.style.setProperty(COPY_STYLE_PROPS[i], value);
    }
  }

  // 代码高亮全靠 class，外部应用没有本页样式表，复制出去会退化成单色。
  // 克隆内容与原文按文档顺序一一对应，因此可以直接把每个 token 的计算颜色
  // 内联到克隆节点；与父级同色的 token（本来就没有专用颜色）保持继承，不硬造。
  function inlineCodeTokenColors(source, sub, shell) {
    if (!source || !source.querySelectorAll || !shell || !shell.querySelectorAll
        || !window.getComputedStyle || !sub)
      return;
    var candidates = source.querySelectorAll('[class*="tok-"]');
    var originals = [];
    for (var i = 0; i < candidates.length; i++) {
      if (sub.intersectsNode(candidates[i]))
        originals.push(candidates[i]);
    }
    var clones = shell.querySelectorAll('[class*="tok-"]');
    if (!originals.length || originals.length !== clones.length)
      return;
    for (var j = 0; j < originals.length; j++) {
      var own = window.getComputedStyle(originals[j]).color;
      var parentEl = originals[j].parentElement;
      var inherited = parentEl ? window.getComputedStyle(parentEl).color : '';
      if (own && own !== inherited)
        clones[j].style.color = own;
    }
  }

  // 选区 → HTML。与纯文本同口径（按块裁剪、跨块逐个取），但保留块级语义，
  // 粘到 Word / 邮件 / TextEdit 里仍有标题层级、列表符号与代码块的样子。
  // 复制走 HTML 是给“粘到外部应用”用的；粘回 Mote 仍只读 text/plain。
  function selectionHtml() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return '';
    var range = selection.getRangeAt(0);
    var blocks = selectedBlocks();
    var holder = document.createElement('div');
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var sub = document.createRange();
      sub.selectNodeContents(el);
      if (el.contains(range.startContainer))
        sub.setStart(range.startContainer, range.startOffset);
      if (el.contains(range.endContainer))
        sub.setEnd(range.endContainer, range.endOffset);
      var fragment = sub.cloneContents();
      var inner = blockSemantic(el);
      var only = fragment.childNodes.length === 1 ? fragment.firstChild : null;
      var shell;
      // 整块选中时 cloneContents 已经带出内层语义标签（<h1>、<ul>…），不能再套
      // 一层；否则外壳要按语义元素重建。早先拿外层块 div 当外壳，内层 <h1> 不在
      // 选区里，HTML 里只剩 <div class="block h1">，外部应用拿不到标题层级。
      if (inner && only && only.nodeType === 1 && only.nodeName === inner.nodeName) {
        shell = only;
      } else {
        shell = document.createElement(inner ? inner.tagName.toLowerCase() : 'p');
        shell.appendChild(fragment);
      }
      applyCopyStyle(inner || el, shell);
      inlineCodeTokenColors(el, sub, shell);
      holder.appendChild(shell);
    }
    sanitizeCopyHtml(holder);
    return holder.innerHTML;
  }

  // 编辑器专用节点与属性对粘贴目标没有意义，甚至会把 contenteditable 一起带过去。
  function sanitizeCopyHtml(holder) {
    // 零宽标记（#、-、反引号等）在编辑器里靠 font-size:0 藏起来，粘到 Word /
    // 邮件时没有这份 CSS 就会原样露出来，必须连同 gutter 一起剥掉。
    var junk = holder.querySelectorAll('.mk, .gutter, .line-numbers, .code-tools, .code-lang');
    for (var i = junk.length - 1; i >= 0; i--) {
      if (junk[i].parentNode)
        junk[i].parentNode.removeChild(junk[i]);
    }
    var all = holder.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var e = all[j];
      e.removeAttribute('contenteditable');
      e.removeAttribute('spellcheck');
      e.removeAttribute('id');
      var attrs = e.attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        if (attrs[k].name.indexOf('data-') === 0)
          e.removeAttribute(attrs[k].name);
      }
      if (e.classList) {
        e.classList.remove('editing', 'focused', 'placeholder', 'empty');
        if (!e.classList.length)
          e.removeAttribute('class');
      }
    }
    // 行内代码在页内靠 CSS 取等宽字体，复制出去只剩 <code> 语义；Word 的 HTML
    // 导入不认 UA 默认等宽，会把它并进正文东亚字体（实测变宋体），这里显式内联
    // 等宽字体栈。代码块（<pre> 内）本来就有自己的样式，不动。
    var codes = holder.querySelectorAll('code');
    for (var c = 0; c < codes.length; c++) {
      if (!codes[c].closest || !codes[c].closest('pre'))
        codes[c].style.setProperty('font-family', 'Menlo, Consolas, monospace');
    }
  }

  // 「有没有可复制 / 可剪切的内容」的唯一判定：空段落块会算出 "\n"，因此纯空白
  // 一律视为没有内容。这里只做判断、不改写文本本身——选中含前后空白的真实文本
  // 仍按原样复制，不会因为判空白顺带 trim 掉用户内容。
  function clipboardTextIsBlank(text) {
    return !text || !text.trim();
  }

  // 原生 copy 事件：只在编辑区接管，源码模式交给 textarea 自己。
  // text/plain 给粘回 Mote 与纯文本编辑器；text/html 给 Word / 邮件这类目标，
  // macOS 由 WebKit 落到 NSPasteboard 的 public.html，Windows 由宿主写 CF_HTML。
  document.addEventListener('copy', function (event) {
    if (!event.clipboardData || mode === 'source')
      return;
    var text = selectionPlainText();
    if (clipboardTextIsBlank(text)) {
      // 不写剪贴板：否则空段落块的 "\n" 会覆盖用户上一次复制的内容
      event.preventDefault();
      post({ type: 'status', message: '没有可复制的内容：先选中文字' });
      return;
    }
    event.clipboardData.setData('text/plain', text);
    var html = selectionHtml();
    if (html)
      event.clipboardData.setData('text/html', html);
    event.preventDefault();
  });

  // 剪切事件：macOS 走 AppKit 的 cut: 时进入这里（Windows 由宿主直接调
  // clipboardCopy）。纯空白选区要连同删除一起取消，两个平台行为才一致。
  document.addEventListener('cut', function (event) {
    if (mode === 'source')
      return;
    if (crossSel) {
      // 原生选区是折叠的，WebKit 不会自己剪切：算好文本写剪贴板再删区间
      event.preventDefault();
      var crossText = crossSelectionPlainText();
      if (event.clipboardData && !clipboardTextIsBlank(crossText))
        event.clipboardData.setData('text/plain', crossText);
      replaceCrossSelection('');
      return;
    }
    if (!clipboardTextIsBlank(selectionPlainText()))
      return;
    event.preventDefault();
    post({ type: 'status', message: '没有可剪切的内容：先选中文字' });
  });

  /* ---------------- 查找 / 替换（Cmd+F） ----------------
     高亮用「覆盖层」画：用 Range.getClientRects() 取每个命中的几何，把绝对定位的
     色块盖在上面（#find-layer 挂在 body、pointer-events:none）。文档里不插入任何
     节点，所以 dataset.raw / textContent 一字不变；关闭时覆盖层与查找条一起从 DOM
     移除，不留任何元素。覆盖层不占排版，块几何不受影响。

     命中集合按文档顺序生成：块顺序 → 表格单元格顺序 → 单元格内下标顺序，
     跨块连续编号、连续跳转，正着/反着都能绕回。查找文本是「整篇可见文本」：
     每个块各占一段，块与块之间用一个虚拟换行连接；查询里用 ⌥↩ 输入换行，
     命中就可以从上一块跨到下一块。表格单元格之间、分隔线两侧用不可匹配的
     哨兵隔开，所以命中不会跨单元格，也不会跨过分隔线。

     大小写：两边统一转小写再比对；中文与全角标点不受影响。不做正则、不做整词、
     不做空白归一化（连续空格要按原样输入）。

     替换是「按原文偏移改 dataset.raw，再整块重排」：标记结构、代码围栏、表格
     管道都由 renderBlock 从新原文重建，撤销栈记一步（整篇快照）。块内命中可以
     跨文本节点：只要起点/终点都在行内格式之外，区间里的 **、`、[ 等要么没有，
     要么是完整的行内结构，替换后 Markdown 仍然合法（行内格式会随区间一起被
     替换掉）。起点或终点落在 <strong>/<em>/<a>/`<code>` 内部时仍拒绝，避免留下
     不成对的标记。替换文本含换行 / 表格里的 | / 代码里的 ``` 也拒绝。跨块命中
     走整篇源码重建：允许替换文本含换行，但两端或中间夹着代码块、表格、分隔线
     时拒绝，避免把围栏或列结构改坏。

     焦点：查找期间输入焦点留在查找框；wysiwyg 编辑态跳转会把焦点交给命中的块并
     选中该词（先 focus 触发 enterEdit，再覆盖选区）。此时 Enter/Shift+Enter 仍由
     文档级监听接管为「下一个/上一个」。源码模式（Cmd+E）没有 DOM 高亮层，跳转时
     把焦点交给 textarea 并选中命中（原生选区即是高亮），其余命中只计数。

     关闭时若跳转过，光标留在最后一个命中；没跳转过就回到打开查找前的原位置。 */

  var findBar = null, findInput = null, findReplace = null;
  var findCount = null, findNote = null, findLayer = null;
  var findMatches = [], findActive = -1, findTimer = 0, findNoteTimer = 0;
  var findPaintFrame = 0;       // 合并同一帧内的多次重画请求
  var findCaret = null;         // 打开查找前的原光标
  var findJumped = null;        // 最近一次跳转到的命中
  var findInSource = false;     // 本轮命中是 sourceEl.value 上的区间

  function findRuns(block) {
    var runs = [];
    function collect(scope) {
      var nodes = [];
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        var host = node.parentNode;
        if (!host || !host.closest)
          continue;
        if (host.closest('.mk, .gutter, .code-lang, .tbl-align'))
          continue;
        if (!node.nodeValue)
          continue;
        nodes.push(node);
      }
      if (!nodes.length)
        return;
      var text = '';
      var table = [];
      for (var i = 0; i < nodes.length; i++) {
        table.push({ node: nodes[i], start: text.length });
        text += nodes[i].nodeValue;
      }
      runs.push({ text: text, nodes: table });
    }

    if (isCodeBlock(block)) {
      var code = codeEl(block);
      if (code)
        collect(code);
      return runs;
    }
    if (block.classList && block.classList.contains('table')) {
      var cells = block.querySelectorAll('th,td');
      for (var c = 0; c < cells.length; c++) {
        if (cells[c].closest('.tbl-align'))
          continue;
        collect(cells[c]);
      }
      return runs;
    }
    collect(block);
    return runs;
  }

  // 段内字符下标 → DOM 点（同一段内的节点共享一个连续字符串）。
  // 边界必须区分「起点」和「终点」：下标正好落在两个文本节点的接缝上时，
  // 起点取后一个节点的 0，终点取前一个节点的末尾；否则一个落在单个 token
  // 内部的命中会被算成跨节点区间，替换会被误判为「跨着色边界」，
  // Range 也会把多出来的后半段一起高亮。
  function findPoint(run, index, isEnd) {
    var nodes = run.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var start = nodes[i].start;
      var len = nodes[i].node.nodeValue.length;
      if (isEnd ? index <= start + len : index < start + len)
        return { node: nodes[i].node, offset: index - start };
    }
    if (isEnd) {
      var last = nodes[nodes.length - 1];
      return { node: last.node, offset: last.node.nodeValue.length };
    }
    var head = nodes[0];
    return { node: head.node, offset: 0 };
  }

  function dropFindLayer() {
    if (findLayer && findLayer.parentNode)
      findLayer.parentNode.removeChild(findLayer);
    findLayer = null;
  }

  function ensureFindLayer() {
    if (!findLayer) {
      findLayer = document.createElement('div');
      findLayer.id = 'find-layer';
      findLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(findLayer);
    }
    return findLayer;
  }

  function findRects(match) {
    var rects = match.range.getClientRects();
    var out = [];
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].width > 0.5 && rects[i].height > 0.5)
        out.push(rects[i]);
    }
    return out;
  }

  function paintFind() {
    if (findInSource || !findMatches.length) {
      dropFindLayer();
      return;
    }
    var layer = ensureFindLayer();
    while (layer.firstChild)
      layer.removeChild(layer.firstChild);
    for (var i = 0; i < findMatches.length; i++) {
      var rects = findRects(findMatches[i]);
      for (var r = 0; r < rects.length; r++) {
        var box = document.createElement('div');
        box.className = 'find-hit' + (i === findActive ? ' active' : '');
        box.style.left = (rects[r].left + window.scrollX) + 'px';
        box.style.top = (rects[r].top + window.scrollY) + 'px';
        box.style.width = rects[r].width + 'px';
        box.style.height = rects[r].height + 'px';
        layer.appendChild(box);
      }
    }
  }

  // 排版一变（缩放、图片解码完成、字体替换）命中矩形就过期，但这三种情况下都
  // 不会触发 window resize：统一合并到下一帧重画，避免一次操作里重复计算。
  function scheduleFindPaint() {
    if (!findLayer || !findMatches.length || findPaintFrame)
      return;
    findPaintFrame = requestAnimationFrame(function () {
      findPaintFrame = 0;
      if (findLayer && findMatches.length)
        paintFind();
    });
  }

  function updateFindCount() {
    if (!findCount)
      return;
    findCount.textContent = findMatches.length
      ? (findActive + 1) + '/' + findMatches.length
      : '0/0';
  }

  function setFindNote(text) {
    if (!findNote)
      return;
    if (findNoteTimer) {
      clearTimeout(findNoteTimer);
      findNoteTimer = 0;
    }
    findNote.textContent = text || '';
    findNote.style.display = text ? 'inline' : 'none';
    if (text) {
      findNoteTimer = setTimeout(function () {
        findNoteTimer = 0;
        if (findNote) {
          findNote.textContent = '';
          findNote.style.display = 'none';
        }
      }, 4200);
    }
  }

  // 整篇可见文本：每个块占一段，块与块之间用一个虚拟换行连接；表格单元格之间、
  // 分隔线两侧用不可匹配的 \0 隔开。返回全文与文本段索引（at 为段在全文中的起点），
  // 命中下标 → 段 → DOM 点都靠这张表。
  function findBuildDocument() {
    var blocks = blockList();
    var parts = [];
    var chunks = [];
    var length = 0;
    function sep(ch) {
      chunks.push(ch);
      length += ch.length;
    }
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      if (block.classList.contains('hr')) {
        if (length)
          sep('\0');
        continue;
      }
      var runs = findRuns(block);
      for (var r = 0; r < runs.length; r++) {
        if (length)
          sep(r === 0 ? '\n' : '\0');
        parts.push({ at: length, run: runs[r], block: block });
        chunks.push(runs[r].text);
        length += runs[r].text.length;
      }
    }
    return { text: chunks.join(''), parts: parts };
  }

  // 全文字符下标 → 所在文本段；落在分隔符或越界时返回 null（跨分隔符的命中跳过）。
  function findPartAt(parts, index) {
    var lo = 0, hi = parts.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (parts[mid].at <= index) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0)
      return null;
    var part = parts[found];
    if (index >= part.at + part.run.text.length)
      return null;
    return part;
  }

  function findScanBlocks(query, needle) {
    var doc = findBuildDocument();
    var text = doc.text;
    var hay = text.toLowerCase();
    var use = needle;
    // 少数语言的小写映射会改变长度（如 İ），那会打乱偏移，退回区分大小写
    if (hay.length !== text.length) {
      hay = text;
      use = query;
    }
    var from = 0;
    var at;
    while ((at = hay.indexOf(use, from)) >= 0) {
      var last = at + use.length - 1;
      var head = findPartAt(doc.parts, at);
      var tail = findPartAt(doc.parts, last);
      if (head && tail) {
        var range = document.createRange();
        try {
          var a = findPoint(head.run, at - head.at, false);
          var z = findPoint(tail.run, last - tail.at + 1, true);
          range.setStart(a.node, a.offset);
          range.setEnd(z.node, z.offset);
          findMatches.push({
            range: range,
            block: head.block,
            endBlock: tail.block,
            cross: head.run !== tail.run,
            startRun: head.run,
            startIndex: at,
            endIndex: at + use.length
          });
        } catch (error) { /* 跳过无法落到 DOM 的命中 */ }
      }
      from = at + Math.max(1, use.length);
    }
  }

  function findScanSource(query, needle) {
    var text = sourceEl.value;
    var hay = text.toLowerCase();
    var use = needle;
    if (hay.length !== text.length) {
      hay = text;
      use = query;
    }
    var from = 0;
    var at;
    while ((at = hay.indexOf(use, from)) >= 0) {
      findMatches.push({ source: true, start: at, end: at + use.length });
      from = at + Math.max(1, use.length);
    }
  }

  function findScan(query) {
    findMatches = [];
    findActive = -1;
    findInSource = mode === 'source';
    if (!query) {
      dropFindLayer();
      updateFindCount();
      return;
    }
    var needle = query.toLowerCase();
    if (findInSource)
      findScanSource(query, needle);
    else
      findScanBlocks(query, needle);
    if (!findMatches.length) {
      dropFindLayer();
      updateFindCount();
      return;
    }
    findActive = 0;
    paintFind();
    updateFindCount();
  }

  // 命中落在代码块的横向滚动区里时，先把它横向带进可视区（否则高亮在屏幕外）
  function revealFindMatch(match, rect) {
    var node = match.range.startContainer;
    var host = node.nodeType === 1 ? node : node.parentNode;
    var scroller = host && host.closest ? host.closest('.code-scroll') : null;
    if (!scroller || !rect)
      return;
    var box = scroller.getBoundingClientRect();
    if (rect.left < box.left)
      scroller.scrollLeft -= (box.left - rect.left) + 24;
    else if (rect.right > box.right)
      scroller.scrollLeft += (rect.right - box.right) + 24;
  }

  // 跨块选区横跨多个 contenteditable，WebKit 的选区行为不确定；跳转时只选
  // 起点块内的那一段，高亮层仍然画完整命中。
  function findSelectRange(match) {
    var range = match.range.cloneRange();
    if (match.cross && match.startRun) {
      var tail = findPoint(match.startRun, match.startRun.text.length, true);
      try {
        range.setEnd(tail.node, tail.offset);
      } catch (error) { /* 起点段已失效时保持整段选区 */ }
    }
    return range;
  }

  // 编辑态跳转：先让块进入就地编辑（enterEdit 会先把光标放到块尾），再把选区
  // 覆盖成命中范围。enterEdit 是同步的，先 focus 后设选区，落点才是命中本身；
  // 反过来先设选区会被 enterEdit 的 setSelectionRange 覆盖掉。
  function applyFindCaret(match) {
    var block = blockOf(match.range.startContainer) || match.block;
    if (!block || !block.isConnected || !match.range.startContainer.isConnected)
      return false;
    if (document.activeElement !== block)
      block.focus();
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(findSelectRange(match));
    return true;
  }

  function scrollSourceTo(start) {
    var line = sourceEl.value.slice(0, start).split('\n').length;
    var lineHeight = parseFloat(getComputedStyle(sourceEl).lineHeight) || 22;
    var visible = sourceEl.clientHeight / lineHeight;
    sourceEl.scrollTop = Math.max(0, (line - visible / 2) * lineHeight);
  }

  function goFind(delta) {
    if (!findMatches.length)
      return;
    findActive = (findActive + delta + findMatches.length) % findMatches.length;
    var match = findMatches[findActive];

    if (findInSource) {
      sourceEl.focus();
      try {
        sourceEl.setSelectionRange(match.start, match.end);
      } catch (error) { /* ignore */ }
      scrollSourceTo(match.start);
      findJumped = match;
      updateFindCount();
      return;
    }

    var rects = findRects(match);
    if (rects.length) {
      window.scrollBy(0, rects[0].top - window.innerHeight * 0.38);
      revealFindMatch(match, rects[0]);
    }
    // 覆盖层用「视口矩形 + 滚动量」换算成文档坐标；代码块内部横向滚动不改变
    // 文档滚动量，所以必须等横向滚动落定后再画。
    paintFind();
    var wantCaret = !!findCaret || !!root.querySelector('.block.editing');
    if (wantCaret && applyFindCaret(match))
      findJumped = match;
    updateFindCount();
  }

  /* ---- 替换：命中 → 整篇原文的绝对区间 ---- */

  // 命中边界落在行内格式内部时，整段替换会把外侧的开标记留下、把闭标记删掉，
  // 产生不成对的 ** / ` / [ 等。代码块不适用这条：高亮会把一行拆成多个 span，
  // 但 raw 仍是连续的，跨 span 替换是安全的。
  var FIND_INLINE_HOSTS = {
    STRONG: 1, EM: 1, DEL: 1, S: 1, A: 1, CODE: 1,
    MARK: 1, SUP: 1, SUB: 1, KBD: 1, SPAN: 1
  };

  function findBoundarySafe(block, node) {
    if (isCodeBlock(block))
      return true;
    var current = node && node.nodeType === 3 ? node.parentNode : node;
    while (current && current !== block) {
      if (current.nodeType === 1 && FIND_INLINE_HOSTS[current.nodeName])
        return false;
      current = current.parentNode;
    }
    return true;
  }

  // 块内命中允许跨文本节点，但两个端点都必须在行内格式之外；这样区间里要么
  // 没有标记，要么是完整的行内结构，替换后 Markdown 仍然合法。返回绝对区间。
  function findMatchSpan(match) {
    if (findInSource)
      return { start: match.start, end: match.end, sameBlock: true, source: true };
    var range = match.range;
    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected)
      return null;
    var startBlock = blockOf(range.startContainer) || match.block;
    var endBlock = blockOf(range.endContainer) || match.endBlock || startBlock;
    if (!startBlock || !endBlock || !startBlock.isConnected || !endBlock.isConnected)
      return null;
    if (!findBoundarySafe(startBlock, range.startContainer)
        || !findBoundarySafe(endBlock, range.endContainer))
      return null;
    var sameBlock = startBlock === endBlock;
    var startScope = isCodeBlock(startBlock) ? codeEl(startBlock) : startBlock;
    var endScope = isCodeBlock(endBlock) ? codeEl(endBlock) : endBlock;
    if (!startScope || !endScope)
      return null;
    var start = offsetIn(startScope, range.startContainer, range.startOffset);
    var end = offsetIn(endScope, range.endContainer, range.endOffset);
    if (start < 0 || end < 0)
      return null;
    if (isCodeBlock(startBlock))
      start += codePrefixLength(startBlock);
    if (isCodeBlock(endBlock))
      end += codePrefixLength(endBlock);
    var list = blockList();
    var si = list.indexOf(startBlock);
    var ei = list.indexOf(endBlock);
    if (si < 0 || ei < 0 || ei < si)
      return null;
    var blocks = collectBlocks();
    var gaps = collectGaps();
    var startAbs = blockStartOffset(blocks, gaps, si) + start;
    var endAbs = blockStartOffset(blocks, gaps, ei) + end;
    if (endAbs < startAbs)
      return null;
    return {
      start: startAbs,
      end: endAbs,
      sameBlock: sameBlock,
      startBlock: startBlock,
      endBlock: endBlock,
      startIndex: si,
      endIndex: ei,
      startRelative: start,
      endRelative: end
    };
  }

  function replacementProblem(match, repl) {
    if (repl.indexOf('\0') >= 0)
      return '替换文本含非法字符';
    if (findInSource)
      return repl.indexOf('\n') >= 0 ? '替换文本不能含换行' : '';
    var span = findMatchSpan(match);
    if (!span)
      return '命中边界在行内格式内部或已失效，未替换';
    if (!span.sameBlock) {
      if (isCodeBlock(span.startBlock) || isCodeBlock(span.endBlock)
          || span.startBlock.classList.contains('table')
          || span.endBlock.classList.contains('table')
          || span.startBlock.classList.contains('hr')
          || span.endBlock.classList.contains('hr'))
        return '跨块替换不支持代码块/表格/分隔线边界';
      var list = blockList();
      for (var i = span.startIndex + 1; i < span.endIndex; i++) {
        var between = list[i];
        if (isCodeBlock(between) || between.classList.contains('table')
            || between.classList.contains('hr'))
          return '跨块区间包含代码块/表格/分隔线，未替换';
      }
      return '';
    }
    if (repl.indexOf('\n') >= 0)
      return '替换文本不能含换行';
    var block = span.startBlock;
    if (block.classList.contains('hr'))
      return '分隔线不支持替换';
    if (block.classList.contains('table') && repl.indexOf('|') >= 0)
      return '替换文本含 |，会改变表格列结构，已跳过';
    if (isCodeBlock(block) && repl.indexOf('```') >= 0)
      return '替换文本含 ```，会破坏代码围栏，已跳过';
    return '';
  }

  function rerenderFromRaw(block, raw, wasEditing) {
    renderBlock(block, raw);
    if (wasEditing && !block.classList.contains('editing'))
      block.classList.add('editing');
    if (isCodeBlock(block))
      normalizeCodeScrolls(block);
  }

  // 跨块替换后整篇重建：一次撤销步、保持滚动位置，返回替换末尾所在的块与块内偏移。
  function rebuildFromSourceText(text, caret) {
    var scrollY = window.scrollY;
    var layout = splitSourceLayout(text);
    suppressEvents = true;
    mountBlocks(layout.blocks, layout.gaps, layout.trail);
    suppressEvents = false;
    var at = locateBlock(layout.blocks, layout.gaps, caret);
    commitHistory();
    scheduleTocRefresh();
    window.scrollTo(window.scrollX, scrollY);
    return { block: root.children[at.index] || null, offset: at.start };
  }

  function replaceCurrent() {
    if (!findMatches.length) {
      setFindNote('没有可替换的命中');
      return;
    }
    var match = findMatches[findActive];
    var repl = findReplace ? findReplace.value : '';
    var problem = replacementProblem(match, repl);
    if (problem) {
      setFindNote(problem);
      return;
    }
    var keep = findActive;
    if (findInSource) {
      var value = sourceEl.value;
      sourceEl.value = value.slice(0, match.start) + repl + value.slice(match.end);
      commitHistory();
      scheduleTocRefresh();
      findScan(findInput.value);
      if (findMatches.length) {
        findActive = Math.min(keep, findMatches.length - 1);
        updateFindCount();
      }
      setFindNote('已替换 1 处');
      return;
    }
    var span = findMatchSpan(match);
    if (!span) {
      setFindNote('命中已失效，请重新查找');
      return;
    }
    if (!span.sameBlock) {
      var text = currentSource();
      if (span.end > text.length) {
        setFindNote('命中已失效，请重新查找');
        return;
      }
      var landed = rebuildFromSourceText(
        text.slice(0, span.start) + repl + text.slice(span.end),
        span.start + repl.length);
      findCaret = landed.block ? { block: landed.block, offset: landed.offset } : null;
      findJumped = null;
      findScan(findInput.value);
      if (findMatches.length) {
        findActive = Math.min(keep, findMatches.length - 1);
        paintFind();
        updateFindCount();
      }
      if (findInput)
        findInput.focus();
      setFindNote('已替换 1 处（跨块）');
      return;
    }
    var block = span.startBlock;
    var raw = block.dataset.raw || '';
    var wasEditing = block.classList.contains('editing');
    rerenderFromRaw(block,
      raw.slice(0, span.startRelative) + repl + raw.slice(span.endRelative), wasEditing);
    commitHistory();
    scheduleTocRefresh();
    findScan(findInput.value);
    if (findMatches.length) {
      findActive = Math.min(keep, findMatches.length - 1);
      paintFind();
      updateFindCount();
    }
    setFindNote('已替换 1 处');
  }

  // 只要有一个跨块命中就统一按绝对区间从后往前改整篇源码，最后重建一次。
  function replaceAllAcrossBlocks(repl, query) {
    var text = currentSource();
    var spans = [];
    var skipped = 0;
    for (var m = 0; m < findMatches.length; m++) {
      if (replacementProblem(findMatches[m], repl)) {
        skipped++;
        continue;
      }
      var span = findMatchSpan(findMatches[m]);
      if (!span || span.end > text.length) {
        skipped++;
        continue;
      }
      spans.push(span);
    }
    if (!spans.length) {
      setFindNote('没有可替换的命中');
      return;
    }
    spans.sort(function (a, b) { return b.start - a.start; });
    // 从后往前改：最后一个替换的末尾在后续修改中不会再移动
    var caret = spans[0].start + repl.length;
    for (var i = 0; i < spans.length; i++)
      text = text.slice(0, spans[i].start) + repl + text.slice(spans[i].end);
    var landed = rebuildFromSourceText(text, caret);
    findCaret = landed.block ? { block: landed.block, offset: landed.offset } : null;
    findJumped = null;
    findScan(query);
    paintFind();
    updateFindCount();
    if (findInput)
      findInput.focus();
    setFindNote(skipped
      ? '已替换 ' + spans.length + ' 处，跳过 ' + skipped + ' 处（跨行内标记/结构限制）'
      : '全部替换 ' + spans.length + ' 处');
  }

  function replaceAll() {
    if (!findMatches.length) {
      setFindNote('没有可替换的命中');
      return;
    }
    var repl = findReplace ? findReplace.value : '';
    var query = findInput.value;
    var done = 0;
    var skipped = 0;

    if (findInSource) {
      var value = sourceEl.value;
      for (var i = findMatches.length - 1; i >= 0; i--)
        value = value.slice(0, findMatches[i].start) + repl + value.slice(findMatches[i].end);
      done = findMatches.length;
      sourceEl.value = value;
      commitHistory();
      scheduleTocRefresh();
      findScan(query);
      updateFindCount();
      setFindNote('全部替换 ' + done + ' 处');
      return;
    }

    // 只要命中里有跨块的，就整篇改一次；否则保持按块重排（更快，也保留编辑态）
    var hasCross = false;
    for (var c = 0; c < findMatches.length; c++) {
      var crossSpan = findMatchSpan(findMatches[c]);
      if (crossSpan && !crossSpan.sameBlock) {
        hasCross = true;
        break;
      }
    }
    if (hasCross) {
      replaceAllAcrossBlocks(repl, query);
      return;
    }

    // 按块分组（保持文档顺序），块内从后往前改 raw，前面命中的下标不受影响
    var groups = [];
    for (var m = 0; m < findMatches.length; m++) {
      var problem = replacementProblem(findMatches[m], repl);
      if (problem) {
        skipped++;
        continue;
      }
      var span = findMatchSpan(findMatches[m]);
      if (!span) {
        skipped++;
        continue;
      }
      var host = span.startBlock;
      var slot = -1;
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].block === host) {
          slot = g;
          break;
        }
      }
      if (slot < 0) {
        groups.push({ block: host, spans: [] });
        slot = groups.length - 1;
      }
      groups[slot].spans.push({ start: span.startRelative, end: span.endRelative });
    }
    for (var n = 0; n < groups.length; n++) {
      var target = groups[n].block;
      var text = target.dataset.raw || '';
      var spans = groups[n].spans.sort(function (a, b) { return b.start - a.start; });
      for (var s = 0; s < spans.length; s++)
        text = text.slice(0, spans[s].start) + repl + text.slice(spans[s].end);
      rerenderFromRaw(target, text, target.classList.contains('editing'));
      done += spans.length;
    }
    if (done) {
      commitHistory();
      scheduleTocRefresh();
      findScan(query);
      paintFind();
      updateFindCount();
    }
    setFindNote(skipped
      ? '已替换 ' + done + ' 处，跳过 ' + skipped + ' 处（跨行内标记/结构限制）'
      : '全部替换 ' + done + ' 处');
  }

  function scheduleFind() {
    if (findTimer)
      clearTimeout(findTimer);
    findTimer = setTimeout(function () {
      findTimer = 0;
      if (findInput)
        findScan(findInput.value);
    }, 120);
  }

  // 查找框是多行 textarea：⌥↩ 输入换行，块与块之间也按一个换行参与匹配。
  function growFindInput() {
    if (!findInput)
      return;
    findInput.style.height = 'auto';
    findInput.style.height = Math.min(72, Math.max(22, findInput.scrollHeight)) + 'px';
  }

  function buildFindBar() {
    findBar = document.createElement('div');
    findBar.id = 'find-bar';
    findBar.innerHTML = '<textarea id="find-input" rows="1" placeholder="查找（⌥↩ 换行）" spellcheck="false"></textarea>'
      + '<input id="find-replace" type="text" placeholder="替换为" spellcheck="false">'
      + '<span id="find-count">0/0</span>'
      + '<button id="find-prev" type="button" title="上一个（Shift+Enter）">↑</button>'
      + '<button id="find-next" type="button" title="下一个（Enter）">↓</button>'
      + '<button id="find-replace-one" type="button" title="替换当前命中">替换</button>'
      + '<button id="find-replace-all" type="button" title="全部替换">全部</button>'
      + '<button id="find-close" type="button" title="关闭（Esc）">×</button>'
      + '<span id="find-note"></span>';
    document.body.appendChild(findBar);
    findInput = document.getElementById('find-input');
    findReplace = document.getElementById('find-replace');
    findCount = document.getElementById('find-count');
    findNote = document.getElementById('find-note');
    findNote.style.display = 'none';
    growFindInput();

    findInput.addEventListener('input', function () {
      growFindInput();
      scheduleFind();
    });
    findReplace.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceCurrent();
      }
    });
    findInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter')
        return;
      // ⌥↩ 让 textarea 插入换行，input 事件会重新扫描；其余 Enter 仍是跳转
      if (event.altKey) {
        setTimeout(growFindInput, 0);
        return;
      }
      event.preventDefault();
      goFind(event.shiftKey ? -1 : 1);
    });
    document.getElementById('find-prev').addEventListener('click', function () { goFind(-1); });
    document.getElementById('find-next').addEventListener('click', function () { goFind(1); });
    document.getElementById('find-replace-one').addEventListener('click', replaceCurrent);
    document.getElementById('find-replace-all').addEventListener('click', replaceAll);
    document.getElementById('find-close').addEventListener('click', function () { closeFind(); });
  }

  function openFind() {
    if (findBar)
      return;
    // 查找条打开后焦点交给查找框，覆盖层选区先收起
    clearCrossSelection();
    findInSource = mode === 'source';
    if (findInSource) {
      findCaret = { source: true, start: sourceEl.selectionStart, end: sourceEl.selectionEnd };
    } else {
      var block = document.activeElement ? blockOf(document.activeElement) : null;
      // 关掉查找栏时走 placeBlockCaret（原文口径），这里也按原文口径取
      findCaret = block ? { block: block, offset: rawCaretOffset(block) } : null;
    }
    findJumped = null;

    buildFindBar();
    findBar.style.display = 'flex';
    findInput.focus();

    var picked = '';
    if (findInSource) {
      if (sourceEl.selectionEnd > sourceEl.selectionStart)
        picked = sourceEl.value.slice(sourceEl.selectionStart, sourceEl.selectionEnd);
    } else {
      var selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount)
        picked = selection.toString();
    }
    picked = picked.replace(/\s+/g, ' ').trim();
    if (picked && picked.length <= 80)
      findInput.value = picked;
    findInput.select();
    growFindInput();
    findScan(findInput.value);
  }

  function closeFind() {
    if (findTimer) {
      clearTimeout(findTimer);
      findTimer = 0;
    }
    if (findNoteTimer) {
      clearTimeout(findNoteTimer);
      findNoteTimer = 0;
    }
    var inSource = findInSource;
    var jumped = findJumped;
    var caret = findCaret;
    findMatches = [];
    findActive = -1;
    findJumped = null;
    findCaret = null;
    findInSource = false;
    dropFindLayer();
    if (findBar && findBar.parentNode)
      findBar.parentNode.removeChild(findBar);
    findBar = findInput = findReplace = findCount = findNote = null;

    if (inSource) {
      sourceEl.focus();
      var target = jumped && jumped.source ? jumped : caret;
      if (target) {
        try {
          sourceEl.setSelectionRange(target.start, target.end === undefined ? target.start : target.end);
        } catch (error) { /* ignore */ }
        scrollSourceTo(target.start);
      }
      return;
    }

    if (jumped && jumped.block && jumped.block.isConnected
        && jumped.range.startContainer.isConnected) {
      // 跳转过：光标落在最后一个命中
      if (document.activeElement !== jumped.block)
        jumped.block.focus();
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(findSelectRange(jumped));
    } else if (caret && caret.block && caret.block.isConnected) {
      // 没跳转过：回到打开查找前的光标位置
      if (document.activeElement !== caret.block)
        caret.block.focus();
      placeBlockCaret(caret.block, caret.offset);
    }
  }

  document.addEventListener('keydown', function (event) {
    var barOpen = !!(findBar && findBar.style.display !== 'none');
    if ((event.metaKey || event.ctrlKey) && !event.altKey
        && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      event.stopPropagation();
      if (barOpen)
        closeFind();
      else
        openFind();
      return;
    }
    if (!barOpen)
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
      return;
    }
    // 编辑态跳转后焦点在正文块上，Enter/Shift+Enter 仍按「下一个/上一个」处理；
    // 查找框自己的 Enter 由 input 上的监听处理（这里放行）。
    var target = event.target;
    if (event.key === 'Enter' && target && target !== findInput && target.closest
        && target.closest('.block')) {
      event.preventDefault();
      event.stopPropagation();
      goFind(event.shiftKey ? -1 : 1);
    }
  }, true);

  // 覆盖层是文档绝对坐标：只有代码块内部横向滚动会改变几何而不改变文档滚动量。
  // 窗口缩放会让绝对坐标失配，也重画一次。
  document.addEventListener('scroll', function (event) {
    if (!findLayer || !findMatches.length)
      return;
    if (event.target && event.target.closest && event.target.closest('.code-scroll'))
      paintFind();
  }, true);

  window.addEventListener('resize', function () {
    if (findLayer && findMatches.length)
      paintFind();
    // 覆盖层是文档绝对坐标，缩放/换行变化后必须按新几何重画
    if (crossSel)
      paintCrossSelection();
  });

  // 命中的块里图片晚一步解码完、字体替换完成时块高会变，但都不触发 resize。
  // load 不冒泡，必须用捕获阶段才能收到 <img> 的加载完成。
  document.addEventListener('load', function (event) {
    var target = event.target;
    if (target && target.nodeName === 'IMG') {
      scheduleFindPaint();
      if (crossSel)
        paintCrossSelection();
    }
  }, true);

  if (document.fonts) {
    if (document.fonts.ready && document.fonts.ready.then)
      document.fonts.ready.then(function () {
        scheduleFindPaint();
        if (crossSel)
          paintCrossSelection();
      });
    if (document.fonts.addEventListener)
      document.fonts.addEventListener('loadingdone', function () {
        scheduleFindPaint();
        if (crossSel)
          paintCrossSelection();
      });
  }

  window.addEventListener('scroll', function () {
    if (!tocVisible || mode !== 'wysiwyg' || spyScheduled)
      return;
    spyScheduled = true;
    requestAnimationFrame(function () {
      spyScheduled = false;
      updateActiveHeading();
    });
  });

  // 视口或字号变化后标题纵坐标失效，下一次滚动高亮时重算
  window.addEventListener('resize', function () { tocTops = null; });

  if (tocList) {
    tocList.addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('.toc-item') : null;
      if (!node)
        return;
      event.preventDefault();
      var item = tocItems[Number(node.getAttribute('data-toc'))];
      if (!item)
        return;
      item.el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -16);
      updateActiveHeading();
    });
  }

  document.addEventListener('dragover', function (event) {
    event.preventDefault();
  });

  document.addEventListener('drop', function (event) {
    event.preventDefault();
    var files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length)
      return;
    var file = files[0];
    // 图片走 base64 落盘（与粘贴同一管道）；.md 等文本仍回退为「未关联路径」载入。
    // 原生层装好 NSDraggingDestination 后，文件拖放会先被原生接走，这里只是兜底。
    if (/^image\//i.test(file.type || '')) {
      postImageFile(file, 'drop');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      post({ type: 'drop', name: file.name, text: String(reader.result) });
    };
    reader.readAsText(file);
  });

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

  // 原文 → 块类型。与 renderBlock 的判定顺序保持一致。
  function kindOfRaw(raw) {
    raw = String(raw === undefined || raw === null ? '' : raw);
    if (/^```[^\n`]*\n?[\s\S]*?```\s*$/.test(raw))
      return 'code';
    var heading = raw.match(/^(#{1,6})\s+/);
    if (heading && raw.indexOf('\n') < 0)
      return 'h' + heading[1].length;
    var lines = raw.split('\n');
    if (lines.length && lines.every(function (line) { return /^\s*[-*+]\s+/.test(line); }))
      return 'ul';
    if (lines.length && lines.every(function (line) { return /^\s*\d+[.)]\s+/.test(line); }))
      return 'ol';
    if (lines.length && lines.every(function (line) { return /^\s*>/.test(line); }))
      return 'quote';
    if (isTableSource(lines))
      return 'table';
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw.trim()))
      return 'hr';
    return 'p';
  }

  // 去掉结构前缀后的正文内容（代码块取围栏内正文）
  function contentOfRaw(raw, kind) {
    raw = String(raw === undefined || raw === null ? '' : raw);
    kind = kind || kindOfRaw(raw);
    if (kind === 'code') {
      var fence = raw.match(/^```([^\n`]*)\n?([\s\S]*?)\n?```\s*$/);
      return fence ? fence[2].replace(/\n$/, '') : raw;
    }
    if (kind.charAt(0) === 'h')
      return raw.replace(/^#{1,6}\s+/, '');
    if (kind === 'ul')
      return raw.split('\n').map(function (line) { return line.replace(/^\s*[-*+]\s+/, ''); }).join('\n');
    if (kind === 'ol')
      return raw.split('\n').map(function (line) { return line.replace(/^\s*\d+[.)]\s+/, ''); }).join('\n');
    if (kind === 'quote')
      return raw.split('\n').map(function (line) { return line.replace(/^\s*>\s?/, ''); }).join('\n');
    return raw;
  }

  // 正文内容 → 目标类型的原文。前缀只加一次，已在内容里的前缀由调用方先剥掉。
  function buildBlockRaw(type, content) {
    content = String(content === undefined || content === null ? '' : content);
    var lines = content.split('\n');
    if (type === 'code')
      return '```\n' + content.replace(/\n+$/, '') + '\n```';
    if (type.charAt(0) === 'h')
      // 标题只能是一行：多行内容用空格并成一行，避免出现 `# a\nb` 这种半标题
      return new Array(Number(type.slice(1)) + 1).join('#') + ' ' + content.replace(/\n+/g, ' ');
    if (type === 'ul')
      return lines.map(function (line) { return '- ' + line; }).join('\n');
    if (type === 'ol')
      return lines.map(function (line, index) { return (index + 1) + '. ' + line; }).join('\n');
    if (type === 'quote')
      return lines.map(function (line) { return '> ' + line; }).join('\n');
    if (type === 'hr')
      return '---';
    return content;
  }

  // 单块转换。toggle=false（「转为」菜单）时已是目标类型则保持不动；
  // toggle=true（快捷键/斜杠）时同样目标类型再执行一次回到正文。
  function convertRaw(raw, type, toggle) {
    var prev = kindOfRaw(raw);
    if (prev === type)
      return toggle ? contentOfRaw(raw, prev) : raw;
    if (type === 'p' && prev === 'p')
      return raw;
    return buildBlockRaw(type, contentOfRaw(raw, prev));
  }

  // 首行结构前缀长度：转换后按差值平移光标，避免标题/列表前缀把光标挤走
  function leadLength(raw, kind) {
    var match;
    if (kind && kind.charAt(0) === 'h' && (match = raw.match(/^#{1,6}\s+/)))
      return match[0].length;
    if ((kind === 'ul' || kind === 'ol') && (match = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+/)))
      return match[0].length;
    if (kind === 'quote' && (match = raw.match(/^\s*>\s?/)))
      return match[0].length;
    if (kind === 'code' && (match = raw.match(/^```[^\n`]*\n/)))
      return match[0].length;
    return 0;
  }

  // 编辑中的块以 textContent 为准（input 已逐次同步 dataset.raw，但组合输入
  // 结束前可能有半帧差）；其余块一律用 dataset.raw。
  function rawOf(el) {
    if (isCodeBlock(el))
      return el.dataset.raw === undefined ? codeRaw(el, codeText(el)) : el.dataset.raw;
    if (el.classList.contains('editing'))
      return el.textContent;
    return el.dataset.raw === undefined ? el.textContent : el.dataset.raw;
  }

  function blockList() {
    return Array.prototype.filter.call(root.children, function (el) {
      return el.classList && el.classList.contains('block');
    });
  }

  // 选区覆盖的块（含首尾）。跨块多选时用于「一次转换多块」。
  // 三击/拖选会让选区边界落在 #editor 本身（而不是某个块里），
  // 此时按子节点下标取相邻块，否则多选转换会被误判成“没有块”。
  function blockAtBoundary(node, offset, preferPrevious) {
    var el = blockOf(node);
    if (el)
      return el;
    if (node !== root)
      return null;
    var kids = blockList();
    if (!kids.length)
      return null;
    if (preferPrevious) {
      for (var i = Math.min(offset, kids.length) - 1; i >= 0; i--) {
        if (kids[i].parentNode === root)
          return kids[i];
      }
      return kids[0];
    }
    for (var j = Math.max(0, offset); j < kids.length; j++) {
      if (kids[j].parentNode === root)
        return kids[j];
    }
    return kids[kids.length - 1];
  }

  function selectedBlocks() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount)
      return [];
    var range = selection.getRangeAt(0);
    var all = blockList();
    var first = blockAtBoundary(range.startContainer, range.startOffset, false)
      || blockAtBoundary(selection.anchorNode, 0, false);
    var last = blockAtBoundary(range.endContainer, range.endOffset, true)
      || first;
    if (!first)
      return [];
    var a = all.indexOf(first);
    var b = all.indexOf(last);
    if (a < 0)
      return [first];
    if (b < 0)
      b = a;
    return all.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  // 渲染一个新原文并恢复编辑态；start/end 是「块原文」口径的偏移。
  function applyRawToBlock(el, raw, start, end, editing) {
    renderBlock(el, raw);
    normalizeCodeScrolls(el);
    if (editing) {
      el.classList.add('editing');
      el.focus();
      var limit = raw.length;
      var from = Math.max(0, Math.min(start === undefined || start === null ? limit : start, limit));
      var to = Math.max(from, Math.min(end === undefined || end === null ? from : end, limit));
      placeBlockCaret(el, from, to);
    }
    updatePlaceholder();
    scheduleDirty();
    scheduleTocRefresh();
  }

  // 多块合并型转换（列表/引用/代码块）：把选中块的内容按行拼进一个块。
  var MERGE_TYPES = { ul: 1, ol: 1, quote: 1, code: 1 };

  function convertBlocks(type, toggle) {
    if (mode === 'source') {
      sourceConvert(type, toggle);
      return;
    }
    var blocks = selectedBlocks();
    if (!blocks.length)
      return;
    var target = blocks[0];
    var selection = rangeIn(target);

    if (blocks.length > 1 && MERGE_TYPES[type]) {
      var content = blocks.map(function (el) {
        return contentOfRaw(rawOf(el), kindOfRaw(rawOf(el)));
      }).join('\n');
      var merged = buildBlockRaw(type, content);
      commitHistory();
      for (var i = blocks.length - 1; i >= 1; i--)
        blocks[i].remove();
      applyRawToBlock(target, merged, merged.length, merged.length, true);
      setTimeout(commitHistory, 0);
      return;
    }

    // 单块（或标题/正文这种按块独立转换的多选）
    var changed = false;
    var multi = blocks.length > 1;
    // 列表/引用 → 正文会把每行还原成独立段落，也算一次批量改动
    var splitting = type === 'p';
    commitHistory();
    if (multi || splitting)
      commitBatch++;
    blocks.forEach(function (el) {
      var raw = rawOf(el);
      var before = kindOfRaw(raw);
      var next = convertRaw(raw, type, toggle);
      if (next === raw)
        return;
      changed = true;
      // 列表/引用回正文：逐行拆回独立段落，避免一个块里塞进硬换行
      if (type === 'p' && (before === 'ul' || before === 'ol' || before === 'quote')) {
        var lines = contentOfRaw(raw, before).replace(/\n+$/, '').split('\n');
        if (lines.length > 1) {
          applyRawToBlock(el, lines[0], lines[0].length, lines[0].length, true);
          var anchor = el;
          for (var li = 1; li < lines.length; li++) {
            insertBlockAfter(anchor, lines[li], lines[li].length);
            anchor = anchor.nextElementSibling;
          }
          return;
        }
      }
      var shift = leadLength(next, kindOfRaw(next)) - leadLength(raw, before);
      // 只有选区所在的块沿用选区偏移，其余块光标放末尾
      var hasCaret = selection && el === target;
      var start = hasCaret ? Math.max(0, selection.start + shift) : next.length;
      var end = hasCaret ? Math.max(start, selection.end + shift) : next.length;
      applyRawToBlock(el, next, start, end, true);
    });
    if (multi || splitting)
      commitBatch--;
    if (!changed) {
      commitHistory();
      return;
    }
    // 多块/拆分转换合成一个撤销步：一次 Cmd+Z 全部还原
    if (multi || splitting)
      commitHistory();
    else
      setTimeout(commitHistory, 0);
  }

  // 光标 / 选区落在行内时，给当前块套（或取消）行内标记。
  function inlineTransform(raw, start, end, kind) {
    var open = '**';
    if (kind === 'italic')
      open = '*';
    else if (kind === 'inlineCode')
      open = '`';
    if (kind === 'link') {
      // 光标/选区可能落在链接文字上，也可能落在 (url) 里；两种位置都应能整体取消。
      var lb = raw.lastIndexOf('[', start - 1);
      if (lb >= 0) {
        var rb = raw.indexOf(']', lb + 1);
        if (rb > lb && rb <= end + 1 && raw.slice(rb, rb + 2) === '](') {
          var close = raw.indexOf(')', rb + 2);
          if (close > 0) {
            var textStart = lb + 1;
            var textEnd = rb;
            var textLen = textEnd - textStart;
            return {
              raw: raw.slice(0, lb) + raw.slice(textStart, textEnd) + raw.slice(close + 1),
              // 去掉 '[' 后整段左移一位，链接文字的新起点就是 lb
              start: lb, end: lb + textLen
            };
          }
        }
      }
      if (end > start)
        return {
          raw: raw.slice(0, start) + '[' + raw.slice(start, end) + '](url)' + raw.slice(end),
          start: start + 1, end: end + 1
        };
      return {
        raw: raw.slice(0, start) + '[链接文字](url)' + raw.slice(start),
        start: start + 7, end: start + 10
      };
    }
    var closeMark = open;
    var before = raw.slice(Math.max(0, start - open.length), start);
    var after = raw.slice(end, end + closeMark.length);
    // 斜体不能把 ** 的一半当成自己的开/闭标记
    var starConfused = kind === 'italic'
      && (raw.slice(Math.max(0, start - 2), start) === '**' || raw.slice(end, end + 2) === '**');
    if (!starConfused && before === open && after === closeMark) {
      return {
        raw: raw.slice(0, start - open.length) + raw.slice(start, end) + raw.slice(end + closeMark.length),
        start: start - open.length, end: Math.max(start - open.length, end - open.length)
      };
    }
    if (start === end)
      return {
        raw: raw.slice(0, start) + open + closeMark + raw.slice(start),
        start: start + open.length, end: start + open.length
      };
    return {
      raw: raw.slice(0, start) + open + raw.slice(start, end) + closeMark + raw.slice(end),
      start: start + open.length, end: end + open.length
    };
  }

  function toggleInline(kind) {
    if (mode === 'source') {
      sourceInline(kind);
      return;
    }
    var blocks = selectedBlocks();
    if (!blocks.length)
      return;
    var el = blocks[0];
    if (isCodeBlock(el) || el.classList.contains('table') || el.classList.contains('hr')) {
      post({ type: 'status', message: '当前块不支持行内格式' });
      return;
    }
    var selection = rangeIn(el);
    if (!selection)
      return;
    var raw = rawOf(el);
    var out = inlineTransform(raw, selection.start, selection.end, kind);
    if (out.raw === raw)
      return;
    commitHistory();
    applyRawToBlock(el, out.raw, out.start, out.end, true);
    setTimeout(commitHistory, 0);
  }

  var TABLE_TEMPLATE = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |';

  // 在当前块之后插入一个新块；caret 为块原文偏移
  function insertBlockAfter(el, raw, caret) {
    var block = document.createElement('div');
    block.className = 'block';
    block.setAttribute('contenteditable', 'true');
    renderBlock(block, raw);
    if (el && el.parentNode === root)
      root.insertBefore(block, el.nextSibling);
    else
      root.appendChild(block);
    normalizeCodeScrolls(block);
    block.classList.add('editing');
    block.focus();
    placeBlockCaret(block, caret === undefined ? raw.length : caret);
    if (block.scrollIntoView)
      block.scrollIntoView({ block: 'nearest' });
    updatePlaceholder();
  }

  // 表格 / 分隔线：不改动已有内容，在当前块之后插入
  function insertTableBlock() {
    var blocks = selectedBlocks();
    var el = blocks.length ? blocks[blocks.length - 1] : root.lastElementChild;
    commitHistory();
    var empty = el && el.classList.contains('block')
      && contentOfRaw(rawOf(el), kindOfRaw(rawOf(el))).trim() === '';
    if (empty) {
      applyRawToBlock(el, TABLE_TEMPLATE, 2, 2, true);
    } else {
      insertBlockAfter(el, TABLE_TEMPLATE, 2);
    }
    scheduleDirty();
    scheduleTocRefresh();
    setTimeout(commitHistory, 0);
  }

  function insertHrBlock() {
    var blocks = selectedBlocks();
    var el = blocks.length ? blocks[blocks.length - 1] : root.lastElementChild;
    commitHistory();
    var empty = el && el.classList.contains('block')
      && contentOfRaw(rawOf(el), kindOfRaw(rawOf(el))).trim() === '';
    if (empty) {
      applyRawToBlock(el, '---', 3, 3, true);
      insertBlockAfter(el, '', 0);
    } else {
      insertBlockAfter(el, '---', 3);
      insertBlockAfter(el.nextSibling, '', 0);
    }
    scheduleDirty();
    scheduleTocRefresh();
    setTimeout(commitHistory, 0);
  }

  // 统一动作名：原生菜单、斜杠菜单、快捷键都只传这些字符串
  function formatAction(name) {
    if (name === 'bold' || name === 'italic' || name === 'inlineCode' || name === 'link') {
      toggleInline(name);
      return;
    }
    if (name === 'table') {
      insertTableBlock();
      return;
    }
    if (name === 'hr') {
      insertHrBlock();
      return;
    }
    var type = { h1: 'h1', h2: 'h2', h3: 'h3', paragraph: 'p', ul: 'ul', ol: 'ol', quote: 'quote', codeBlock: 'code' }[name];
    if (!type)
      return;
    // 快捷键/菜单是切换语义：同类型再按一次回正文（codeBlock 回正文=去围栏）
    convertBlocks(type, true);
  }

  /* ---------- 源码模式：同一套规则作用于 textarea 文本 ---------- */

  // 段落起点：回退到空白行之后。连续多个空行要整段跨过，不能只退两格，
  // 否则保存了 3 个换行的文档在源码模式下转换会吃掉一个换行。
  function paragraphStart(text, position) {
    var gap = text.lastIndexOf('\n\n', Math.max(0, position - 1));
    if (gap < 0)
      return 0;
    while (gap < text.length && text.charAt(gap) === '\n')
      gap++;
    return gap;
  }

  function paragraphEnd(text, position) {
    var gap = text.indexOf('\n\n', position);
    if (gap < 0)
      return text.length;
    while (gap > 0 && text.charAt(gap - 1) === '\n')
      gap--;
    return gap;
  }

  function sourceParagraph(text, start, end) {
    var from = paragraphStart(text, start);
    var to = paragraphEnd(text, end);
    return { start: from, end: to, text: text.slice(from, to) };
  }

  function applySourceText(text, start, end) {
    sourceEl.value = text;
    sourceEl.focus();
    sourceEl.setSelectionRange(start, end);
    sourceEl.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(commitHistory, 0);
  }

  function sourceInline(kind) {
    var text = sourceEl.value;
    var start = sourceEl.selectionStart;
    var end = sourceEl.selectionEnd;
    var out = inlineTransform(text, start, end, kind);
    if (out.raw === text)
      return;
    commitHistory();
    applySourceText(out.raw, out.start, out.end);
  }

  function sourceConvert(type, toggle) {
    var text = sourceEl.value;
    var start = sourceEl.selectionStart;
    var end = sourceEl.selectionEnd;
    // 多行选区：按当前段落范围整体转换（与块模型一致）
    var range = (start === end || /^\s*$/.test(text.slice(start, end)))
      ? sourceParagraph(text, start, end)
      : { start: paragraphStart(text, start), end: paragraphEnd(text, end) };
    if (range.end < 0)
      range.end = text.length;
    if (range.start < 0)
      range.start = 0;
    var raw = text.slice(range.start, range.end);
    var next = convertRaw(raw, type, toggle);
    if (next === raw)
      return;
    var shift = leadLength(next, kindOfRaw(next)) - leadLength(raw, kindOfRaw(raw));
    commitHistory();
    applySourceText(text.slice(0, range.start) + next + text.slice(range.end),
      Math.max(range.start, start + shift), Math.max(range.start, end + shift));
  }


  /* ---------- 空白文档占位提示 ----------
     提示用 CSS ::before 绘制，不属于 textContent，因此绝不会写进 dataset.raw；
     只在「整篇只有一个空块」时出现，正常文档里回车产生的新空块不受影响。 */
  function updatePlaceholder() {
    if (!root)
      return;
    var blocks = blockList();
    var bare = mode !== 'source' && blocks.length === 1
      && String(rawOf(blocks[0])).trim() === '';
    if (bare !== root.classList.contains('bare'))
      root.classList.toggle('bare', bare);
  }

  /* ---------- 斜杠命令浮层 ----------
     浮层挂在 body 上（不在 #editor 里），提示文字不进入文档 DOM；
     插入统一走 convertRaw / applyRawToBlock，与快捷键、右键菜单同一套实现。 */
  var SLASH_ITEMS = [
    { key: 'code', label: '代码块', hint: '```', words: 'code daima codeblock 代码块' },
    { key: 'inlineCode', label: '行内代码', hint: '`', words: 'inline code hangnei 行内代码' },
    { key: 'table', label: '表格', hint: '|', words: 'table biaoge 表格' },
    { key: 'h1', label: '标题 1', hint: '#', words: 'h1 heading biaoti 标题1 一级标题' },
    { key: 'h2', label: '标题 2', hint: '##', words: 'h2 heading biaoti 标题2 二级标题' },
    { key: 'h3', label: '标题 3', hint: '###', words: 'h3 heading biaoti 标题3 三级标题' },
    { key: 'ul', label: '无序列表', hint: '-', words: 'ul bullet list wuxu 无序列表' },
    { key: 'ol', label: '有序列表', hint: '1.', words: 'ol number list youxu 有序列表' },
    { key: 'quote', label: '引用', hint: '>', words: 'quote yinyong 引用' },
    { key: 'hr', label: '分隔线', hint: '---', words: 'hr divider fengexian 分隔线' },
    { key: 'image', label: '图片', hint: '![]', words: 'image picture tupian 图片' },
    { key: 'link', label: '链接', hint: '[]()', words: 'link lianjie 链接' }
  ];

  var slashState = null;   // { el, start, end, index }
  var slashMenu = null;
  var turnMenu = null;

  function removeMenu(node) {
    if (node && node.parentNode)
      node.parentNode.removeChild(node);
  }

  function caretClientRect() {
    var selection = window.getSelection();
    if (selection && selection.rangeCount) {
      var range = selection.getRangeAt(0).cloneRange();
      range.collapse(true);
      var rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height || rect.top))
        return rect;
    }
    var el = slashState ? slashState.el : null;
    if (el)
      return el.getBoundingClientRect();
    return null;
  }

  function placeMenu(node, rect) {
    var x = rect ? rect.left : 40;
    var y = rect ? rect.bottom + 6 : 80;
    document.body.appendChild(node);
    var width = node.offsetWidth;
    var height = node.offsetHeight;
    if (x + width > window.innerWidth - 8)
      x = Math.max(8, window.innerWidth - width - 8);
    if (y + height > window.innerHeight - 8)
      y = Math.max(8, (rect ? rect.top : 80) - height - 6);
    // 锚点本身可能在窗口外（页面滚动/极端窗口尺寸），仍把面板钳进可视区
    x = Math.max(8, x);
    y = Math.max(8, y);
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  }

  /* ---------------- 代码块语言选择器 ----------------
     下拉挂在 body 上（position:fixed），因此不会被 .code-scroll / pre 的
     overflow 裁掉，也不参与代码块排版。点徽标开、再点同一个徽标或点外部关闭，
    支持搜索过滤、方向键/Enter/Esc 与自定义语言。 */

  var langMenu = null;       // 挂在 body 上的下拉面板
  var langMenuState = null;  // { el, badge, items, active }
  var langComposing = false; // 搜索框自己的输入法组字状态

  function langItems(query) {
    var raw = String(query || '').trim();
    var q = raw.toLowerCase();
    var items = LANG_PICKS.filter(function (item) {
      if (!q)
        return true;
      return (item.name + ' ' + item.value + ' ' + item.words).toLowerCase().indexOf(q) >= 0;
    });
    if (raw) {
      // 输入不在清单里的名字时，末尾补一条「自定义语言」，Enter 可直接写入。
      // 若已能匹配到某个语言（名称/别名/关键词以输入开头），就不再加这条，
      // 避免输入 py 时同时出现 Python 和「自定义 py」；中文关键词（如「脚本」）
      // 是在搜索已有语言，也不作为自定义语言名。
      var covered = items.some(function (item) {
        if (item.name.toLowerCase().indexOf(q) === 0 || item.value.toLowerCase().indexOf(q) === 0)
          return true;
        return item.words.toLowerCase().split(/\s+/).some(function (word) {
          return word.indexOf(q) === 0;
        });
      }) || /[^\x00-\x7F]/.test(raw);
      if (!covered) {
        items = items.slice();
        items.push({
          name: items.length
            ? '使用自定义语言 “' + raw + '”'
            : '没有匹配的语言，按 Enter 使用 “' + raw + '”',
          value: raw,
          custom: true
        });
      }
    }
    return items;
  }

  // 当前语言在候选里的下标：先按名称/别名精确匹配；自定义写法（如 py）若只
  // 对应到唯一一个高亮器（python），也把那一项视为当前语言。js 这一组有
  // JavaScript/TypeScript/JSX/TSX 四项，无法判断具体是哪一个，就不标。
  function langCurrentIndex(items, current) {
    current = String(current || '').toLowerCase();
    var groupHit = -1;
    var group = LANG_ALIAS[current] || '';
    var count = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.custom)
        continue;
      var value = String(item.value).toLowerCase();
      if (!current) {
        if (!value)
          return i;
        continue;
      }
      if (value === current || item.name.toLowerCase() === current)
        return i;
      if (groupHit < 0 && group && LANG_ALIAS[value] === group) {
        groupHit = i;
        count++;
      }
    }
    return count === 1 ? groupHit : -1;
  }

  function renderLangItems() {
    if (!langMenu || !langMenuState)
      return;
    var list = langMenu.querySelector('.lang-list');
    var items = langMenuState.items || [];
    if (langMenuState.active >= items.length)
      langMenuState.active = Math.max(0, items.length - 1);
    var currentIndex = langCurrentIndex(items, langMenuState.el.dataset.lang);
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var isCurrent = i === currentIndex;
      var cls = 'lang-item' + (i === langMenuState.active ? ' active' : '')
        + (isCurrent ? ' is-current' : '');
      html += '<div class="' + cls + '" role="option" data-index="' + i + '"'
        + ' aria-selected="' + (i === langMenuState.active ? 'true' : 'false') + '">'
        + '<span class="lang-name">' + escapeHtml(item.name) + '</span>'
        + (isCurrent ? '<span class="lang-check">✓</span>' : '')
        + '</div>';
    }
    if (!items.length)
      html = '<div class="lang-empty">没有匹配的语言</div>';
    list.innerHTML = html;
    // 只滚列表自身，不用 scrollIntoView：后者可能把整页滚一下，
    // 既会改变徽标位置，也会触发 scroll 监听把下拉关掉。
    var active = list.querySelector('.lang-item.active');
    if (active) {
      var top = active.offsetTop;
      var bottom = top + active.offsetHeight;
      if (top < list.scrollTop)
        list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight)
        list.scrollTop = bottom - list.clientHeight;
    }
  }

  function moveLangItem(delta) {
    if (!langMenuState || !langMenuState.items.length)
      return;
    var count = langMenuState.items.length;
    langMenuState.active = (langMenuState.active + delta + count) % count;
    renderLangItems();
  }

  function chooseLangItem(index) {
    var state = langMenuState;
    if (!state || index < 0 || index >= state.items.length)
      return;
    var item = state.items[index];
    var el = state.el;
    closeLangMenu();
    if (!el || !el.isConnected)
      return;
    if ((el.dataset.lang || '') === item.value)
      return;
    // 与原来的改语言一致：更新 dataset.lang/围栏并重着色，再走同一条
    // 置脏与合并入撤销栈的路径。
    applyCodeLang(el, item.value);
    scheduleDirty();
    scheduleCommit();
  }

  function closeLangMenu() {
    var state = langMenuState;
    langMenuState = null;
    langComposing = false;
    removeMenu(langMenu);
    langMenu = null;
    if (state && state.badge)
      state.badge.setAttribute('aria-expanded', 'false');
  }

  function openLangMenu(el, badge) {
    // 再点同一个徽标：关闭
    if (langMenuState && langMenuState.el === el) {
      closeLangMenu();
      return;
    }
    closeSlash(false);
    closeTurnMenu();
    closeLangMenu();
    var items = langItems('');
    langMenuState = { el: el, badge: badge, items: items, active: 0 };
    var currentIndex = langCurrentIndex(items, el.dataset.lang);
    if (currentIndex >= 0)
      langMenuState.active = currentIndex;
    langMenu = document.createElement('div');
    langMenu.id = 'lang-menu';
    langMenu.innerHTML = '<input id="lang-search" type="text" placeholder="搜索语言…"'
      + ' autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="搜索语言">'
      + '<div class="lang-list" role="listbox"></div>';
    var input = langMenu.querySelector('#lang-search');
    input.addEventListener('input', function () {
      if (!langMenuState)
        return;
      langMenuState.items = langItems(input.value);
      langMenuState.active = 0;
      renderLangItems();
    });
    // 输入法组字期间 Enter/Esc/方向键属于输入法，不能抢。
    input.addEventListener('compositionstart', function () {
      langComposing = true;
    });
    input.addEventListener('compositionend', function () {
      langComposing = false;
      if (!langMenuState)
        return;
      langMenuState.items = langItems(input.value);
      langMenuState.active = 0;
      renderLangItems();
    });
    input.addEventListener('keydown', function (event) {
      if (langComposing || composing)
        return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        moveLangItem(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (langMenuState)
          chooseLangItem(langMenuState.active);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeLangMenu();
      }
    });
    langMenu.addEventListener('mousedown', function (event) {
      var hit = event.target.closest ? event.target.closest('.lang-item') : null;
      if (!hit)
        return;
      // preventDefault 保住搜索框焦点，选完再统一关闭
      event.preventDefault();
      chooseLangItem(Number(hit.getAttribute('data-index')));
    });
    renderLangItems();
    placeMenu(langMenu, badge.getBoundingClientRect());
    badge.setAttribute('aria-expanded', 'true');
    // 真实点击的 mouseup/click 可能把焦点交回页面；同步聚焦后再补一次，
    // 确保搜索框在整次点击结束后仍然拿到焦点。不用 focusout 关下拉：
    // 点击外部由 document 的 mousedown 负责，避免这里和焦点回落互相打架。
    var focusSearch = function () {
      if (!langMenu || !input.isConnected)
        return;
      try {
        input.focus({ preventScroll: true });
      } catch (error) {
        input.focus();
      }
    };
    focusSearch();
    setTimeout(focusSearch, 0);
  }

  // 页面滚动/窗口尺寸变化后徽标位置会变，直接关闭比追着重新定位更稳，
  // 也确保下拉不会停在离徽标很远的地方。
  window.addEventListener('resize', closeLangMenu);
  document.addEventListener('scroll', function (event) {
    // 候选列表自己的滚动不能把下拉关掉（方向键移动高亮时会滚列表）
    if (langMenu && event.target && langMenu.contains(event.target))
      return;
    closeLangMenu();
  }, true);

  function filteredSlashItems() {
    if (!slashState)
      return [];
    var raw = rawOf(slashState.el);
    var query = raw.slice(slashState.start + 1, Math.min(slashState.end, raw.length)).trim().toLowerCase();
    if (!query)
      return SLASH_ITEMS;
    return SLASH_ITEMS.filter(function (item) {
      return item.words.toLowerCase().indexOf(query) >= 0
        || item.label.toLowerCase().indexOf(query) >= 0;
    });
  }

  function renderSlashItems() {
    if (!slashMenu || !slashState)
      return;
    var list = filteredSlashItems();
    if (slashState.index >= list.length)
      slashState.index = Math.max(0, list.length - 1);
    var html = '';
    list.forEach(function (item, index) {
      html += '<div class="slash-item' + (index === slashState.index ? ' active' : '')
        + '" data-key="' + item.key + '"><span class="slash-label">' + escapeHtml(item.label)
        + '</span><span class="slash-hint">' + escapeHtml(item.hint) + '</span></div>';
    });
    if (!list.length)
      html = '<div class="slash-empty">没有匹配的命令</div>';
    slashMenu.innerHTML = html;
    var active = slashMenu.querySelector('.slash-item.active');
    if (active && active.scrollIntoView)
      active.scrollIntoView({ block: 'nearest' });
  }

  function openSlash(el, start) {
    closeTurnMenu();
    slashState = { el: el, start: start, end: start + 1, index: 0 };
    slashMenu = document.createElement('div');
    slashMenu.id = 'slash-menu';
    slashMenu.addEventListener('mousedown', function (event) {
      var hit = event.target.closest ? event.target.closest('.slash-item') : null;
      if (hit) {
        event.preventDefault();
        slashState.index = Array.prototype.indexOf.call(slashMenu.children, hit);
        insertSlashItem();
      }
    });
    renderSlashItems();
    placeMenu(slashMenu, caretClientRect());
  }

  function updateSlashFilter() {
    if (!slashState)
      return;
    renderSlashItems();
    if (slashMenu)
      placeMenu(slashMenu, caretClientRect());
  }

  function moveSlash(delta) {
    var list = filteredSlashItems();
    if (!slashState || !list.length)
      return;
    slashState.index = (slashState.index + delta + list.length) % list.length;
    renderSlashItems();
  }

  // 输入时维护「/ + 查询词」的范围；斜杠只在空行/行首触发。
  function handleSlashInput(el) {
    if (!el || el.classList.contains('table') || isCodeBlock(el))
      return;
    var raw = rawOf(el);
    var caret = caretOffset(el);
    if (!slashState) {
      if (raw.charAt(caret - 1) !== '/')
        return;
      var atLineStart = caret - 1 === 0 || raw.charAt(caret - 2) === '\n';
      if (!atLineStart)
        return;
      openSlash(el, caret - 1);
      slashState.end = caret;
      updateSlashFilter();
      return;
    }
    slashState.end = caret;
    if (raw.charAt(slashState.start) !== '/' || el !== slashState.el) {
      closeSlash(false);
      return;
    }
    updateSlashFilter();
  }

  function closeSlash(deleteToken) {
    var state = slashState;
    slashState = null;
    removeMenu(slashMenu);
    slashMenu = null;
    if (!deleteToken || !state)
      return;
    var el = state.el;
    if (!el || !el.isConnected)
      return;
    var raw = rawOf(el);
    if (raw.charAt(state.start) !== '/')
      return;
    var end = Math.min(state.end, raw.length);
    var next = raw.slice(0, state.start) + raw.slice(end);
    commitHistory();
    applyRawToBlock(el, next, state.start, state.start, true);
    setTimeout(commitHistory, 0);
  }

  function insertSlashItem() {
    if (!slashState)
      return;
    var list = filteredSlashItems();
    var item = list[slashState.index];
    if (!item)
      return;
    var el = slashState.el;
    var start = slashState.start;
    var end = Math.min(slashState.end, rawOf(el).length);
    var base = rawOf(el).slice(0, start) + rawOf(el).slice(end);
    closeSlash(false);
    commitHistory();
    var key = item.key;

    if (key === 'code') {
      var body = base.replace(/\n+$/, '');
      var codeRaw_ = '```\n' + body + '\n```';
      var codeCaret = 4 + body.length;
      applyRawToBlock(el, codeRaw_, codeCaret, codeCaret, true);
    } else if (key === 'table') {
      applyRawToBlock(el, TABLE_TEMPLATE, 2, 2, true);
    } else if (key === 'hr') {
      applyRawToBlock(el, '---', 3, 3, true);
      insertBlockAfter(el, '', 0);
    } else if (key === 'image') {
      var token = '图片路径';
      var imageRaw = base + '![](' + token + ')';
      applyRawToBlock(el, imageRaw, base.length + 4, base.length + 4 + token.length, true);
    } else if (key === 'link') {
      var linkRaw = base ? '[' + base + '](url)' : '[链接文字](url)';
      applyRawToBlock(el, linkRaw, base ? base.length + 3 : 1,
        base ? base.length + 6 : 5, true);
    } else if (key === 'inlineCode') {
      var inlineRaw = '`' + base + '`';
      applyRawToBlock(el, inlineRaw, base ? 1 + base.length : 1,
        base ? 1 + base.length : 1, true);
    } else {
      var type = { h1: 'h1', h2: 'h2', h3: 'h3', ul: 'ul', ol: 'ol', quote: 'quote' }[key];
      if (!type) {
        setTimeout(commitHistory, 0);
        return;
      }
      var converted = buildBlockRaw(type, base);
      var shift = leadLength(converted, kindOfRaw(converted)) - leadLength(base, kindOfRaw(base));
      applyRawToBlock(el, converted, Math.max(0, start + shift), Math.max(0, start + shift), true);
    }
    scheduleDirty();
    scheduleTocRefresh();
    setTimeout(commitHistory, 0);
  }

  /* ---------- 右键「转为」 ---------- */
  var TURN_ITEMS = [
    { key: 'paragraph', label: '正文' },
    { key: 'h1', label: '标题 1' },
    { key: 'h2', label: '标题 2' },
    { key: 'h3', label: '标题 3' },
    { key: 'ul', label: '无序列表' },
    { key: 'ol', label: '有序列表' },
    { key: 'quote', label: '引用' },
    { key: 'codeBlock', label: '代码块' }
  ];

  function closeTurnMenu() {
    removeMenu(turnMenu);
    turnMenu = null;
  }

  function openTurnMenu(x, y) {
    closeSlash(false);
    closeTurnMenu();
    var selection = window.getSelection();
    // 剪切/复制要有非空选区才可用；粘贴是否可用取决于系统剪贴板，页面没有读取
    // 权限，只能保持可用（剪贴板为空时原生侧本来就什么都不做）。
    var hasRange = !!(selection && selection.rangeCount && !selection.isCollapsed);
    turnMenu = document.createElement('div');
    turnMenu.id = 'turn-menu';
    var html = '';
    html += '<div class="turn-item' + (hasRange ? '' : ' is-disabled') + '" data-edit="cut">剪切</div>';
    html += '<div class="turn-item' + (hasRange ? '' : ' is-disabled') + '" data-edit="copy">复制</div>';
    html += '<div class="turn-item" data-edit="paste">粘贴</div>';
    html += '<div class="turn-sep"></div>';
    html += '<div class="turn-title">转为</div>';
    TURN_ITEMS.forEach(function (item) {
      html += '<div class="turn-item" data-key="' + item.key + '">' + escapeHtml(item.label) + '</div>';
    });
    turnMenu.innerHTML = html;
    turnMenu.addEventListener('mousedown', function (event) {
      var hit = event.target.closest ? event.target.closest('.turn-item') : null;
      if (!hit)
        return;
      // preventDefault 保住选区：菜单项在页面里，按下时不能挪掉光标/选区
      event.preventDefault();
      if (hit.classList.contains('is-disabled'))
        return;
      var command = hit.getAttribute('data-edit');
      closeTurnMenu();
      // 剪贴板三项交回宿主执行，与编辑菜单、快捷键完全同一条路径
      if (command)
        post({ type: 'editCommand', command: command });
      else
        formatAction(hit.getAttribute('data-key'));
    });
    placeMenu(turnMenu, { left: x, top: y, bottom: y, right: x });
  }

  // WebKit 在右键按下后、contextmenu 之前会把跨块选区折叠成光标，
  // 所以要在 mousedown 阶段先把整段选区存下来，供「转为」菜单使用。
  var lastRangeSelection = null;

  document.addEventListener('contextmenu', function (event) {
    if (mode === 'source')
      return;
    var el = blockOf(event.target);
    if (!el)
      return;
    event.preventDefault();
    var selection = window.getSelection();
    if (selection && selection.isCollapsed && lastRangeSelection
        && lastRangeSelection.intersectsNode(el)) {
      selection.removeAllRanges();
      selection.addRange(lastRangeSelection);
    }
    lastRangeSelection = null;
    // 多块选区右键时保留整段选区，否则「转为」只会作用于光标所在块。
    var rangeBlocks = selectedBlocks();
    var keepSelection = !!(selection && !selection.isCollapsed && rangeBlocks.length > 1
      && rangeBlocks.indexOf(el) >= 0);
    if (!keepSelection) {
      var host = selection && selection.rangeCount ? blockOf(selection.anchorNode) : null;
      if (host !== el) {
        el.classList.add('editing');
        el.focus();
        // 不能直接 setSelectionRange：表格末尾的偏移会落在尾部 | 标记之后，
        // 之后的输入就写到分隔符外面去了。placeBlockCaret 会带上
        // ensureCellCaret 把光标收回单元格可见文本里。
        placeBlockCaret(el, el.textContent.length);
      }
    }
    openTurnMenu(event.clientX, event.clientY);
  });

  document.addEventListener('mousedown', function (event) {
    var sel = window.getSelection();
    lastRangeSelection = (event.button === 2 && sel && !sel.isCollapsed && sel.rangeCount)
      ? sel.getRangeAt(0).cloneRange()
      : null;
    if (turnMenu && !turnMenu.contains(event.target))
      closeTurnMenu();
    if (slashMenu && !slashMenu.contains(event.target) && !blockOf(event.target))
      closeSlash(true);
    // 徽标自己的 mousedown 会先打开/切换下拉，这里不能把它当成「点外部」关掉
    if (langMenu && !langMenu.contains(event.target)
        && !(event.target.closest && event.target.closest('.code-lang')))
      closeLangMenu();
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape')
      return;
    // 组字期间 Esc 属于输入法（取消候选/整段上屏），浮层不能抢
    if (composing || langComposing)
      return;
    if (slashState) {
      event.preventDefault();
      closeSlash(true);
    } else if (turnMenu) {
      event.preventDefault();
      closeTurnMenu();
    } else if (langMenu) {
      event.preventDefault();
      closeLangMenu();
    }
  }, true);

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
      var gap = merged[p + 1].top - merged[p].bottom;
      // 空隙里切：离上一行墨迹 4px（盖住标点溢出），余量留给页首
      cuts.push(gap >= 4 ? merged[p].bottom + Math.min(gap / 2, 4)
                         : merged[p].bottom + 2);
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

  window.mote = {
    setTheme: setTheme,
    setStatus: setStatus,
    setMarkdown: function (text) {
      closeSlash(false);
      closeTurnMenu();
      closeLangMenu();
      var normalized = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');

      suppressEvents = true;
      if (mode === 'source') {
        sourceEl.value = normalized;
        trailingNewlines = trailingNewlineCount(normalized);
      } else {
        var layout = splitSourceLayout(normalized);
        mountBlocks(layout.blocks, layout.gaps, layout.trail);
      }
      suppressEvents = false;

      // 以规范化后的序列化结果为基准，避免尾部空行造成“一打开就是已修改”
      savedText = currentSource();

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

  applyZoom();
  if (INLINE_PROTO)
    document.body.classList.add('inline-proto');
  post({ type: 'ready' });
})();
