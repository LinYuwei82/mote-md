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
  // 可见区外代码块延迟高亮（仅整篇载入路径启用）：首挂先渲染转义纯文本，
  // 首屏立即补、其余空闲分批补，把大文档打开时的整篇着色成本摊平。
  var deferredCode = null;
  var deferredCodeTimer = 0;
  // 页面加载后的第一次挂载：新页首布局已含滚动条高度，无需补偿。
  var pageFresh = true;
  // 目录项的文档纵坐标缓存：滚动高亮改二分查表，不再每次滚动对每个标题
  // 调 getBoundingClientRect（900 个标题时每帧 900 次布局读取）。
  var tocTops = null;
  // 标题集合的签名：正文段落增删不应导致目录整天重建。
  var tocSig = null;
  var spyScheduled = false;
