#!/usr/bin/env node
/*
 * Mote 前端纯函数特征测试（P0）。
 *
 * 直接在 editor.js 的 IIFE 末尾注入一个只读测试挂钩，不修改产品文件；
 * DOM 用 Proxy 桩件兜住加载期的 applyZoom / 事件注册 / ready 消息。
 *
 * 运行（在仓库根）：
 *   node tools/editor/test_pure.js
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *     tools/editor/test_pure.js
 *
 * 没有 expect 的用例会自动用当前实现生成并写回 fixtures；有 expect 的用例
 * 必须逐字相等。Node 下可用 --update 强制重算全部用例。
 */
'use strict';

var IS_JSC = typeof readFile === 'function' && typeof print === 'function';
var fs = null;
if (!IS_JSC)
  fs = require('fs');

var argv = (!IS_JSC && typeof process !== 'undefined' && process.argv)
  ? process.argv.slice(2) : [];
var FORCE_UPDATE = argv.indexOf('--update') >= 0;
var FORCE_FROM_SRC = argv.indexOf('--from-src') >= 0;

var FIXTURES = 'tools/editor/fixtures/';
var BUNDLE = 'resources/web/editor.js';
var SRC_MANIFEST = 'resources/web/src/editor.manifest.json';

var SUITES = ['layout', 'blocks', 'tables', 'stats', 'inline', 'highlight', 'headings', 'builders'];

function readText(path) {
  if (IS_JSC)
    return readFile(path);
  return fs.readFileSync(path, 'utf8');
}

function writeText(path, text) {
  if (IS_JSC)
    writeFile(path, text);
  else
    fs.writeFileSync(path, text, 'utf8');
}

function exists(path) {
  if (IS_JSC) {
    try {
      readFile(path);
      return true;
    } catch (error) {
      return false;
    }
  }
  return fs.existsSync(path);
}

function out(line) {
  if (IS_JSC)
    print(line);
  else
    console.log(line);
}

function failLine(line) {
  if (IS_JSC)
    print(line);
  else
    console.error(line);
}

function finish(code) {
  if (IS_JSC)
    quit(code);
  else
    process.exitCode = code;
}

// 任意属性都返回自身的可调用 Proxy：只用于兜住加载期的 DOM 调用，
// 被测纯函数不依赖它。
function makeAny() {
  var callable = function () { return any; };
  var any = new Proxy(callable, {
    get: function (target, prop) {
      if (prop === Symbol.toPrimitive)
        return function () { return ''; };
      if (prop === 'toString')
        return function () { return ''; };
      if (prop === 'length')
        return 0;
      return any;
    },
    apply: function () { return any; },
    construct: function () { return any; }
  });
  return any;
}

function installDomStub() {
  var any = makeAny();
  globalThis.window = any;
  globalThis.document = any;
  globalThis.getComputedStyle = function () { return any; };
  globalThis.requestAnimationFrame = function () { return 0; };
  globalThis.cancelAnimationFrame = function () {};
}

function sourceText() {
  var useSrc = FORCE_FROM_SRC || exists(SRC_MANIFEST);
  if (!useSrc)
    return readText(BUNDLE);
  var manifest = JSON.parse(readText(SRC_MANIFEST));
  return (manifest.files || []).map(function (name) {
    return readText('resources/web/src/' + name);
  }).join('');
}

var HOOKS = [
  ['escapeHtml', 'Util.escapeHtml'],
  ['inlineHtml', 'Util.inlineHtml'],
  ['renderInline', 'Util.renderInline'],
  ['highlightCode', 'HighlightCache.highlightCode'],
  ['splitSourceLayout', 'LayoutCode.splitSourceLayout'],
  ['trailingNewlineCount', 'LayoutCode.trailingNewlineCount'],
  ['layoutText', 'DocumentModel.layoutText'],
  ['blockStartOffset', 'DocumentModel.blockStartOffset'],
  ['kindOfRaw', 'BlockParse.kindOfRaw'],
  ['contentOfRaw', 'BlockParse.contentOfRaw'],
  ['buildBlockRaw', 'BlockParse.buildBlockRaw'],
  ['convertRaw', 'BlockParse.convertRaw'],
  ['leadLength', 'BlockParse.leadLength'],
  ['splitTableLine', 'TableParse.splitTableLine'],
  ['tableCells', 'TableParse.tableCells'],
  ['tableAlignments', 'TableParse.tableAlignments'],
  ['isTableSource', 'TableParse.isTableSource'],
  ['plainTextOfRaw', 'DocumentModel.plainTextOfRaw'],
  ['countText', 'DocumentModel.countText'],
  ['plainLabel', 'Toc.plainLabel'],
  ['headingSlug', 'Toc.headingSlug']
];

