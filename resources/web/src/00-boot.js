(function () {
  'use strict';

  var root = document.getElementById('editor');
  var sourceEl = document.getElementById('source');
  var tocList = document.getElementById('toc-list');

  var mode = 'wysiwyg';         // 'wysiwyg' | 'source'
  var zoomLevel = 1;            // 1 = 100%，基准 16.5px（≈ 旧版 16.5pt）

  // 自建撤销栈：整篇快照（块数组或纯文本）+ 绝对字符选区。contenteditable 的
  // 原生撤销只在单块未被重建时有效，跨块操作（回车分块、退格合并、撤销后整篇
  // 重建）会失效，因此统一由这里接管 Cmd+Z / Cmd+Shift+Z。
  var history = [];
  var historyIndex = -1;
  var commitTimer = null;
  var suppressEvents = false;   // 程序化重建 DOM 期间屏蔽 input/focus 等事件
  var commitBatch = 0;          // >0 时合并中间渲染，多块转换只记一个撤销步

