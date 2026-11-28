  var Config = (function configModule() {
  // 行内标记（阶段一）：默认开启——标记文本常驻 DOM、零宽折叠，进入某行不再
  // 整块替换成 Markdown 原文，因而不产生重排。MOTE_INLINE_PROTO=0/false/off
  // 时由 Qt 注入 false，回退到旧的「整块替换」行为，作为应急路径保留。
  var INLINE_PROTO = window.MOTE_INLINE_PROTO !== false;

  var ZOOM_MIN = 0.6;
  var ZOOM_MAX = 2.6;
  var ZOOM_STEP = 0.1;

  var COALESCE_MS = 600;        // 连续输入的合并窗口
  // 历史步数上限：整篇快照虽然只共享未改动块的字符串，但步数不封顶时块数组
  // 会随编辑时长无限堆积（4500 块 / 170KB 文档尤为明显），超出丢最旧的。
  var MAX_HISTORY = 100;

  return {
    INLINE_PROTO: INLINE_PROTO,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    ZOOM_STEP: ZOOM_STEP,
    COALESCE_MS: COALESCE_MS,
    MAX_HISTORY: MAX_HISTORY
  };
  })();