function loadHooks() {
  var source = sourceText();
  var marker = '\n})();';
  var at = source.lastIndexOf(marker);
  if (at < 0)
    throw new Error('找不到 editor.js 的 IIFE 结尾，无法注入测试挂钩');
  var hook = '\n  globalThis.__MOTE_TEST__ = {' +
    HOOKS.map(function (item) { return item[0] + ': ' + item[1]; }).join(', ') +
    '};\n';
  installDomStub();
  globalThis.__MOTE_TEST__ = null;
  new Function(source.slice(0, at) + hook + source.slice(at))();
  var hooks = globalThis.__MOTE_TEST__;
  if (!hooks)
    throw new Error('测试挂钩注入失败');
  HOOKS.forEach(function (item) {
    if (typeof hooks[item[0]] !== 'function')
      throw new Error('测试挂钩缺少函数：' + item[0]);
  });
  return hooks;
}

function htmlToText(html) {
  // 只覆盖编辑器自己产生的实体：escapeHtml 只转义 & < > "。
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function canonical(value) {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(function (key) {
    return JSON.stringify(key) + ':' + canonical(value[key]);
  }).join(',') + '}';
}

function computeLayout(T, testCase) {
  var layout = T.splitSourceLayout(testCase.input);
  return {
    blocks: layout.blocks,
    gaps: layout.gaps,
    trail: layout.trail,
    roundtrip: T.layoutText(layout.blocks, layout.gaps, layout.trail),
    starts: layout.blocks.map(function (_, index) {
      return T.blockStartOffset(layout.blocks, layout.gaps, index);
    }),
    trailingNewlineCount: T.trailingNewlineCount(testCase.input)
  };
}

function computeBlocks(T, testCase) {
  var kind = T.kindOfRaw(testCase.raw);
  var content = T.contentOfRaw(testCase.raw, kind);
  var conversions = {};
  // 只覆盖右键「转为」与快捷键实际可达的目标类型。
  // hr / table 走 insertHrBlock / insertTableBlock，不经过 convertRaw；
  // hr 的 builder 边界由 builders 套件单独覆盖。
  ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code'].forEach(function (type) {
    conversions[type] = T.convertRaw(testCase.raw, type, false);
  });
  return {
    kind: kind,
    content: content,
    built: T.buildBlockRaw(kind, content),
    lead: T.leadLength(testCase.raw, kind),
    toggled: T.convertRaw(testCase.raw, kind, true),
    conversions: conversions
  };
}

function computeTables(T, testCase) {
  return {
    split: T.splitTableLine(testCase.line),
    cells: T.tableCells(testCase.line),
    alignments: T.tableAlignments(testCase.line),
    isTable: T.isTableSource([testCase.line, '| --- | --- |'])
  };
}

function computeStats(T, testCase) {
  var plain = T.plainTextOfRaw(testCase.raw);
  return {
    plain: plain,
    rawStats: T.countText(testCase.raw),
    plainStats: T.countText(plain)
  };
}

function computeInline(T, testCase) {
  var html = T.renderInline(testCase.input);
  return {
    html: html,
    inlineHtml: T.inlineHtml(testCase.input, 0),
    text: htmlToText(html),
    escaped: T.escapeHtml(testCase.input),
    sameEntry: html === T.inlineHtml(testCase.input, 0)
  };
}

function computeHighlight(T, testCase) {
  return { lines: T.highlightCode(null, testCase.raw, testCase.lang) };
}

