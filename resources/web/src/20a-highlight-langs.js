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