function computeHeadings(T, testCase) {
  return {
    label: T.plainLabel(testCase.raw),
    slug: T.headingSlug(testCase.raw),
    escaped: T.escapeHtml(testCase.raw)
  };
}

// 直接覆盖 buildBlockRaw / convertRaw 的边界，尤其是 hr 不能误入标题分支。
function computeBuilders(T, testCase) {
  if (Object.prototype.hasOwnProperty.call(testCase, 'raw'))
    return { converted: T.convertRaw(testCase.raw, testCase.type, !!testCase.toggle) };
  return { built: T.buildBlockRaw(testCase.type, testCase.content) };
}

var COMPUTERS = {
  layout: computeLayout,
  blocks: computeBlocks,
  tables: computeTables,
  stats: computeStats,
  inline: computeInline,
  highlight: computeHighlight,
  headings: computeHeadings,
  builders: computeBuilders
};

function checkInvariants(suite, testCase, expect, failures) {
  if (suite === 'layout') {
    var normalized = testCase.input.replace(/\r\n?/g, '\n');
    if (expect.roundtrip !== normalized) {
      failures.push(suite + '/' + testCase.name + '：layoutText 无法逐字还原输入');
    }
  }
  if (suite === 'inline' && expect.text !== testCase.input) {
    failures.push(suite + '/' + testCase.name + '：行内渲染的 textContent 与原文不一致');
  }
  if (suite === 'headings') {
    if (/^-|-$/.test(expect.slug))
      failures.push(suite + '/' + testCase.name + '：slug 不应以 - 开头或结尾');
  }
}

function runSuite(T, suite, updateAll) {
  var path = FIXTURES + suite + '.json';
  var fixture = JSON.parse(readText(path));
  var cases = fixture.cases || [];
  var compute = COMPUTERS[suite];
  var failures = [];
  var updated = 0;
  var passed = 0;

  cases.forEach(function (testCase) {
    var actual;
    try {
      actual = compute(T, testCase);
    } catch (error) {
      failures.push(suite + '/' + testCase.name + '：执行异常 ' + error);
      return;
    }

    if (updateAll || !Object.prototype.hasOwnProperty.call(testCase, 'expect')) {
      testCase.expect = actual;
      updated++;
    } else if (canonical(testCase.expect) !== canonical(actual)) {
      failures.push(
        suite + '/' + testCase.name + '\n  期望: ' + canonical(testCase.expect) +
        '\n  实际: ' + canonical(actual)
      );
    } else {
      passed++;
    }

    if (testCase.invariant !== false)
      checkInvariants(suite, testCase, actual, failures);
  });

  if (updated) {
    fixture.cases = cases;
    writeText(path, JSON.stringify(fixture, null, 2) + '\n');
  }

  return { suite: suite, total: cases.length, passed: passed, updated: updated, failures: failures };
}

function main() {
  if (!exists(SRC_MANIFEST) && !exists(BUNDLE)) {
    failLine('找不到 editor.js 或 src 清单，请在仓库根执行');
    return finish(1);
  }

  var T;
  try {
    T = loadHooks();
  } catch (error) {
    failLine('加载 editor.js 失败：' + error);
    return finish(1);
  }

  var total = 0;
  var passed = 0;
  var updated = 0;
  var allFailures = [];

  SUITES.forEach(function (suite) {
    var result;
    try {
      result = runSuite(T, suite, FORCE_UPDATE);
    } catch (error) {
      allFailures.push(suite + '：读取/写入 fixture 失败 ' + error);
      return;
    }
    total += result.total;
    passed += result.passed;
    updated += result.updated;
    allFailures = allFailures.concat(result.failures);
    out(
      (result.failures.length ? 'FAIL ' : 'ok   ') + suite +
      '  ' + result.passed + '/' + result.total + ' 通过' +
      (result.updated ? '，' + result.updated + ' 条新生成' : '')
    );
  });

  out('');
  out('合计：' + passed + '/' + total + ' 通过，' + updated + ' 条新生成');
  if (allFailures.length) {
    out('');
    out('失败明细：');
    allFailures.forEach(function (line) { failLine('  - ' + line); });
    return finish(1);
  }
  return finish(0);
}

main();
